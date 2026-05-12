/**
 * runtime-policy.ts
 *
 * File-backed policy loader for tool handlers. Missing policy files resolve to
 * an empty allow-all policy so existing installs keep their current behavior.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getActiveServerName } from "./config.js";
import { parsePolicyConfig } from "./policy-config.js";
import {
  assertCommandAllowed,
  assertPathAllowed,
  assertWriteAllowed,
  compilePolicy,
  resolvePolicyForProfile,
  type CompiledPolicy,
  type EffectivePolicy,
  type PathPolicyOptions,
} from "./policy.js";

const DEFAULT_POLICY_FILE = path.join(os.homedir(), ".ssh-mcp", "policy.json");

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedPolicy: CompiledPolicy | null = null;

export function getPolicyFilePath(): string {
  return process.env.SSH_POLICY_FILE?.trim() || DEFAULT_POLICY_FILE;
}

function loadCompiledPolicy(): CompiledPolicy {
  const filePath = getPolicyFilePath();
  if (!fs.existsSync(filePath)) {
    if (cachedPath !== "<empty>") {
      cachedPath = "<empty>";
      cachedMtimeMs = -1;
      cachedPolicy = compilePolicy(parsePolicyConfig({}));
    }
    return cachedPolicy!;
  }

  const stat = fs.statSync(filePath);
  if (cachedPolicy && cachedPath === filePath && cachedMtimeMs === stat.mtimeMs) {
    return cachedPolicy;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  cachedPath = filePath;
  cachedMtimeMs = stat.mtimeMs;
  cachedPolicy = compilePolicy(parsePolicyConfig(parsed));
  return cachedPolicy;
}

export function getActivePolicy(): EffectivePolicy {
  return resolvePolicyForProfile(loadCompiledPolicy(), getActiveServerName() || "default");
}

export function assertActiveCommandAllowed(command: string): void {
  assertCommandAllowed(getActivePolicy(), command);
}

export function assertActivePathAllowed(remotePath: string, options: PathPolicyOptions = {}): string {
  const policy = getActivePolicy();
  if (policy.allowedRemotePaths.length === 0) {
    if (options.write) assertWriteAllowed(policy, options.operation ?? "Write operation");
    return remotePath;
  }
  return assertPathAllowed(policy, remotePath, options);
}

export function assertActiveWriteAllowed(operation: string): void {
  assertWriteAllowed(getActivePolicy(), operation);
}

export function policyFailureText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Policy blocked operation: ${msg}`;
}

export function __resetRuntimePolicyForTests(): void {
  cachedPath = "";
  cachedMtimeMs = -1;
  cachedPolicy = null;
}
