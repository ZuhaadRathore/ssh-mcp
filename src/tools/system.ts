/**
 * tools/system.ts
 *
 * MCP tools for observing the remote system's runtime state:
 *
 *   ssh_ps   — list running processes sorted by CPU; optional grep filter.
 *   ssh_df   — disk space usage (all filesystems or a specific path).
 *   ssh_env  — dump environment variables of a named session; optional filter.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSession } from "../shell.js";
import { fmt, q } from "../helpers.js";
import { logCommandAudit } from "../audit.js";
import { auditIds } from "../tool-context.js";
import { assertActiveCommandAllowed, policyFailureText } from "../runtime-policy.js";

/** Register ssh_ps, ssh_df, and ssh_env tools on the given MCP server. */
export function registerSystemTools(server: McpServer): void {
  server.tool(
    "ssh_ps",
    "List running processes sorted by CPU usage.",
    {
      filter: z.string().optional().describe("Only show processes matching this string"),
      limit: z.number().default(30),
    },
    async ({ filter, limit }) => {
      const cmd = filter
        ? `ps aux --sort=-%cpu | head -1; ps aux --sort=-%cpu | grep -v grep | grep ${q(filter)} | head -n ${limit}`
        : `ps aux --sort=-%cpu | head -n ${limit + 1}`;
      try {
        assertActiveCommandAllowed(cmd);
      } catch (err) {
        logCommandAudit({
          action: "ps",
          tool: "ssh_ps",
          command: cmd,
          success: false,
          timeoutMs: 10000,
          ids: auditIds("default"),
          metadata: { reason: "policy", filter, limit },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }
      const r = await getSession("default").exec(cmd, 10000);
      logCommandAudit({
        action: "ps",
        tool: "ssh_ps",
        command: cmd,
        success: r.code === 0,
        exitCode: r.code,
        timeoutMs: 10000,
        ids: auditIds("default"),
        metadata: { filter, limit },
      });
      return { content: [{ type: "text", text: r.stdout || fmt(r) }] };
    }
  );

  server.tool(
    "ssh_df",
    "Show disk space usage on the remote server.",
    {
      path: z.string().optional().describe("Specific path to check (default: all filesystems)"),
    },
    async ({ path }) => {
      const cmd = `df -h${path ? ` ${q(path)}` : ""}`;
      try {
        assertActiveCommandAllowed(cmd);
      } catch (err) {
        logCommandAudit({
          action: "df",
          tool: "ssh_df",
          command: cmd,
          success: false,
          timeoutMs: 10000,
          ids: auditIds("default"),
          metadata: { reason: "policy", path },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }
      const r = await getSession("default").exec(cmd, 10000);
      logCommandAudit({
        action: "df",
        tool: "ssh_df",
        command: cmd,
        success: r.code === 0,
        exitCode: r.code,
        timeoutMs: 10000,
        ids: auditIds("default"),
        metadata: { path },
      });
      return { content: [{ type: "text", text: r.stdout || fmt(r) }] };
    }
  );

  server.tool(
    "ssh_env",
    "Dump the environment variables of a shell session.",
    {
      session: z.string().default("default"),
      filter: z.string().optional().describe("Only show variables matching this pattern"),
    },
    async ({ session, filter }) => {
      const cmd = filter ? `env | grep ${q(filter)} | sort` : "env | sort";
      try {
        assertActiveCommandAllowed(cmd);
      } catch (err) {
        logCommandAudit({
          action: "env",
          tool: "ssh_env",
          command: cmd,
          success: false,
          timeoutMs: 10000,
          ids: auditIds(session),
          metadata: { reason: "policy", filter },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }
      const r = await getSession(session).exec(cmd, 10000);
      logCommandAudit({
        action: "env",
        tool: "ssh_env",
        command: cmd,
        success: r.code === 0,
        exitCode: r.code,
        timeoutMs: 10000,
        ids: auditIds(session),
        metadata: { filter },
      });
      return { content: [{ type: "text", text: r.stdout || fmt(r) }] };
    }
  );
}
