/**
 * tools/manage.ts
 *
 * MCP tools for inspecting and controlling the MCP server's own connection state:
 *
 *   ssh_status     — report SSH/SFTP connectivity, active sessions, and the cwd
 *                    + logged-in user of each open shell session.
 *   ssh_reconnect  — gracefully tear down and re-establish either a single named
 *                    session or the entire SSH connection (including SFTP).
 *   ssh_server_*   — list/add/use/remove server profiles persisted on disk.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addServerProfile,
  getActiveServerName,
  getActiveServerProfile,
  getServersFilePath,
  listServerProfiles,
  removeServerProfile,
  useServerProfile,
} from "../config.js";
import { getClient, getConnection, closeConnection } from "../connection.js";
import { getSession, sessions } from "../shell.js";
import { getSftpSession, closeSftp } from "../sftp.js";

async function reconnectAll(): Promise<void> {
  sessions.forEach(s => s.close());
  sessions.clear();
  closeSftp();
  closeConnection();
  await getConnection();
}

/** Register ssh_status and ssh_reconnect tools on the given MCP server. */
export function registerManageTools(server: McpServer): void {
  server.tool(
    "ssh_status",
    "Show connection state, active sessions, and current working directory of each shell.",
    {},
    async () => {
      let activeSummary = "none";
      try {
        const active = getActiveServerProfile();
        activeSummary = `${active.name} (${active.username}@${active.host}:${active.port})`;
      } catch {}

      const lines = [
        `Active:   ${activeSummary}`,
        `Profiles: ${getServersFilePath()}`,
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
      await reconnectAll();
      return { content: [{ type: "text", text: "Fully reconnected." }] };
    }
  );

  server.tool(
    "ssh_server_list",
    "List configured SSH server profiles and which one is active.",
    {},
    async () => {
      const active = getActiveServerName();
      const profiles = listServerProfiles();
      const lines = [
        `Profiles file: ${getServersFilePath()}`,
        ...profiles.map(p => {
          const auth = p.password ? "password" : p.keyPath ? `key:${p.keyPath}` : "none";
          const mark = p.name === active ? "*" : " ";
          return `${mark} ${p.name} -> ${p.username}@${p.host}:${p.port} (${auth})`;
        }),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ssh_server_add",
    "Add or update a persisted SSH server profile. Optionally make it active immediately.",
    {
      name: z.string().min(1).describe("Unique profile name, e.g. prod-eu"),
      host: z.string().min(1).describe("Remote host or IP"),
      username: z.string().min(1).describe("SSH username"),
      port: z.number().int().min(1).max(65535).optional().describe("SSH port (default: 22)"),
      password: z.string().optional().describe("Password auth"),
      keyPath: z.string().optional().describe("Path to private key on the MCP host"),
      overwrite: z.boolean().default(false).describe("Replace existing profile with same name"),
      setActive: z.boolean().default(true).describe("Switch active server to this profile now"),
    },
    async ({ name, host, username, port, password, keyPath, overwrite, setActive }) => {
      try {
        const input = { name, host, username, overwrite, setActive } as const;
        const created = addServerProfile({
          ...input,
          ...(port !== undefined ? { port } : {}),
          ...(password ? { password } : {}),
          ...(keyPath ? { keyPath } : {}),
        });
        if (setActive) await reconnectAll();
        return {
          content: [
            {
              type: "text",
              text: `Saved profile '${created.name}' (${created.username}@${created.host}:${created.port}).${
                setActive ? " Active server switched and reconnected." : ""
              }`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to add profile: ${msg}` }] };
      }
    }
  );

  server.tool(
    "ssh_server_use",
    "Switch the active SSH server profile and reconnect all sessions.",
    {
      name: z.string().min(1).describe("Profile name to activate"),
    },
    async ({ name }) => {
      try {
        const active = useServerProfile(name);
        await reconnectAll();
        return {
          content: [
            {
              type: "text",
              text: `Active server is now '${active.name}' (${active.username}@${active.host}:${active.port}).`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to switch server: ${msg}` }] };
      }
    }
  );

  server.tool(
    "ssh_server_remove",
    "Remove a persisted SSH server profile. If removing the active profile, another profile becomes active.",
    {
      name: z.string().min(1).describe("Profile name to remove"),
    },
    async ({ name }) => {
      try {
        const wasActive = name === getActiveServerName();
        const result = removeServerProfile(name);
        if (wasActive) await reconnectAll();
        return {
          content: [
            {
              type: "text",
              text: `Removed profile '${result.removed}'. Active profile: '${result.active}'.${
                wasActive ? " Reconnected using the new active profile." : ""
              }`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to remove profile: ${msg}` }] };
      }
    }
  );
}
