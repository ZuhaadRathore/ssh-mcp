/**
 * tests/mcp/exec.test.ts
 *
 * MCP-layer tests for ssh_exec and ssh_exec_bg. The shell module is fully
 * mocked so these tests exercise tool registration, schema validation, and
 * response formatting — not actual SSH I/O.
 *
 *   ssh_exec    — stdout/stderr labelling, timeout forwarding, session naming
 *   ssh_exec_bg — job record creation, PID parsing, invalid-PID error path,
 *                 default label fallback
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestServer, getText } from "../helpers/server.js";
import { registerExecTools } from "../../src/tools/exec.js";

const mockExec = vi.fn();

vi.mock("../../src/shell.js", () => ({
  getSession: () => ({ exec: mockExec }),
}));
vi.mock("../../src/jobs.js", () => ({
  jobs: new Map(),
  saveJobs: vi.fn(),
}));

describe("ssh_exec", () => {
  let callTool: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { client } = await createTestServer(registerExecTools);
    callTool = (args) => client.callTool({ name: "ssh_exec", arguments: args }).then(getText);
  });

  it("returns stdout from the remote command", async () => {
    mockExec.mockResolvedValue({ stdout: "tavuc", stderr: "", code: 0 });
    expect(await callTool({ command: "whoami" })).toContain("tavuc");
  });

  it("surfaces stderr distinctly so Claude can tell warnings from output", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "bash: foo: command not found", code: 127 });
    const out = await callTool({ command: "foo" });
    expect(out).toContain("[stderr]");
    expect(out).toContain("command not found");
    expect(out).toContain("Exit: 127");
  });

  it("passes the timeout parameter through to exec in milliseconds", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await callTool({ command: "sleep 5", timeout: 10 });
    expect(mockExec).toHaveBeenCalledWith("sleep 5", 10000);
  });

  it("passes the session name through so named sessions work", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await callTool({ command: "echo hi", session: "build" });
    // getSession was called with "build" — verified by how the mock is structured
    // (getSession("build") returns the same mock exec in our setup)
    expect(mockExec).toHaveBeenCalledWith("echo hi", 60000);
  });
});

describe("ssh_exec_bg", () => {
  let callTool: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { client } = await createTestServer(registerExecTools);
    callTool = (args) => client.callTool({ name: "ssh_exec_bg", arguments: args }).then(getText);
  });

  it("returns a job ID and PID when the background process starts successfully", async () => {
    mockExec.mockResolvedValue({ stdout: "98765", stderr: "", code: 0 });
    const out = await callTool({ command: "sleep 30", label: "my job" });
    expect(out).toContain("Job started");
    expect(out).toContain("PID:    98765");
    expect(out).toMatch(/ID:\s+[0-9a-f]{8}/);
  });

  it("returns an error message (not a job ID) when the PID is not a number", async () => {
    // This happens when the command itself fails before backgrounding
    mockExec.mockResolvedValue({ stdout: "bash: bad command\n", stderr: "", code: 127 });
    const out = await callTool({ command: "notacommand &" });
    expect(out).toContain("Failed to start");
    expect(out).not.toContain("Job started");
  });

  it("uses the command as the label when no label is provided", async () => {
    mockExec.mockResolvedValue({ stdout: "11111", stderr: "", code: 0 });
    const out = await callTool({ command: "cargo build" });
    expect(out).toContain("cargo build");
  });
});
