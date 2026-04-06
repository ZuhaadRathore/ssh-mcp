/**
 * tests/integration/shell.test.ts
 *
 * Integration tests for ShellSession — require a real SSH server.
 * Skipped automatically when SSH_HOST is not set.
 * Run with: SSH_HOST=... SSH_USER=... SSH_PASSWORD=... npm run test:integration
 *
 * Covers: cd persistence, env var persistence, non-zero exit codes, automatic
 * session recovery after the shell process dies, independent named sessions,
 * and in-order execution of concurrently queued commands.
 */
import { describe, it, expect, afterAll } from "vitest";
import { getSession, sessions } from "../../src/shell.js";
import { closeConnection } from "../../src/connection.js";

const SKIP = !process.env.SSH_HOST;

afterAll(() => {
  sessions.forEach(s => s.close());
  sessions.clear();
  closeConnection();
});

describe("persistent shell session", () => {
  it.skipIf(SKIP)("cd in one call is visible in the next call", async () => {
    const s = getSession("integration-test");
    await s.exec("cd /tmp");
    const r = await s.exec("pwd");
    expect(r.stdout).toBe("/tmp");
    expect(r.code).toBe(0);
  });

  it.skipIf(SKIP)("exported variable survives across calls", async () => {
    const s = getSession("integration-test");
    await s.exec("export MCP_TEST_VAR=hello123");
    const r = await s.exec("echo $MCP_TEST_VAR");
    expect(r.stdout).toBe("hello123");
  });

  it.skipIf(SKIP)("exit code is correctly captured for a failing command", async () => {
    const s = getSession("integration-test");
    const r = await s.exec("exit 42");

    // After `exit`, the shell dies — we expect the session to report the failure
    // and then recover on the next call
    expect(r.code).not.toBe(0);
  });

  it.skipIf(SKIP)("recovers automatically after the shell dies", async () => {
    const s = getSession("integration-recovery");
    // Kill the shell deliberately
    await s.exec("kill $$").catch(() => {});

    // Next call should reconnect and work
    const r = await s.exec("echo recovered");
    expect(r.stdout).toBe("recovered");
    expect(r.code).toBe(0);
  });

  it.skipIf(SKIP)("two named sessions are independent — cd in one does not affect the other", async () => {
    const a = getSession("session-a");
    const b = getSession("session-b");
    await a.exec("cd /tmp");
    await b.exec("cd /var");
    const [ra, rb] = await Promise.all([a.exec("pwd"), b.exec("pwd")]);
    expect(ra.stdout).toBe("/tmp");
    expect(rb.stdout).toBe("/var");
  });

  it.skipIf(SKIP)("queued commands execute in order without interleaving", async () => {
    const s = getSession("integration-queue");
    // Fire 5 commands without awaiting — they should queue and complete in order
    const results = await Promise.all([
      s.exec("echo 1"),
      s.exec("echo 2"),
      s.exec("echo 3"),
      s.exec("echo 4"),
      s.exec("echo 5"),
    ]);
    expect(results.map(r => r.stdout)).toEqual(["1", "2", "3", "4", "5"]);
  });
});
