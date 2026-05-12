/**
 * index.ts
 *
 * Entry point for the ssh-remote MCP server. Creates the McpServer instance,
 * registers all tool groups, then connects to the stdio transport that Claude
 * communicates over. Configuration is validated at import time by config.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getActiveServerProfile } from "./config.js";
import { registerExecTools } from "./tools/exec.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerFileTools } from "./tools/files.js";
import { registerDirectoryTools } from "./tools/directory.js";
import { registerSystemTools } from "./tools/system.js";
import { registerManageTools } from "./tools/manage.js";
import { registerHostTools } from "./tools/hosts.js";
import { registerPrivilegedTools } from "./tools/privileged.js";

const server = new McpServer({ name: "ssh-remote", version: "4.0.0" });

registerExecTools(server);
registerJobTools(server);
registerFileTools(server);
registerDirectoryTools(server);
registerSystemTools(server);
registerManageTools(server);
registerHostTools(server);
registerPrivilegedTools(server);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  try {
    const active = getActiveServerProfile();
    process.stderr.write(`SSH MCP v4 — [${active.name}] ${active.username}@${active.host}:${active.port}\n`);
  } catch {
    process.stderr.write("SSH MCP v4 — no active server profile configured yet\n");
  }
});
