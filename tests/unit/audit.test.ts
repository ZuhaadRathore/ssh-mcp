import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createAuditLogger, hashCommand } from "../../src/audit.js";

const artifacts: string[] = [];

function makeTempFile(): string {
  const file = path.join(os.tmpdir(), `ssh-mcp-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  artifacts.push(file);
  return file;
}

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `ssh-mcp-audit-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  artifacts.push(dir);
  return dir;
}

function readJsonl(filePath: string): unknown[] {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean);
  return lines.map(line => JSON.parse(line));
}

afterEach(() => {
  for (const item of artifacts.splice(0)) {
    try {
      const stat = fs.statSync(item);
      if (stat.isDirectory()) fs.rmSync(item, { recursive: true, force: true });
      else fs.unlinkSync(item);
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("audit hashing", () => {
  it("hashCommand returns deterministic SHA-256 metadata", () => {
    const first = hashCommand("echo hello");
    const second = hashCommand("echo hello");
    expect(first).toEqual(second);
    expect(first.algorithm).toBe("sha256");
    expect(first.value).toMatch(/^[a-f0-9]{64}$/);
    expect(first.inputBytes).toBe(Buffer.byteLength("echo hello", "utf8"));
  });
});

describe("audit logger", () => {
  it("writes command events as JSONL with ids and command hash", () => {
    const file = makeTempFile();
    const logger = createAuditLogger({ filePath: file });

    const record = logger.logCommand({
      action: "exec",
      tool: "ssh_exec",
      command: "ls -la /tmp",
      success: true,
      exitCode: 0,
      timeoutMs: 60000,
      durationMs: 28,
      ids: {
        sessionId: "default",
        profileId: "prod-us",
        jobId: "job-1",
      },
      metadata: { requestId: "req-1" },
    });

    const rows = readJsonl(file) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(record as unknown as Record<string, unknown>);
    expect(rows[0]["category"]).toBe("command");

    const commandHash = rows[0]["commandHash"] as Record<string, unknown>;
    expect(commandHash["algorithm"]).toBe("sha256");
    expect(commandHash["value"]).toMatch(/^[a-f0-9]{64}$/);

    const ids = rows[0]["ids"] as Record<string, unknown>;
    expect(ids["sessionId"]).toBe("default");
    expect(ids["profileId"]).toBe("prod-us");
    expect(ids["jobId"]).toBe("job-1");
  });

  it("appends file events without rewriting previous lines", () => {
    const file = makeTempFile();
    const logger = createAuditLogger({ filePath: file });

    logger.logCommand({
      action: "exec",
      tool: "ssh_exec",
      command: "uname -a",
      success: true,
      ids: { sessionId: "default" },
    });

    const before = fs.readFileSync(file, "utf8");

    logger.logFile({
      action: "write",
      tool: "ssh_write_file",
      success: true,
      path: "/tmp/test.txt",
      bytes: 12,
      ids: { profileId: "staging" },
    });

    const after = fs.readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);

    const rows = readJsonl(file) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]["category"]).toBe("command");
    expect(rows[1]["category"]).toBe("file");
    expect(rows[1]["action"]).toBe("write");
    expect(rows[1]["path"]).toBe("/tmp/test.txt");
    expect(rows[1]["bytes"]).toBe(12);
  });

  it("supports failOpen=false for strict write failures", () => {
    const dir = makeTempDir();
    const strictLogger = createAuditLogger({ filePath: dir, failOpen: false });

    expect(() => {
      strictLogger.logCommand({
        action: "exec",
        tool: "ssh_exec",
        command: "id",
        success: true,
      });
    }).toThrow();
  });

  it("defaults to fail-open behavior for non-critical logging", () => {
    const dir = makeTempDir();
    const failOpenLogger = createAuditLogger({ filePath: dir });

    expect(() => {
      failOpenLogger.logFile({
        action: "read",
        tool: "ssh_read_file",
        success: false,
        path: "/etc/shadow",
      });
    }).not.toThrow();
  });
});
