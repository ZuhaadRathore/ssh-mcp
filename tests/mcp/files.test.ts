/**
 * tests/mcp/files.test.ts
 *
 * MCP-layer tests for ssh_edit_file and ssh_read_file. SFTP and shell are
 * mocked so tests verify tool logic and response text — not SSH I/O.
 *
 *   ssh_edit_file  — uniqueness guard (not found, ambiguous match with byte
 *                    positions, exact replacement, replace_all, start/end of
 *                    file, multiline spans)
 *   ssh_read_file  — partial read header format, full-file line count
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestServer, getText } from "../helpers/server.js";
import { registerFileTools } from "../../src/tools/files.js";

// Mock the SFTP and shell modules — we're testing tool logic, not SSH
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });

vi.mock("../../src/sftp.js", () => ({
  getSftp: () => Promise.resolve({ readFile: mockReadFile, writeFile: mockWriteFile }),
}));
vi.mock("../../src/shell.js", () => ({
  getSession: () => ({ exec: mockExec }),
}));

function mockFileContent(content: string) {
  mockReadFile.mockImplementation((_path: string, cb: (e: null, b: Buffer) => void) => {
    cb(null, Buffer.from(content, "utf8"));
  });
  mockWriteFile.mockImplementation((_path: string, _data: Buffer, cb: (e: null) => void) => {
    cb(null);
  });
}

// ssh_edit_file's core guarantee: edits are safe because they require an exact,
// unambiguous match. These tests verify that guarantee holds.
describe("ssh_edit_file", () => {
  let callTool: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { client } = await createTestServer(registerFileTools);
    callTool = (args) =>
      client.callTool({ name: "ssh_edit_file", arguments: args }).then(getText);
  });

  it("replaces a uniquely occurring string and reports 1 occurrence", async () => {
    mockFileContent("hello world\ngoodbye world\n");
    const out = await callTool({ path: "/tmp/f.txt", old_string: "hello world", new_string: "hi world" });
    expect(out).toContain("replaced 1 occurrence");
  });

  it("writes the correctly edited content back via SFTP", async () => {
    mockFileContent("foo bar baz\n");
    await callTool({ path: "/tmp/f.txt", old_string: "bar", new_string: "BAR" });
    const written = (mockWriteFile.mock.calls[0] as [string, Buffer, unknown])[1].toString("utf8");
    expect(written).toBe("foo BAR baz\n");
  });

  it("fails with a clear message when old_string is not found", async () => {
    mockFileContent("hello world\n");
    const out = await callTool({ path: "/tmp/f.txt", old_string: "not in file", new_string: "x" });
    expect(out).toContain("not found");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("fails and reports both byte positions when old_string matches more than once", async () => {
    mockFileContent("foo foo foo\n");
    const out = await callTool({ path: "/tmp/f.txt", old_string: "foo", new_string: "bar" });
    expect(out).toContain("more than once");
    expect(out).toMatch(/byte \d+ and \d+/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("replaces all occurrences when replace_all is true", async () => {
    mockFileContent("a b a b a\n");
    const out = await callTool({ path: "/tmp/f.txt", old_string: "a", new_string: "X", replace_all: true });
    const written = (mockWriteFile.mock.calls[0] as [string, Buffer, unknown])[1].toString("utf8");
    expect(written).toBe("X b X b X\n");
    expect(out).toContain("3 occurrences");
  });

  it("correctly edits a match at the very start of the file", async () => {
    mockFileContent("START rest of file\n");
    await callTool({ path: "/tmp/f.txt", old_string: "START", new_string: "BEGIN" });
    const written = (mockWriteFile.mock.calls[0] as [string, Buffer, unknown])[1].toString("utf8");
    expect(written).toMatch(/^BEGIN/);
  });

  it("correctly edits a match at the very end of the file", async () => {
    mockFileContent("rest of file END");
    await callTool({ path: "/tmp/f.txt", old_string: "END", new_string: "FINISH" });
    const written = (mockWriteFile.mock.calls[0] as [string, Buffer, unknown])[1].toString("utf8");
    expect(written).toMatch(/FINISH$/);
  });

  it("handles old_string that spans multiple lines", async () => {
    mockFileContent("line one\nline two\nline three\n");
    await callTool({ path: "/tmp/f.txt", old_string: "line one\nline two", new_string: "REPLACED" });
    const written = (mockWriteFile.mock.calls[0] as [string, Buffer, unknown])[1].toString("utf8");
    expect(written).toBe("REPLACED\nline three\n");
  });
});

// ssh_read_file with offset/limit — the main value is reading large files
// page by page without pulling the whole thing over the wire.
describe("ssh_read_file — partial reads", () => {
  let callTool: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { client } = await createTestServer(registerFileTools);
    callTool = (args) =>
      client.callTool({ name: "ssh_read_file", arguments: args }).then(getText);
  });

  it("reports the correct line range in the header when offset and limit are given", async () => {
    // Mock the shell exec that runs wc -l + sed
    mockExec.mockResolvedValue({ stdout: "10\nline3\nline4\nline5\n", stderr: "", code: 0 });
    const out = await callTool({ path: "/tmp/f.txt", offset: 3, limit: 3 });
    expect(out).toContain("[Lines 3–5 of 10]");
  });

  it("reports total line count when reading the full file", async () => {
    mockReadFile.mockImplementation((_path: string, cb: (e: null, b: Buffer) => void) => {
      cb(null, Buffer.from("a\nb\nc\nd\ne\n", "utf8"));
    });
    const out = await callTool({ path: "/tmp/f.txt" });
    expect(out).toContain("[5 lines]");
  });
});
