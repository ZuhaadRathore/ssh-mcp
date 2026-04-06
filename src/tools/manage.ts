/**
 * tools/manage.ts
 *
 * MCP tools for inspecting and controlling the MCP server's own connection state:
 *
 *   ssh_status     — report SSH/SFTP connectivity, active sessions, and the cwd
 *                    + logged-in user of each open shell session.
 *   ssh_reconnect  — gracefully tear down and re-establish either a single named
 *                    session or the entire SSH connection (including SFTP).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sshConfig } from "../config.js";
import { getClient, getConnection, closeConnection } from "../connection.js";
import { getSession, sessions } from "../shell.js";
import { getSftpSession, closeSftp } from "../sftp.js";

/** Register ssh_status and ssh_reconnect tools on the given MCP server. */
export function registerManageTools(server: McpServer): void {
  server.tool(
    "ssh_status",
    "Show connection state, active sessions, and current working directory of each shell.",
    {},
    async () => {
      const lines = [
        `Host:     ${sshConfig.host}:${sshConfig.port ?? 22}`,
        `User:     ${sshConfig.username}`,
        `SSH:      ${getClient() ? "connected" : "disconnected"}`,
        `SFTP:     ${getSftpSession() ? "open" : "not open"}`,
        `Sessions: ${sessions.size > 0 ? [...sessions.keys()].join(", ") : "none"}`,
      ];
      for (const [name, session] of sessions) {
        const r = await session.exec(`echo "$(pwd) | $(whoami)@$(hostname)"`, 5000);
        lines.push(`  [${name}] ${r.stdout}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ssh_reconnect",
    "Drop and re-establish the SSH connection, all sessions, and SFTP.",
    {
      session: z.string().optional().describe("Reconnect only this named session (omit to reconnect everything)"),
    },
    async ({ session }) => {
      if (session) {
        sessions.get(session)?.close();
        sessions.delete(session);
        await getSession(session).exec("echo ok", 10000);
        return { content: [{ type: "text", text: `Session '${session}' reconnected.` }] };
      }
      sessions.forEach(s => s.close());
      sessions.clear();
      closeSftp();
      closeConnection();
      await getConnection();
      return { content: [{ type: "text", text: "Fully reconnected." }] };
    }
  );
}
