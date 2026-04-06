/**
 * tools/jobs.ts
 *
 * MCP tools for managing background jobs started with ssh_exec_bg:
 *
 *   ssh_job_output  — poll a job's current output and status (running / done + exit code);
 *                     supports tail=N to limit output to the last N lines.
 *   ssh_job_list    — summarise all tracked jobs with their live status.
 *   ssh_job_kill    — send SIGTERM (or SIGKILL with force:true) to a running job and
 *                     remove it from the registry.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSession } from "../shell.js";
import { jobs, saveJobs } from "../jobs.js";
import { fmt, q } from "../helpers.js";

/** Register ssh_job_output, ssh_job_list, and ssh_job_kill tools on the given MCP server. */
export function registerJobTools(server: McpServer): void {
  server.tool(
    "ssh_job_output",
    "Get current output and status of a background job.",
    {
      id: z.string().describe("Job ID from ssh_exec_bg"),
      tail: z.number().optional().describe("Only show last N lines (default: all)"),
    },
    async ({ id, tail }) => {
      const job = jobs.get(id);
      if (!job) return { content: [{ type: "text", text: `Unknown job ID: ${id}` }] };

      const outCmd = tail ? `tail -n ${tail} ${q(job.outFile)} 2>/dev/null` : `cat ${q(job.outFile)} 2>/dev/null`;
      const checkCmd = [
        `if kill -0 ${job.pid} 2>/dev/null; then echo STATUS:running`,
        `elif [ -f ${q(job.exitFile)} ]; then echo "STATUS:done EXIT:$(cat ${q(job.exitFile)})"`,
        `else echo STATUS:done; fi`,
        `echo '---'`,
        outCmd,
      ].join("; ");

      const r = await getSession("default").exec(checkCmd, 15000);
      const statusLine = r.stdout.match(/STATUS:(\S+)/)?.[1] ?? "unknown";
      const exitCode = r.stdout.match(/EXIT:(\S+)/)?.[1] ?? "";
      const sep = r.stdout.indexOf("---\n");
      const output = sep !== -1 ? r.stdout.substring(sep + 4) : "";

      const header = [
        `Job:    ${job.label}`,
        `ID:     ${id}  PID: ${job.pid}`,
        `Status: ${statusLine}${exitCode ? `  Exit: ${exitCode}` : ""}`,
        `Since:  ${job.startedAt}`,
        "",
      ].join("\n");

      return { content: [{ type: "text", text: header + (output.trim() || "(no output yet)") }] };
    }
  );

  server.tool(
    "ssh_job_list",
    "List all tracked background jobs and their current status.",
    {},
    async () => {
      if (jobs.size === 0) return { content: [{ type: "text", text: "No background jobs." }] };
      const session = getSession("default");
      const lines: string[] = [];
      for (const job of jobs.values()) {
        // Unambiguous status check: running > has exit file > unknown
        const r = await session.exec(
          `if kill -0 ${job.pid} 2>/dev/null; then echo running; elif [ -f ${q(job.exitFile)} ]; then echo "done($(cat ${q(job.exitFile)}))"; else echo unknown; fi`,
          5000
        );
        lines.push(`[${job.id}] PID:${job.pid}  ${r.stdout.trim().padEnd(10)}  ${job.label}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ssh_job_kill",
    "Kill a running background job.",
    {
      id: z.string(),
      force: z.boolean().default(false).describe("Use SIGKILL (-9) instead of SIGTERM"),
    },
    async ({ id, force }) => {
      const job = jobs.get(id);
      if (!job) return { content: [{ type: "text", text: `Unknown job ID: ${id}` }] };
      const r = await getSession("default").exec(`kill ${force ? "-9" : "-15"} ${job.pid} 2>&1`, 5000);
      jobs.delete(id);
      saveJobs();
      return { content: [{ type: "text", text: r.code === 0 ? `Killed job ${id} (PID ${job.pid})` : fmt(r) }] };
    }
  );
}
