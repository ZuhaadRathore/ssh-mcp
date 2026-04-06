/**
 * tools/exec.ts
 *
 * MCP tools for running commands on the remote server:
 *
 *   ssh_exec     — run a command in a named, persistent shell session; returns
 *                  stdout, labelled stderr, and exit code.
 *   ssh_exec_bg  — start a long-running command in the background using shell
 *                  job control; output is redirected to a temp file and a job
 *                  record is created for later polling with ssh_job_output.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "crypto";
import { z } from "zod";
import { getSession } from "../shell.js";
import { jobs, saveJobs } from "../jobs.js";
import { fmt } from "../helpers.js";

/** Register ssh_exec and ssh_exec_bg tools on the given MCP server. */
export function registerExecTools(server: McpServer): void {
  server.tool(
    "ssh_exec",
    "Run a command on the remote server. Shell state persists within a session (cd, exports, venvs, etc).",
    {
      command: z.string(),
      session: z.string().default("default").describe("Named shell session — use multiple for parallel contexts"),
      timeout: z.number().optional().describe("Timeout in seconds (default: 60)"),
    },
    async ({ command, session, timeout }) => {
      const r = await getSession(session).exec(command, (timeout ?? 60) * 1000);
      return { content: [{ type: "text", text: fmt(r) }] };
    }
  );

  server.tool(
    "ssh_exec_bg",
    "Start a long-running command in the background. Returns a job ID immediately — poll with ssh_job_output.",
    {
      command: z.string(),
      label: z.string().optional().describe("Human-readable label for this job"),
    },
    async ({ command, label }) => {
      const id = randomBytes(4).toString("hex");
      const outFile = `/tmp/.mcpjob_${id}.out`;
      const exitFile = `/tmp/.mcpjob_${id}.exit`;
      const wrapped = `{ ${command}; echo $? > ${q(exitFile)}; } > ${q(outFile)} 2>&1 & echo $!`;
      const r = await getSession("default").exec(wrapped, 10000);
      const pid = parseInt(r.stdout.trim(), 10);
      if (isNaN(pid)) {
        return { content: [{ type: "text", text: `Failed to start job:\n${fmt(r)}` }] };
      }
      jobs.set(id, { id, pid, command, label: label ?? command, outFile, exitFile, startedAt: new Date().toISOString() });
      saveJobs();
      return { content: [{ type: "text", text: `Job started\nID:     ${id}\nPID:    ${pid}\nLabel:  ${label ?? command}\nOutput: ${outFile}` }] };
    }
  );
}

/** Shell-safe single-quote a string. */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
