/**
 * tools/directory.ts
 *
 * MCP tools for exploring the remote filesystem:
 *
 *   ssh_list_dir  — SFTP readdir with optional long format (permissions, size, mtime)
 *   ssh_stat      — SFTP stat for a single path (type, size, mode, uid/gid, timestamps)
 *   ssh_find      — flexible search via grep -r (content-only, no depth limit) or
 *                   find (name patterns, type filter, maxDepth, optional content filter)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileEntry } from "ssh2";
import { z } from "zod";
import { getSession } from "../shell.js";
import { getSftp } from "../sftp.js";
import { fmt, q } from "../helpers.js";

// Concrete shape of what sftp.stat() actually returns at runtime
interface StatAttrs {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Register ssh_list_dir, ssh_stat, and ssh_find tools on the given MCP server. */
export function registerDirectoryTools(server: McpServer): void {
  server.tool(
    "ssh_list_dir",
    "List a directory on the remote server via SFTP.",
    {
      path: z.string().default("."),
      long: z.boolean().default(false).describe("Show permissions, size, owner, mtime"),
    },
    async ({ path, long }) => {
      const sftp = await getSftp();
      const entries = await new Promise<FileEntry[]>((res, rej) =>
        sftp.readdir(path, (err, list) => err ? rej(err) : res(list))
      );
      entries.sort((a, b) => a.filename.localeCompare(b.filename));
      const text = long
        ? entries.map(e => e.longname).join("\n")
        : entries.map(e => e.filename).join("\n");
      return { content: [{ type: "text", text: text || "(empty directory)" }] };
    }
  );

  server.tool(
    "ssh_stat",
    "Get metadata for a file or directory (size, permissions, timestamps, uid/gid).",
    { path: z.string() },
    async ({ path }) => {
      const sftp = await getSftp();
      const s = await new Promise<StatAttrs>((res, rej) =>
        sftp.stat(path, (err, stats) => err ? rej(err) : res(stats as unknown as StatAttrs))
      );
      const kind = s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other";
      const mode = (s.mode & 0o777).toString(8).padStart(3, "0");
      return { content: [{ type: "text", text: [
        `Path:     ${path}`,
        `Type:     ${kind}`,
        `Size:     ${s.size} bytes`,
        `Mode:     ${mode}`,
        `UID/GID:  ${s.uid}/${s.gid}`,
        `Modified: ${new Date(s.mtime * 1000).toISOString()}`,
        `Accessed: ${new Date(s.atime * 1000).toISOString()}`,
      ].join("\n") }] };
    }
  );

  server.tool(
    "ssh_find",
    "Find files or directories by name pattern and/or content.",
    {
      path: z.string().default("."),
      name: z.string().optional().describe("Filename glob e.g. '*.ts'"),
      content: z.string().optional().describe("Search inside files for this string"),
      type: z.enum(["file", "dir", "any"]).default("any"),
      maxDepth: z.number().optional(),
      caseSensitive: z.boolean().default(true),
    },
    async ({ path, name, content, type, maxDepth, caseSensitive }) => {
      let cmd: string;

      // Pure content search with no depth limit — grep -r is fastest
      if (content && !name && maxDepth === undefined) {
        cmd = `grep ${caseSensitive ? "-rl" : "-rli"} ${q(content)} ${q(path)} 2>/dev/null`;
      } else {
        // Use find (supports maxDepth, type filters, name patterns)
        cmd = `find ${q(path)}`;
        if (maxDepth !== undefined) cmd += ` -maxdepth ${maxDepth}`;
        if (type === "file") cmd += " -type f";
        else if (type === "dir") cmd += " -type d";
        if (name) cmd += ` ${caseSensitive ? "-name" : "-iname"} ${q(name)}`;
        if (content) {
          cmd += ` -type f -exec grep -l ${caseSensitive ? "" : "-i "}${q(content)} {} \\;`;
        }
        cmd += " 2>/dev/null";
      }

      const r = await getSession("default").exec(cmd, 30000);
      return { content: [{ type: "text", text: r.stdout || fmt(r) || "(no results)" }] };
    }
  );
}
