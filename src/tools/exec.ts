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
import { logCommandAudit } from "../audit.js";
import { auditIds } from "../tool-context.js";
import { assertActiveCommandAllowed, policyFailureText } from "../runtime-policy.js";

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
      const started = Date.now();
      const timeoutMs = (timeout ?? 60) * 1000;
      try {
        assertActiveCommandAllowed(command);
      } catch (err) {
        logCommandAudit({
          action: "exec",
          tool: "ssh_exec",
          command,
          success: false,
          timeoutMs,
          durationMs: Date.now() - started,
          ids: auditIds(session),
          metadata: { reason: "policy" },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const r = await getSession(session).exec(command, (timeout ?? 60) * 1000);
      logCommandAudit({
        action: "exec",
        tool: "ssh_exec",
        command,
        success: r.code === 0,
        exitCode: r.code,
        timeoutMs,
        durationMs: Date.now() - started,
        ids: auditIds(session),
      });
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
      const started = Date.now();
      try {
        assertActiveCommandAllowed(command);
      } catch (err) {
        logCommandAudit({
          action: "exec_bg_start",
          tool: "ssh_exec_bg",
          command,
          success: false,
          timeoutMs: 10000,
          durationMs: Date.now() - started,
          ids: auditIds("default"),
          metadata: { reason: "policy" },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const id = randomBytes(4).toString("hex");
      const outFile = `/tmp/.mcpjob_${id}.out`;
      const exitFile = `/tmp/.mcpjob_${id}.exit`;
      const wrapped = `{ ${command}; echo $? > ${q(exitFile)}; } > ${q(outFile)} 2>&1 & echo $!`;
      const r = await getSession("default").exec(wrapped, 10000);
      const pid = parseInt(r.stdout.trim(), 10);
      if (isNaN(pid)) {
        logCommandAudit({
          action: "exec_bg_start",
          tool: "ssh_exec_bg",
          command,
          success: false,
          exitCode: r.code,
          timeoutMs: 10000,
          durationMs: Date.now() - started,
          ids: auditIds("default", id),
          metadata: { label: label ?? command },
        });
        return { content: [{ type: "text", text: `Failed to start job:\n${fmt(r)}` }] };
      }
      jobs.set(id, { id, pid, command, label: label ?? command, outFile, exitFile, startedAt: new Date().toISOString() });
      saveJobs();
      logCommandAudit({
        action: "exec_bg_start",
        tool: "ssh_exec_bg",
        command,
        success: true,
        exitCode: r.code,
        timeoutMs: 10000,
        durationMs: Date.now() - started,
        ids: auditIds("default", id),
        metadata: { label: label ?? command, pid, outFile, exitFile },
      });
      return { content: [{ type: "text", text: `Job started\nID:     ${id}\nPID:    ${pid}\nLabel:  ${label ?? command}\nOutput: ${outFile}` }] };
    }
  );
}

/** Shell-safe single-quote a string. */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
