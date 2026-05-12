/**
 * tests/mcp/privileged.test.ts
 *
 * MCP-layer tests for ssh_exec_sudo token-guarded privileged execution.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createTestServer, getText } from "../helpers/server.js";
import {
  __getPrivilegedPendingCountForTests,
  __resetPrivilegedStateForTests,
  registerPrivilegedTools,
} from "../../src/tools/privileged.js";

const mockExec = vi.fn();

vi.mock("../../src/shell.js", () => ({
  getSession: () => ({ exec: mockExec }),
}));

function extractToken(text: string): string {
  const match = text.match(/Token:\s*([0-9a-f]+)/i);
  if (!match) throw new Error(`Could not find token in output:\n${text}`);
  return match[1];
}

describe("ssh_exec_sudo", () => {
  let callTool: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetPrivilegedStateForTests();
    const { client } = await createTestServer(registerPrivilegedTools);
    callTool = (args) => client.callTool({ name: "ssh_exec_sudo", arguments: args }).then(getText);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a confirmation token and does not execute on first call", async () => {
    const out = await callTool({ command: "id -u" });
    expect(out).toContain("Confirmation required");
    expect(extractToken(out)).toMatch(/^[0-9a-f]+$/);
    expect(mockExec).not.toHaveBeenCalled();
    expect(__getPrivilegedPendingCountForTests()).toBe(1);
  });

  it("executes only when called again with the matching confirmation token", async () => {
    mockExec.mockResolvedValue({ stdout: "0", stderr: "", code: 0 });
    const request = await callTool({ command: "id -u" });
    const token = extractToken(request);

    const out = await callTool({ command: "id -u", confirm_token: token });
    expect(mockExec).toHaveBeenCalledWith("sudo -n -- sh -lc 'id -u'", 60000);
    expect(out).toContain("0");
    expect(out).toContain("Exit: 0");
    expect(__getPrivilegedPendingCountForTests()).toBe(0);
  });

  it("forwards timeout in seconds as milliseconds", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const request = await callTool({ command: "apt update", timeout: 15 });
    const token = extractToken(request);

    await callTool({ command: "apt update", timeout: 15, confirm_token: token });
    expect(mockExec).toHaveBeenCalledWith("sudo -n -- sh -lc 'apt update'", 15000);
  });

  it("rejects confirmation token reuse with mismatched arguments", async () => {
    const request = await callTool({ command: "whoami", session: "admin", timeout: 5 });
    const token = extractToken(request);

    const out = await callTool({ command: "uname -a", session: "admin", timeout: 5, confirm_token: token });
    expect(out).toContain("does not match");
    expect(mockExec).not.toHaveBeenCalled();
    expect(__getPrivilegedPendingCountForTests()).toBe(1);
  });

  it("rejects expired confirmation tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const request = await callTool({ command: "id" });
    const token = extractToken(request);

    vi.advanceTimersByTime(120001);
    const out = await callTool({ command: "id", confirm_token: token });
    expect(out).toContain("expired");
    expect(mockExec).not.toHaveBeenCalled();
    expect(__getPrivilegedPendingCountForTests()).toBe(0);
  });

  it("rejects unknown confirmation tokens", async () => {
    const out = await callTool({ command: "id", confirm_token: "deadbeef" });
    expect(out).toContain("Invalid or expired");
    expect(mockExec).not.toHaveBeenCalled();
  });
});
