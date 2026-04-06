/**
 * helpers.ts
 *
 * Shared utilities used across multiple tool modules.
 *
 *   q(s)   — shell-safe single-quote wrapping; prevents injection from
 *             user-supplied paths or strings embedded in shell commands.
 *   fmt(r) — formats a ShellResult into a human-readable text block that
 *             includes stdout, labelled stderr, and the exit code.
 */
import type { ShellResult } from "./shell.js";

/** Shell-safe single-quote a string. */
export function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Format a ShellResult for tool output. */
export function fmt(r: ShellResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  parts.push(`Exit: ${r.code}`);
  return parts.join("\n");
}
