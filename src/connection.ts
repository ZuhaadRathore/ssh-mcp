/**
 * connection.ts
 *
 * SSH connection singleton. At most one Client is open at a time; concurrent
 * callers queue behind a waiters array until the connection is ready.
 *
 * Other modules subscribe to connection-close events via onConnectionClose()
 * so they can invalidate their own state (shell sessions, SFTP session) when
 * the underlying SSH socket drops.
 */
import { Client } from "ssh2";
import { sshConfig } from "./config.js";

let client: Client | null = null;
let connecting = false;
const waiters: Array<(err: Error | null) => void> = [];
const closeHandlers: Array<() => void> = [];

/** Return the current Client instance, or null if not connected. */
export function getClient(): Client | null {
  return client;
}

/** Register a callback to run whenever the SSH connection drops. */
export function onConnectionClose(fn: () => void): void {
  closeHandlers.push(fn);
}

/**
 * Resolve with the active Client, connecting first if necessary.
 * Concurrent callers share the same connection attempt via the waiters queue.
 */
export function getConnection(): Promise<Client> {
  return new Promise((resolve, reject) => {
    if (client) { resolve(client); return; }
    waiters.push(err => err ? reject(err) : resolve(client!));
    if (connecting) return;
    connecting = true;

    const c = new Client();
    c.on("ready", () => {
      client = c;
      connecting = false;
      waiters.splice(0).forEach(cb => cb(null));
    })
    .on("error", err => {
      client = null;
      connecting = false;
      waiters.splice(0).forEach(cb => cb(err));
    })
    .on("close", () => {
      client = null;
      closeHandlers.forEach(fn => fn());
    })
    .connect(sshConfig);
  });
}

/** Close the SSH connection and clear the singleton. */
export function closeConnection(): void {
  try { client?.end(); } catch {}
  client = null;
}
