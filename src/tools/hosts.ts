import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildConnectivityCheckCommand,
  discoverHosts,
  getDefaultKnownHostsPath,
  getDefaultSshConfigPath,
  getHostInfo,
} from "../ssh-discovery.js";

export function registerHostTools(server: McpServer): void {
  server.tool(
    "ssh_host_list",
    "List SSH hosts discovered from ~/.ssh/config and ~/.ssh/known_hosts.",
    {
      include_wildcards: z.boolean().default(false).describe("Include wildcard Host patterns from ssh config"),
      config_path: z.string().optional().describe("Override path to SSH config (default: ~/.ssh/config)"),
      known_hosts_path: z.string().optional().describe("Override path to known_hosts (default: ~/.ssh/known_hosts)"),
    },
    async ({ include_wildcards, config_path, known_hosts_path }) => {
      const hosts = discoverHosts({
        includeWildcardHosts: include_wildcards,
        ...(config_path ? { configPath: config_path } : {}),
        ...(known_hosts_path ? { knownHostsPath: known_hosts_path } : {}),
      });
      const configPath = config_path ?? getDefaultSshConfigPath();
      const knownHostsPath = known_hosts_path ?? getDefaultKnownHostsPath();

      if (hosts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                "No SSH hosts discovered.",
                `config:      ${configPath}`,
                `known_hosts: ${knownHostsPath}`,
              ].join("\n"),
            },
          ],
        };
      }

      const lines = [
        `Discovered ${hosts.length} host(s).`,
        `config:      ${configPath}`,
        `known_hosts: ${knownHostsPath}`,
      ];
      for (const host of hosts) {
        const dest = host.user ? `${host.user}@${host.hostName ?? host.name}` : host.hostName ?? host.name;
        const details = [
          `sources=${host.sources.join("+")}`,
          host.port !== undefined ? `port=${host.port}` : undefined,
          host.identityFile ? `key=${host.identityFile}` : undefined,
          host.proxyJump ? `proxyjump=${host.proxyJump}` : undefined,
        ].filter(Boolean);
        lines.push(`- ${host.name} -> ${dest}${details.length > 0 ? ` (${details.join(", ")})` : ""}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ssh_host_info",
    "Show merged host details from SSH config + known_hosts for a specific host or alias.",
    {
      host: z.string().min(1).describe("Host alias or hostname to inspect"),
      include_wildcards: z.boolean().default(false).describe("Allow wildcard config patterns in lookup"),
      config_path: z.string().optional().describe("Override path to SSH config (default: ~/.ssh/config)"),
      known_hosts_path: z.string().optional().describe("Override path to known_hosts (default: ~/.ssh/known_hosts)"),
    },
    async ({ host, include_wildcards, config_path, known_hosts_path }) => {
      const info = getHostInfo(host, {
        includeWildcardHosts: include_wildcards,
        ...(config_path ? { configPath: config_path } : {}),
        ...(known_hosts_path ? { knownHostsPath: known_hosts_path } : {}),
      });

      if (!info.host) {
        if (info.candidates.length > 1) {
          const matches = info.candidates.map(candidate => `- ${candidate.name}`).join("\n");
          return { content: [{ type: "text", text: `Ambiguous host '${host}'. Matches:\n${matches}` }] };
        }
        return { content: [{ type: "text", text: `Host '${host}' was not found in ssh config or known_hosts.` }] };
      }

      const resolved = info.host;
      const command = buildConnectivityCheckCommand({
        host: resolved.hostName ?? resolved.name,
        ...(resolved.user ? { user: resolved.user } : {}),
        ...(resolved.port !== undefined ? { port: resolved.port } : {}),
        ...(resolved.identityFile ? { identityFile: resolved.identityFile } : {}),
      });

      const lines = [
        `name:         ${resolved.name}`,
        `destination:  ${resolved.user ? `${resolved.user}@` : ""}${resolved.hostName ?? resolved.name}`,
        `aliases:      ${resolved.aliases.join(", ")}`,
        `sources:      ${resolved.sources.join(", ")}`,
        `port:         ${resolved.port ?? "(default)"}`,
        `identityFile: ${resolved.identityFile ?? "(none)"}`,
        `proxyJump:    ${resolved.proxyJump ?? "(none)"}`,
        `check_cmd:    ${command}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "ssh_host_check",
    "Generate a local ssh connectivity check command for a host. Execution path is currently optional and stubbed.",
    {
      host: z.string().min(1).describe("Host alias or hostname"),
      user: z.string().optional().describe("Override SSH user"),
      port: z.number().int().min(1).max(65535).optional().describe("Override SSH port"),
      identity_file: z.string().optional().describe("Override SSH identity file path"),
      timeout: z.number().optional().describe("Connect timeout in seconds (default: 5, max: 60)"),
      probe_command: z.string().optional().describe("Remote probe command (default: echo mcp-ok)"),
      execute: z.boolean().default(false).describe("Reserved for future active checks; currently returns a stub"),
      include_wildcards: z.boolean().default(false).describe("Allow wildcard config patterns in lookup"),
      config_path: z.string().optional().describe("Override path to SSH config (default: ~/.ssh/config)"),
      known_hosts_path: z.string().optional().describe("Override path to known_hosts (default: ~/.ssh/known_hosts)"),
    },
    async ({ host, user, port, identity_file, timeout, probe_command, execute, include_wildcards, config_path, known_hosts_path }) => {
      const info = getHostInfo(host, {
        includeWildcardHosts: include_wildcards,
        ...(config_path ? { configPath: config_path } : {}),
        ...(known_hosts_path ? { knownHostsPath: known_hosts_path } : {}),
      });
      const discovered = info.host;
      const targetHost = discovered?.hostName ?? discovered?.name ?? host;
      const checkInput: {
        host: string;
        user?: string;
        port?: number;
        identityFile?: string;
        timeoutSec?: number;
        probeCommand?: string;
      } = { host: targetHost };
      const resolvedUser = user ?? discovered?.user;
      if (resolvedUser !== undefined) checkInput.user = resolvedUser;
      const resolvedPort = port ?? discovered?.port;
      if (resolvedPort !== undefined) checkInput.port = resolvedPort;
      const resolvedIdentity = identity_file ?? discovered?.identityFile;
      if (resolvedIdentity !== undefined) checkInput.identityFile = resolvedIdentity;
      if (timeout !== undefined) checkInput.timeoutSec = timeout;
      if (probe_command) checkInput.probeCommand = probe_command;
      const command = buildConnectivityCheckCommand(checkInput);

      if (!execute) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Connectivity check command generated (not executed):",
                command,
                "Pass execute=true to use the execution pathway once wired.",
              ].join("\n"),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "Execution pathway is not wired in this tool yet.",
              "Run this command locally to verify connectivity:",
              command,
            ].join("\n"),
          },
        ],
      };
    }
  );
}
