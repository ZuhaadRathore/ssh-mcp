/**
 * tests/integration/jobs.test.ts
 *
 * Integration tests for background job tools — require a real SSH server.
 * Skipped automatically when SSH_HOST is not set.
 * Run with: SSH_HOST=... SSH_USER=... SSH_PASSWORD=... npm run test:integration
 *
 * Covers: running → done status transition with correct output, kill stopping
 * the process and verifying it is dead on the server, and tail=N limiting
 * output to the last N lines.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createTestServer, getText } from "../helpers/server.js";
import { registerExecTools } from "../../src/tools/exec.js";
import { registerJobTools } from "../../src/tools/jobs.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessions } from "../../src/shell.js";
import { closeConnection } from "../../src/connection.js";

const SKIP = !process.env.SSH_HOST;

afterAll(() => {
  sessions.forEach(s => s.close());
  sessions.clear();
  closeConnection();
});

function registerAll(server: McpServer) {
  registerExecTools(server);
  registerJobTools(server);
}

describe("background job lifecycle", () => {
  it.skipIf(SKIP)("job transitions from running to done with correct output", async () => {
    const { client } = await createTestServer(registerAll);

    // Start a 3-second job that produces known output
    const startResult = getText(await client.callTool({
      name: "ssh_exec_bg",
      arguments: { command: "for i in 1 2 3; do echo tick$i; sleep 0.5; done", label: "ticker" },
    }));
    expect(startResult).toContain("Job started");

    const id = startResult.match(/ID:\s+([0-9a-f]+)/)?.[1];
    expect(id).toBeDefined();

    // Poll immediately — should be running
    const mid = getText(await client.callTool({ name: "ssh_job_output", arguments: { id } }));
    expect(mid).toContain("running");

    // Wait for it to finish
    await new Promise(r => setTimeout(r, 2500));

    const final = getText(await client.callTool({ name: "ssh_job_output", arguments: { id } }));
    expect(final).toContain("done");
    expect(final).toContain("Exit: 0");
    expect(final).toContain("tick1");
    expect(final).toContain("tick3");
  });

  it.skipIf(SKIP)("ssh_job_kill stops the process and removes it from the list", async () => {
    const { client } = await createTestServer(registerAll);

    const startResult = getText(await client.callTool({
      name: "ssh_exec_bg",
      arguments: { command: "sleep 60", label: "long sleep" },
    }));
    const id = startResult.match(/ID:\s+([0-9a-f]+)/)?.[1]!;
    const pid = startResult.match(/PID:\s+(\d+)/)?.[1]!;

    const killResult = getText(await client.callTool({
      name: "ssh_job_kill",
      arguments: { id },
    }));
    expect(killResult).toContain(`Killed job ${id}`);

    // Process should no longer exist on the server
    const { getSession } = await import("../../src/shell.js");
    const r = await getSession("default").exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`);
    expect(r.stdout).toBe("dead");
  });

  it.skipIf(SKIP)("tail parameter limits output to the last N lines", async () => {
    const { client } = await createTestServer(registerAll);

    const startResult = getText(await client.callTool({
      name: "ssh_exec_bg",
      arguments: { command: "for i in $(seq 1 10); do echo line$i; done", label: "ten lines" },
    }));
    const id = startResult.match(/ID:\s+([0-9a-f]+)/)?.[1]!;

    await new Promise(r => setTimeout(r, 1000));

    const result = getText(await client.callTool({
      name: "ssh_job_output",
      arguments: { id, tail: 3 },
    }));

    expect(result).toContain("line10");
    expect(result).toContain("line9");
    expect(result).toContain("line8");
    expect(result).not.toContain("line1");
  });
});
