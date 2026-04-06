/**
 * tests/integration/files.test.ts
 *
 * Integration tests for file tools — require a real SSH server.
 * Skipped automatically when SSH_HOST is not set.
 * Run with: SSH_HOST=... SSH_USER=... SSH_PASSWORD=... npm run test:integration
 *
 * Covers: write → edit → read round-trip, ambiguous edit rejection (file
 * unchanged), and partial reads returning the correct line range + header.
 * All test files are written to a unique /tmp directory per test run.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createTestServer, getText } from "../helpers/server.js";
import { registerFileTools } from "../../src/tools/files.js";
import { sessions } from "../../src/shell.js";
import { closeConnection } from "../../src/connection.js";
import { closeSftp } from "../../src/sftp.js";

const SKIP = !process.env.SSH_HOST;
const TEST_DIR = `/tmp/mcp-integration-${Date.now()}`;

afterAll(() => {
  sessions.forEach(s => s.close());
  sessions.clear();
  closeSftp();
  closeConnection();
});

describe("ssh_edit_file — real file round-trip", () => {
  it.skipIf(SKIP)("write → edit → read back produces the expected content", async () => {
    const { client } = await createTestServer(registerFileTools);
    const path = `${TEST_DIR}/edit-test.txt`;

    await client.callTool({
      name: "ssh_write_file",
      arguments: { path, content: "line one\nline two\nline three\n" },
    });

    await client.callTool({
      name: "ssh_edit_file",
      arguments: { path, old_string: "line two", new_string: "LINE TWO EDITED" },
    });

    const result = getText(await client.callTool({ name: "ssh_read_file", arguments: { path } }));
    expect(result).toContain("LINE TWO EDITED");
    expect(result).not.toContain("line two");
    expect(result).toContain("line one");
    expect(result).toContain("line three");
  });

  it.skipIf(SKIP)("edit is rejected and file is unchanged when old_string appears twice", async () => {
    const { client } = await createTestServer(registerFileTools);
    const path = `${TEST_DIR}/ambiguous.txt`;
    const original = "foo bar foo\n";

    await client.callTool({ name: "ssh_write_file", arguments: { path, content: original } });
    const editResult = getText(await client.callTool({
      name: "ssh_edit_file",
      arguments: { path, old_string: "foo", new_string: "baz" },
    }));

    expect(editResult).toContain("more than once");

    // File must be unchanged
    const readResult = getText(await client.callTool({ name: "ssh_read_file", arguments: { path } }));
    expect(readResult).toContain(original.trim());
  });
});

describe("ssh_read_file — partial reads", () => {
  it.skipIf(SKIP)("offset and limit return the correct slice with the right header", async () => {
    const { client } = await createTestServer(registerFileTools);
    const path = `${TEST_DIR}/paginated.txt`;
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

    await client.callTool({ name: "ssh_write_file", arguments: { path, content: lines } });

    const result = getText(await client.callTool({
      name: "ssh_read_file",
      arguments: { path, offset: 5, limit: 5 },
    }));

    expect(result).toContain("[Lines 5–9 of 20]");
    expect(result).toContain("line 5");
    expect(result).toContain("line 9");
    expect(result).not.toContain("line 4");
    expect(result).not.toContain("line 10");
  });
});
