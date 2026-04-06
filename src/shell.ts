/**
 * shell.ts
 *
 * Persistent, stateful shell sessions over SSH. Each ShellSession opens a
 * single no-PTY shell (client.shell(false, ...)) and keeps it alive for the
 * duration of the connection. Commands are serialized through an internal
 * queue so concurrent callers never interleave output.
 *
 * Output demarcation: after each command the shell writes a unique hex-token
 * marker line ("__MCPEXIT_<token>_<code>"). parseMarkerOutput() scans the raw
 * byte stream for this marker and extracts stdout + exit code, making it the
 * single point of failure for correctness — it is exported and unit-tested
 * independently.
 *
 * Sessions are invalidated (not destroyed) on connection drop so the queue
 * drains gracefully and callers get a -1 exit code instead of hanging.
 */
import type { ClientChannel } from "ssh2";
import { randomBytes } from "crypto";
import { getConnection, onConnectionClose } from "./connection.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

class ShellSession {
  readonly name: string;
  private stream: ClientChannel | null = null;
  private ready = false;
  private opening: Promise<void> | null = null;

  private outBuf = "";
  private errBuf = "";
  private activeMark = "";
  private activeResolve: ((r: ShellResult) => void) | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;

  private busy = false;
  private readonly queue: Array<() => Promise<void>> = [];

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Mark this session as dead. Immediately resolves any in-flight command with
   * code -1 so callers are not left hanging, then drains any queued commands
   * (which will re-open the shell against the new connection).
   */
  invalidate(): void {
    this.stream = null;
    this.ready = false;
    this.opening = null;
    if (this.activeResolve) {
      const resolve = this.activeResolve;
      this.activeResolve = null;
      this.activeMark = "";
      if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
      this.busy = false;
      resolve({ stdout: this.outBuf.trim(), stderr: this.errBuf.trim(), code: -1 });
      this.outBuf = "";
      this.errBuf = "";
      this.drain();
    }
  }

  /** Pull the next task off the queue and run it, if the session is idle. */
  private drain(): void {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    this.queue.shift()!();
  }

  /** Accumulate incoming stream data and resolve the active command when its marker is seen. */
  private onData(text: string, isStderr = false): void {
    if (isStderr) { this.errBuf += text; return; }
    this.outBuf += text;

    if (!this.ready) {
      if (this.outBuf.includes("__MCPSHELLREADY__")) {
        this.ready = true;
        this.outBuf = "";
        this.errBuf = "";
      }
      return;
    }

    if (!this.activeMark || !this.activeResolve) return;

    const parsed = parseMarkerOutput(this.outBuf, this.activeMark);
    if (!parsed) return;

    this.outBuf = parsed.remaining;
    this.errBuf = "";
    this.activeMark = "";

    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    const resolve = this.activeResolve;
    this.activeResolve = null;
    this.busy = false;
    resolve({ stdout: parsed.stdout, stderr: this.errBuf.trim(), code: parsed.code });
    this.drain();
  }

  /**
   * Open a no-PTY shell channel and wait for the __MCPSHELLREADY__ sentinel.
   * Concurrent callers share the same in-flight open promise.
   */
  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = getConnection().then(client => new Promise<void>((resolve, reject) => {
      client.shell(false, (err, stream) => {
        if (err) return reject(err);
        this.stream = stream;
        this.ready = false;
        this.outBuf = "";
        this.errBuf = "";

        stream.on("data", (d: Buffer) => this.onData(d.toString()));
        (stream as any).stderr?.on("data", (d: Buffer) => this.onData(d.toString(), true));
        stream.on("close", () => this.invalidate());

        const timer = setTimeout(() => reject(new Error(`Shell init timeout (${this.name})`)), 15000);
        const check = setInterval(() => {
          if (this.ready) { clearInterval(check); clearTimeout(timer); resolve(); }
        }, 50);

        stream.write("echo '__MCPSHELLREADY__'\n");
      });
    })).finally(() => { this.opening = null; });
    return this.opening;
  }

  /** Ensure the shell is open and ready, opening it if necessary. */
  private async ensure(): Promise<void> {
    if (this.stream && this.ready) return;
    await this.open();
  }

  /**
   * Queue a command for execution. Returns a promise that resolves with stdout,
   * stderr, and exit code once the command's marker is seen or the timeout fires.
   */
  exec(command: string, timeoutMs = 60000): Promise<ShellResult> {
    return new Promise(resolve => {
      const task = async () => {
        try {
          await this.ensure();
        } catch (err: unknown) {
          this.busy = false;
          resolve({ stdout: "", stderr: err instanceof Error ? err.message : String(err), code: -1 });
          this.drain();
          return;
        }
        const token = randomBytes(6).toString("hex");
        this.activeMark = token;
        this.outBuf = "";
        this.errBuf = "";
        this.activeResolve = resolve;
        this.activeTimer = setTimeout(() => {
          this.activeMark = "";
          this.activeResolve = null;
          this.busy = false;
          resolve({ stdout: `[Timed out after ${timeoutMs / 1000}s]`, stderr: "", code: 124 });
          this.drain();
        }, timeoutMs);
        this.stream!.write(`${command}\necho "__MCPEXIT_${token}_$?"\n`);
      };
      this.queue.push(task);
      this.drain();
    });
  }

  /** Close the shell stream and invalidate the session. */
  close(): void {
    try { this.stream?.end(); } catch {}
    this.invalidate();
  }
}

export interface ParsedMarkerOutput {
  stdout: string;
  code: number;
  remaining: string; // buffer content after the consumed marker line
}

/**
 * Scans `buf` for the exit marker written after each command.
 * Returns null if the marker (or its trailing newline) isn't in the buffer yet.
 */
export function parseMarkerOutput(buf: string, token: string): ParsedMarkerOutput | null {
  const prefix = `__MCPEXIT_${token}_`;
  const idx = buf.indexOf(prefix);
  if (idx === -1) return null;

  const after = buf.substring(idx + prefix.length);
  const nl = after.indexOf("\n");
  if (nl === -1) return null; // marker present but line not complete yet

  const parsed = parseInt(after.substring(0, nl).trim(), 10);
  return {
    stdout: buf.substring(0, idx).trim(),
    code: isNaN(parsed) ? -1 : parsed,
    remaining: after.substring(nl + 1),
  };
}

export const sessions = new Map<string, ShellSession>();

/** Return the named ShellSession, creating it if it does not exist yet. */
export function getSession(name = "default"): ShellSession {
  if (!sessions.has(name)) sessions.set(name, new ShellSession(name));
  return sessions.get(name)!;
}

// Invalidate all sessions when the SSH connection drops
onConnectionClose(() => sessions.forEach(s => s.invalidate()));
