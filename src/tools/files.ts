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
import { createHash } from "node:crypto";
import { z } from "zod";
import { getSession } from "../shell.js";
import { getSftp } from "../sftp.js";
import { fmt, q } from "../helpers.js";
import { logFileAudit } from "../audit.js";
import { auditIds } from "../tool-context.js";
import { assertActivePathAllowed, policyFailureText } from "../runtime-policy.js";

const SHA256_HEX = /^[a-fA-F0-9]{64}$/;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeSha256(value: string): string {
  return value.trim().toLowerCase();
}

function isMissingRemoteFileError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  const lower = text.toLowerCase();
  return lower.includes("no such file") || lower.includes("not found") || lower.includes("enoent");
}

function lineNumberAt(content: string, byteIndex: number): number {
  let line = 1;
  for (let i = 0; i < byteIndex; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1; // '\n'
  }
  return line;
}

function buildPatchPreview(path: string, oldString: string, newString: string, startLine: number, replacementCount: number): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const oldCount = Math.max(oldLines.length, 1);
  const newCount = Math.max(newLines.length, 1);
  const oldBlock = oldLines.map(line => `-${line}`).join("\n");
  const newBlock = newLines.map(line => `+${line}`).join("\n");
  const suffix = replacementCount > 1 ? `\n# replace_all=true; total replacements: ${replacementCount}` : "";
  return `--- ${path}\n+++ ${path}\n@@ -${startLine},${oldCount} +${startLine},${newCount} @@\n${oldBlock}\n${newBlock}${suffix}`;
}

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
      try {
        assertActivePathAllowed(path, { operation: "ssh_read_file" });
      } catch (err) {
        logFileAudit({
          action: "read",
          tool: "ssh_read_file",
          success: false,
          path,
          ids: auditIds("default"),
          metadata: { reason: "policy" },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

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
        logFileAudit({
          action: "read",
          tool: "ssh_read_file",
          success: true,
          path,
          bytes: Buffer.byteLength(content, "utf8"),
          ids: auditIds("default"),
          metadata: { offset: start, limit },
        });
        return { content: [{ type: "text", text: `[Lines ${start}–${displayEnd} of ${totalLines}]\n${content}` }] };
      }

      const sftp = await getSftp();
      const buf = await new Promise<Buffer>((res, rej) => sftp.readFile(path, (err, data) => err ? rej(err) : res(data)));
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      const totalLines = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
      logFileAudit({
        action: "read",
        tool: "ssh_read_file",
        success: true,
        path,
        bytes: buf.length,
        ids: auditIds("default"),
      });
      return { content: [{ type: "text", text: `[${totalLines} lines]\n${text}` }] };
    }
  );

  server.tool(
    "ssh_write_file",
    "Write a file on the remote server via SFTP (binary-safe, auto-creates parent directories).",
    {
      path: z.string(),
      content: z.string(),
      expected_sha256: z.string().regex(SHA256_HEX, "expected_sha256 must be a 64-character hex SHA256 digest").optional()
        .describe("Optional precondition. When set, write only if current remote file SHA256 matches this digest."),
    },
    async ({ path, content, expected_sha256 }) => {
      try {
        assertActivePathAllowed(path, { write: true, operation: "ssh_write_file" });
      } catch (err) {
        logFileAudit({
          action: "write",
          tool: "ssh_write_file",
          success: false,
          path,
          bytes: Buffer.byteLength(content, "utf8"),
          ids: auditIds("default"),
          metadata: { reason: "policy" },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const sftp = await getSftp();

      if (expected_sha256 !== undefined) {
        let current: Buffer;
        try {
          current = await new Promise<Buffer>((res, rej) => sftp.readFile(path, (err, data) => err ? rej(err) : res(data)));
        } catch (err) {
          if (isMissingRemoteFileError(err)) {
            logFileAudit({
              action: "write",
              tool: "ssh_write_file",
              success: false,
              path,
              bytes: Buffer.byteLength(content, "utf8"),
              ids: auditIds("default"),
              metadata: { reason: "sha256_missing" },
            });
            return { content: [{ type: "text", text: `Write failed: SHA256 precondition could not be checked because ${path} does not exist` }] };
          }
          throw err;
        }

        const actual = sha256Hex(current);
        const expected = normalizeSha256(expected_sha256);
        if (actual !== expected) {
          logFileAudit({
            action: "write",
            tool: "ssh_write_file",
            success: false,
            path,
            bytes: Buffer.byteLength(content, "utf8"),
            ids: auditIds("default"),
            metadata: { reason: "sha256_mismatch", expected, actual },
          });
          return { content: [{ type: "text", text: `Write failed: SHA256 precondition mismatch for ${path} (expected ${expected}, got ${actual})` }] };
        }
      }

      const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
      if (dir) await getSession("default").exec(`mkdir -p ${q(dir)}`, 10000);
      await new Promise<void>((res, rej) => sftp.writeFile(path, Buffer.from(content, "utf8"), err => err ? rej(err) : res()));
      logFileAudit({
        action: "write",
        tool: "ssh_write_file",
        success: true,
        path,
        bytes: Buffer.byteLength(content, "utf8"),
        ids: auditIds("default"),
        metadata: { expectedSha256: expected_sha256 !== undefined },
      });
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
      expected_sha256: z.string().regex(SHA256_HEX, "expected_sha256 must be a 64-character hex SHA256 digest").optional()
        .describe("Optional precondition. Edit only if current remote file SHA256 matches this digest."),
      dry_run: z.boolean().default(false).describe("When true, return a patch preview but do not write the file."),
    },
    async ({ path, old_string, new_string, replace_all, expected_sha256, dry_run }) => {
      try {
        assertActivePathAllowed(path, { write: true, operation: "ssh_edit_file" });
      } catch (err) {
        logFileAudit({
          action: "edit",
          tool: "ssh_edit_file",
          success: false,
          path,
          ids: auditIds("default"),
          metadata: { reason: "policy", dryRun: dry_run },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const sftp = await getSftp();
      const buf = await new Promise<Buffer>((res, rej) => sftp.readFile(path, (err, data) => err ? rej(err) : res(data)));
      const original = buf.toString("utf8");
      const currentSha = sha256Hex(buf);

      if (expected_sha256 !== undefined) {
        const expected = normalizeSha256(expected_sha256);
        if (currentSha !== expected) {
          logFileAudit({
            action: "edit",
            tool: "ssh_edit_file",
            success: false,
            path,
            bytes: buf.length,
            ids: auditIds("default"),
            metadata: { reason: "sha256_mismatch", expected, actual: currentSha, dryRun: dry_run },
          });
          return { content: [{ type: "text", text: `Edit failed: SHA256 precondition mismatch for ${path} (expected ${expected}, got ${currentSha})` }] };
        }
      }

      const first = original.indexOf(old_string);
      if (first === -1) {
        logFileAudit({
          action: "edit",
          tool: "ssh_edit_file",
          success: false,
          path,
          bytes: buf.length,
          ids: auditIds("default"),
          metadata: { reason: "old_string_not_found", dryRun: dry_run },
        });
        return { content: [{ type: "text", text: `Edit failed: old_string not found in ${path}` }] };
      }

      if (!replace_all) {
        const second = original.indexOf(old_string, first + 1);
        if (second !== -1) {
          logFileAudit({
            action: "edit",
            tool: "ssh_edit_file",
            success: false,
            path,
            bytes: buf.length,
            ids: auditIds("default"),
            metadata: { reason: "ambiguous_match", first, second, dryRun: dry_run },
          });
          return { content: [{ type: "text", text: `Edit failed: old_string appears more than once (at byte ${first} and ${second}). Use replace_all or make old_string more specific.` }] };
        }
      }

      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.substring(0, first) + new_string + original.substring(first + old_string.length);

      const count = replace_all ? original.split(old_string).length - 1 : 1;
      if (dry_run) {
        const startLine = lineNumberAt(original, first);
        const preview = buildPatchPreview(path, old_string, new_string, startLine, count);
        logFileAudit({
          action: "edit_preview",
          tool: "ssh_edit_file",
          success: true,
          path,
          bytes: buf.length,
          ids: auditIds("default"),
          metadata: { replaceAll: replace_all, replacementCount: count },
        });
        return {
          content: [{
            type: "text",
            text: `Dry run: would edit ${path} — replace ${count} occurrence${count !== 1 ? "s" : ""}\n${preview}`,
          }],
        };
      }

      await new Promise<void>((res, rej) => sftp.writeFile(path, Buffer.from(updated, "utf8"), err => err ? rej(err) : res()));
      logFileAudit({
        action: "edit",
        tool: "ssh_edit_file",
        success: true,
        path,
        bytes: Buffer.byteLength(updated, "utf8"),
        ids: auditIds("default"),
        metadata: { replaceAll: replace_all, replacementCount: count, expectedSha256: expected_sha256 !== undefined },
      });
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
      try {
        assertActivePathAllowed(path, { write: true, operation: "ssh_delete" });
      } catch (err) {
        logFileAudit({
          action: "delete",
          tool: "ssh_delete",
          success: false,
          path,
          ids: auditIds("default"),
          metadata: { reason: "policy", recursive },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      if (recursive) {
        const r = await getSession("default").exec(`rm -rf ${q(path)}`, 30000);
        logFileAudit({
          action: "delete",
          tool: "ssh_delete",
          success: r.code === 0,
          path,
          ids: auditIds("default"),
          metadata: { recursive, exitCode: r.code },
        });
        return { content: [{ type: "text", text: r.code === 0 ? `Deleted ${path}` : fmt(r) }] };
      }
      const sftp = await getSftp();
      await new Promise<void>((res, rej) =>
        sftp.unlink(path, err => err
          ? sftp.rmdir(path, err2 => err2 ? rej(new Error(`${err.message} / ${err2.message}`)) : res())
          : res()
        )
      );
      logFileAudit({
        action: "delete",
        tool: "ssh_delete",
        success: true,
        path,
        ids: auditIds("default"),
        metadata: { recursive },
      });
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
      try {
        assertActivePathAllowed(from, { operation: "ssh_move source" });
        assertActivePathAllowed(to, { write: true, operation: "ssh_move destination" });
      } catch (err) {
        logFileAudit({
          action: "move",
          tool: "ssh_move",
          success: false,
          fromPath: from,
          toPath: to,
          ids: auditIds("default"),
          metadata: { reason: "policy" },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const sftp = await getSftp();
      await new Promise<void>((res, rej) => sftp.rename(from, to, err => err ? rej(err) : res()));
      logFileAudit({
        action: "move",
        tool: "ssh_move",
        success: true,
        fromPath: from,
        toPath: to,
        ids: auditIds("default"),
      });
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
      try {
        assertActivePathAllowed(path, { write: true, operation: "ssh_chmod" });
      } catch (err) {
        logFileAudit({
          action: "chmod",
          tool: "ssh_chmod",
          success: false,
          path,
          ids: auditIds("default"),
          metadata: { reason: "policy", mode },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const r = await getSession("default").exec(`chmod ${mode} ${q(path)}`, 10000);
      logFileAudit({
        action: "chmod",
        tool: "ssh_chmod",
        success: r.code === 0,
        path,
        ids: auditIds("default"),
        metadata: { mode, exitCode: r.code },
      });
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
      try {
        assertActivePathAllowed(path, { operation: "ssh_tail" });
      } catch (err) {
        logFileAudit({
          action: "tail",
          tool: "ssh_tail",
          success: false,
          path,
          ids: auditIds("default"),
          metadata: { reason: "policy", lines },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      const r = await getSession("default").exec(`tail -n ${lines} ${q(path)}`, 15000);
      logFileAudit({
        action: "tail",
        tool: "ssh_tail",
        success: r.code === 0,
        path,
        bytes: Buffer.byteLength(r.stdout, "utf8"),
        ids: auditIds("default"),
        metadata: { lines, exitCode: r.code },
      });
      return { content: [{ type: "text", text: r.stdout || fmt(r) }] };
    }
  );
}
