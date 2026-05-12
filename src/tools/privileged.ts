/**
 * tools/privileged.ts
 *
 * MCP tool for guarded privileged execution:
 *
 *   ssh_exec_sudo — two-step confirmation flow for sudo execution.
 *                   First call issues a short-lived confirmation token.
 *                   Second call (same command/session/timeout + token)
 *                   executes via sudo with timeout forwarding.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "crypto";
import { z } from "zod";
import { fmt, q } from "../helpers.js";
import { getSession } from "../shell.js";
import { logCommandAudit } from "../audit.js";
import { auditIds } from "../tool-context.js";
import { assertActiveCommandAllowed, policyFailureText } from "../runtime-policy.js";

interface PendingConfirmation {
  command: string;
  session: string;
  timeoutMs: number;
  expiresAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const CONFIRMATION_TTL_MS = 120_000;

function cleanupExpiredConfirmations(now = Date.now()): void {
  for (const [token, entry] of pendingConfirmations.entries()) {
    if (entry.expiresAt <= now) pendingConfirmations.delete(token);
  }
}

function buildSudoCommand(command: string): string {
  return `sudo -n -- sh -lc ${q(command)}`;
}

/** Register ssh_exec_sudo on the given MCP server. */
export function registerPrivilegedTools(server: McpServer): void {
  server.tool(
    "ssh_exec_sudo",
    "Run a command with sudo using a two-step confirmation token guardrail.",
    {
      command: z.string().min(1).describe("Command to execute under sudo"),
      session: z.string().default("default").describe("Named shell session"),
      timeout: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_SECONDS)
        .optional()
        .describe(`Timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}, max: ${MAX_TIMEOUT_SECONDS})`),
      confirm_token: z
        .string()
        .optional()
        .describe("Confirmation token from a prior ssh_exec_sudo call"),
    },
    async ({ command, session, timeout, confirm_token }) => {
      cleanupExpiredConfirmations();
      const timeoutMs = (timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const now = Date.now();
      const sudoCommand = buildSudoCommand(command);

      try {
        assertActiveCommandAllowed(command);
      } catch (err) {
        logCommandAudit({
          action: "sudo_exec",
          tool: "ssh_exec_sudo",
          command: sudoCommand,
          success: false,
          timeoutMs,
          ids: auditIds(session),
          metadata: { reason: "policy" },
        });
        return { content: [{ type: "text", text: policyFailureText(err) }] };
      }

      if (!confirm_token) {
        const token = randomBytes(6).toString("hex");
        pendingConfirmations.set(token, {
          command,
          session,
          timeoutMs,
          expiresAt: now + CONFIRMATION_TTL_MS,
        });
        return {
          content: [{
            type: "text",
            text: [
              "Confirmation required for privileged execution.",
              `Token: ${token}`,
              `Re-run ssh_exec_sudo with the same command/session/timeout and confirm_token within ${CONFIRMATION_TTL_MS / 1000}s.`,
              `Planned command: ${sudoCommand}`,
            ].join("\n"),
          }],
        };
      }

      const pending = pendingConfirmations.get(confirm_token);
      if (!pending) {
        return {
          content: [{
            type: "text",
            text: "Invalid or expired confirmation token. Call ssh_exec_sudo again without confirm_token to request a new token.",
          }],
        };
      }

      if (pending.expiresAt <= now) {
        pendingConfirmations.delete(confirm_token);
        return {
          content: [{
            type: "text",
            text: "Confirmation token expired. Call ssh_exec_sudo again without confirm_token to request a new token.",
          }],
        };
      }

      if (pending.command !== command || pending.session !== session || pending.timeoutMs !== timeoutMs) {
        return {
          content: [{
            type: "text",
            text: "Confirmation token does not match the provided command/session/timeout. Reuse the exact same arguments or request a new token.",
          }],
        };
      }

      pendingConfirmations.delete(confirm_token);
      const started = Date.now();
      const r = await getSession(session).exec(sudoCommand, timeoutMs);
      logCommandAudit({
        action: "sudo_exec",
        tool: "ssh_exec_sudo",
        command: sudoCommand,
        success: r.code === 0,
        exitCode: r.code,
        timeoutMs,
        durationMs: Date.now() - started,
        ids: auditIds(session),
      });
      return { content: [{ type: "text", text: fmt(r) }] };
    }
  );
}

/** Test helper: clear in-memory pending confirmations. */
export function __resetPrivilegedStateForTests(): void {
  pendingConfirmations.clear();
}

/** Test helper: number of live pending confirmations. */
export function __getPrivilegedPendingCountForTests(): number {
  cleanupExpiredConfirmations();
  return pendingConfirmations.size;
}
