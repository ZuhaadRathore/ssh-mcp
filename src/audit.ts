/**
 * audit.ts
 *
 * Append-only structured audit logging for remote command/file operations.
 *
 * Records are written as JSON Lines so writes are append-only and streaming-
 * friendly. Each event includes stable IDs (session/profile/job), action/tool
 * metadata, and for command events a SHA-256 hash of the command.
 */
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const AUDIT_LOG_FILE =
  process.env.SSH_AUDIT_FILE?.trim() ||
  path.join(os.homedir(), ".ssh-mcp", "audit.log.jsonl");

export interface AuditIds {
  sessionId?: string;
  profileId?: string;
  jobId?: string;
}

export interface CommandHashMetadata {
  algorithm: "sha256";
  value: string;
  inputBytes: number;
}

interface BaseAuditInput {
  action: string;
  success: boolean;
  tool?: string;
  ids?: AuditIds;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | string;
}

export interface CommandAuditInput extends BaseAuditInput {
  command: string;
  exitCode?: number;
  durationMs?: number;
  timeoutMs?: number;
}

export interface FileAuditInput extends BaseAuditInput {
  path?: string;
  fromPath?: string;
  toPath?: string;
  bytes?: number;
}

interface BaseAuditRecord {
  version: 1;
  eventId: string;
  occurredAt: string;
  category: "command" | "file";
  action: string;
  success: boolean;
  tool?: string;
  ids?: AuditIds;
  metadata?: Record<string, unknown>;
}

export interface CommandAuditRecord extends BaseAuditRecord {
  category: "command";
  commandHash: CommandHashMetadata;
  exitCode?: number;
  durationMs?: number;
  timeoutMs?: number;
}

export interface FileAuditRecord extends BaseAuditRecord {
  category: "file";
  path?: string;
  fromPath?: string;
  toPath?: string;
  bytes?: number;
}

export type AuditRecord = CommandAuditRecord | FileAuditRecord;

export interface AuditLoggerOptions {
  filePath?: string;
  failOpen?: boolean;
}

export interface AuditLogger {
  readonly filePath: string;
  logCommand(input: CommandAuditInput): CommandAuditRecord;
  logFile(input: FileAuditInput): FileAuditRecord;
  log(record: AuditRecord): AuditRecord;
}

class JsonlAuditLogger implements AuditLogger {
  readonly filePath: string;
  private readonly failOpen: boolean;

  constructor(options: AuditLoggerOptions = {}) {
    this.filePath = options.filePath?.trim() || AUDIT_LOG_FILE;
    this.failOpen = options.failOpen ?? true;
  }

  logCommand(input: CommandAuditInput): CommandAuditRecord {
    const record: CommandAuditRecord = {
      ...buildBaseRecord(input, "command"),
      commandHash: hashCommand(input.command),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
    this.append(record);
    return record;
  }

  logFile(input: FileAuditInput): FileAuditRecord {
    const record: FileAuditRecord = {
      ...buildBaseRecord(input, "file"),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.fromPath !== undefined ? { fromPath: input.fromPath } : {}),
      ...(input.toPath !== undefined ? { toPath: input.toPath } : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    };
    this.append(record);
    return record;
  }

  log(record: AuditRecord): AuditRecord {
    this.append(record);
    return record;
  }

  private append(record: AuditRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err: unknown) {
      if (this.failOpen) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`WARN: Failed to append audit log '${this.filePath}': ${msg}\n`);
        return;
      }
      throw err;
    }
  }
}

function buildBaseRecord<C extends "command" | "file">(
  input: BaseAuditInput,
  category: C
): Omit<BaseAuditRecord, "category"> & { category: C } {
  const ids = normalizeIds(input.ids);
  return {
    version: 1,
    eventId: randomBytes(12).toString("hex"),
    occurredAt: toIso(input.occurredAt),
    category,
    action: input.action,
    success: input.success,
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    ...(ids ? { ids } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

function normalizeIds(ids: AuditIds | undefined): AuditIds | undefined {
  if (!ids) return undefined;
  const normalized: AuditIds = {
    ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
    ...(ids.profileId ? { profileId: ids.profileId } : {}),
    ...(ids.jobId ? { jobId: ids.jobId } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toIso(occurredAt: Date | string | undefined): string {
  if (!occurredAt) return new Date().toISOString();
  if (occurredAt instanceof Date) return occurredAt.toISOString();
  const parsed = new Date(occurredAt);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function hashCommand(command: string): CommandHashMetadata {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(command, "utf8").digest("hex"),
    inputBytes: Buffer.byteLength(command, "utf8"),
  };
}

export function createAuditLogger(options: AuditLoggerOptions = {}): AuditLogger {
  return new JsonlAuditLogger(options);
}

export const audit: AuditLogger = createAuditLogger();

export function logCommandAudit(input: CommandAuditInput): CommandAuditRecord {
  return audit.logCommand(input);
}

export function logFileAudit(input: FileAuditInput): FileAuditRecord {
  return audit.logFile(input);
}
