/**
 * tools/files.ts
 *
 * MCP tools for reading and editing remote files:
 *
 *   ssh_read_file  — read a full file or a line-range slice via wc -l + sed.
 *   ssh_write_file — write arbitrary content to a path via SFTP (binary-safe).
 *   ssh_edit_file  — exact find-and-replace guarded by a uniqueness check.
 *   ssh_delete     — delete a file or directory (recursive optional).
 *   ssh_move       — rename or move a path via SFTP.
 *   ssh_chmod      — change file permissions.
 *   ssh_tail       — stream the last N lines of a file.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSession } from "../shell.js";
import { getSftp } from "../sftp.js";
import { fmt, q } from "../helpers.js";

/** Register all file-operation tools on the given MCP server. */
export function registerFileTools(server: McpServer): void {
  server.tool(
    "ssh_read_file",
    "Read a file from the remote server. Supports partial reads with offset/limit (line numbers, 1-based).",
    {
      path: z.string(),
      offset: z.number().optional().describe("Start at this line number, 1-based (default: 1)"),
      limit: z.number().optional().describe("Number of lines to read (default: all)"),
    },
    async ({ path, offset, limit }) => {
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "$";
        const cmd = `wc -l < ${q(path)} && sed -n '${start},${end}p' ${q(path)}`;
        const r = await getSession("default").exec(cmd, 15000);
        if (r.code !== 0) return { content: [{ type: "text", text: fmt(r) }] };
        const nl = r.stdout.indexOf("\n");
        const totalLines = parseInt(r.stdout.substring(0, nl).trim(), 10);
        const content = r.stdout.substring(nl + 1);
        const displayEnd = limit !== undefined ? Math.min(start + limit - 1, totalLines) : totalLines;
        return { content: [{ type: "text", text: `[Lines ${start}–${displayEnd} of ${totalLines}]\n${content}` }] };
      }

      const sftp = await getSftp();
      const buf = await new Promise<Buffer>((res, rej) => sftp.readFile(path, (err, data) => err ? rej(err) : res(data)));
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      const totalLines = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
      return { content: [{ type: "text", text: `[${totalLines} lines]\n${text}` }] };
    }
  );

  server.tool(
    "ssh_write_file",
    "Write a file on the remote server via SFTP (binary-safe, auto-creates parent directories).",
    {
      path: z.string(),
      content: z.string(),
    },
    async ({ path, content }) => {
      const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
      if (dir) await getSession("default").exec(`mkdir -p ${q(dir)}`, 10000);
      const sftp = await getSftp();
      await new Promise<void>((res, rej) => sftp.writeFile(path, Buffer.from(content, "utf8"), err => err ? rej(err) : res()));
      return { content: [{ type: "text", text: `Written ${path} (${Buffer.byteLength(content)} bytes)` }] };
    }
  );

  server.tool(
    "ssh_edit_file",
    "Make a targeted find-and-replace edit to a remote file. Fails if old_string is not found or matches more than once, unless replace_all is set.",
    {
      path: z.string(),
      old_string: z.string().describe("Exact string to find — must match character-for-character including whitespace"),
      new_string: z.string().describe("String to replace it with"),
      replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring uniqueness"),
    },
    async ({ path, old_string, new_string, replace_all }) => {
      const sftp = await getSftp();
      const buf = await new Promise<Buffer>((res, rej) => sftp.readFile(path, (err, data) => err ? rej(err) : res(data)));
      const original = buf.toString("utf8");

      const first = original.indexOf(old_string);
      if (first === -1) {
        return { content: [{ type: "text", text: `Edit failed: old_string not found in ${path}` }] };
      }

      if (!replace_all) {
        const second = original.indexOf(old_string, first + 1);
        if (second !== -1) {
          return { content: [{ type: "text", text: `Edit failed: old_string appears more than once (at byte ${first} and ${second}). Use replace_all or make old_string more specific.` }] };
        }
      }

      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.substring(0, first) + new_string + original.substring(first + old_string.length);

      await new Promise<void>((res, rej) => sftp.writeFile(path, Buffer.from(updated, "utf8"), err => err ? rej(err) : res()));
      const count = replace_all ? original.split(old_string).length - 1 : 1;
      return { content: [{ type: "text", text: `Edited ${path} — replaced ${count} occurrence${count !== 1 ? "s" : ""}` }] };
    }
  );

  server.tool(
    "ssh_delete",
    "Delete a file or directory on the remote server.",
    {
      path: z.string(),
      recursive: z.boolean().default(false).describe("Recursively delete — required for non-empty directories"),
    },
    async ({ path, recursive }) => {
      if (recursive) {
        const r = await getSession("default").exec(`rm -rf ${q(path)}`, 30000);
        return { content: [{ type: "text", text: r.code === 0 ? `Deleted ${path}` : fmt(r) }] };
      }
      const sftp = await getSftp();
      await new Promise<void>((res, rej) =>
        sftp.unlink(path, err => err
          ? sftp.rmdir(path, err2 => err2 ? rej(new Error(`${err.message} / ${err2.message}`)) : res())
          : res()
        )
      );
      return { content: [{ type: "text", text: `Deleted ${path}` }] };
    }
  );

  server.tool(
    "ssh_move",
    "Move or rename a file/directory on the remote server.",
    {
      from: z.string(),
      to: z.string(),
    },
    async ({ from, to }) => {
      const sftp = await getSftp();
      await new Promise<void>((res, rej) => sftp.rename(from, to, err => err ? rej(err) : res()));
      return { content: [{ type: "text", text: `Moved ${from} → ${to}` }] };
    }
  );

  server.tool(
    "ssh_chmod",
    "Change permissions on a file or directory.",
    {
      path: z.string(),
      mode: z.string().describe("Octal mode e.g. '755' or '644'"),
    },
    async ({ path, mode }) => {
      const r = await getSession("default").exec(`chmod ${mode} ${q(path)}`, 10000);
      return { content: [{ type: "text", text: r.code === 0 ? `chmod ${mode} ${path}` : fmt(r) }] };
    }
  );

  server.tool(
    "ssh_tail",
    "Read the last N lines of a file — useful for logs.",
    {
      path: z.string(),
      lines: z.number().default(50),
    },
    async ({ path, lines }) => {
      const r = await getSession("default").exec(`tail -n ${lines} ${q(path)}`, 15000);
      return { content: [{ type: "text", text: r.stdout || fmt(r) }] };
    }
  );
}
