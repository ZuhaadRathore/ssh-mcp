/**
 * policy.ts
 *
 * Reusable security policy APIs:
 * - Compile validated config into fast runtime structures
 * - Resolve effective policy for a server profile
 * - Enforce command and path restrictions
 */

import path from "node:path";
import type { PolicyConfig, PolicyRuleOverride } from "./policy-config.js";

interface CompiledPattern {
  source: string;
  regex: RegExp;
}

interface CompiledPolicySet {
  allowedCommands: CompiledPattern[];
  deniedCommands: CompiledPattern[];
  allowedRemotePaths: string[];
  readOnlyMode: boolean;
}

interface CompiledPolicyOverride {
  allowedCommands?: CompiledPattern[];
  deniedCommands?: CompiledPattern[];
  allowedRemotePaths?: string[];
  readOnlyMode?: boolean;
}

export interface CompiledPolicy {
  defaults: CompiledPolicySet;
  profiles: Record<string, CompiledPolicyOverride>;
}

export interface EffectivePolicy {
  profileName: string;
  allowedCommands: readonly RegExp[];
  deniedCommands: readonly RegExp[];
  allowedRemotePaths: readonly string[];
  readOnlyMode: boolean;
}

export interface PathPolicyOptions {
  write?: boolean;
  operation?: string;
}

function compilePatterns(patterns: string[], fieldPath: string): CompiledPattern[] {
  return patterns.map((source, i) => {
    try {
      return { source, regex: new RegExp(source) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${fieldPath}[${i}] failed to compile: ${msg}`);
    }
  });
}

function normalizePolicyRoot(rawPath: string, fieldPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`${fieldPath} must be an absolute path starting with '/'.`);
  }
  if (trimmed.includes("\0")) {
    throw new Error(`${fieldPath} cannot contain a null byte.`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (!normalized.startsWith("/")) {
    throw new Error(`${fieldPath} resolved to a non-absolute path.`);
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function compileAllowedRoots(paths: string[], fieldPath: string): string[] {
  return paths.map((p, i) => normalizePolicyRoot(p, `${fieldPath}[${i}]`));
}

function compileOverride(override: PolicyRuleOverride, fieldPath: string): CompiledPolicyOverride {
  const out: CompiledPolicyOverride = {};
  if (override.allowedCommands) out.allowedCommands = compilePatterns(override.allowedCommands, `${fieldPath}.allowedCommands`);
  if (override.deniedCommands) out.deniedCommands = compilePatterns(override.deniedCommands, `${fieldPath}.deniedCommands`);
  if (override.allowedRemotePaths) out.allowedRemotePaths = compileAllowedRoots(override.allowedRemotePaths, `${fieldPath}.allowedRemotePaths`);
  if (override.readOnlyMode !== undefined) out.readOnlyMode = override.readOnlyMode;
  return out;
}

export function compilePolicy(config: PolicyConfig): CompiledPolicy {
  const defaults: CompiledPolicySet = {
    allowedCommands: compilePatterns(config.allowedCommands, "policy.allowedCommands"),
    deniedCommands: compilePatterns(config.deniedCommands, "policy.deniedCommands"),
    allowedRemotePaths: compileAllowedRoots(config.allowedRemotePaths, "policy.allowedRemotePaths"),
    readOnlyMode: config.readOnlyMode,
  };

  const profiles: Record<string, CompiledPolicyOverride> = {};
  for (const [profileName, override] of Object.entries(config.profiles)) {
    profiles[profileName] = compileOverride(override, `policy.profiles.${profileName}`);
  }

  return { defaults, profiles };
}

export function resolvePolicyForProfile(policy: CompiledPolicy, profileName: string): EffectivePolicy {
  const name = profileName.trim();
  if (!name) {
    throw new Error("profileName must be a non-empty string.");
  }

  const override = policy.profiles[name];
  const effectiveAllowed = override?.allowedCommands ?? policy.defaults.allowedCommands;
  const effectiveDenied = override?.deniedCommands ?? policy.defaults.deniedCommands;
  const effectiveRoots = override?.allowedRemotePaths ?? policy.defaults.allowedRemotePaths;
  const readOnlyMode = override?.readOnlyMode ?? policy.defaults.readOnlyMode;

  return {
    profileName: name,
    allowedCommands: effectiveAllowed.map((p) => p.regex),
    deniedCommands: effectiveDenied.map((p) => p.regex),
    allowedRemotePaths: [...effectiveRoots],
    readOnlyMode,
  };
}

function normalizeRuntimeRemotePath(remotePath: string): string {
  const trimmed = remotePath.trim();
  if (!trimmed) {
    throw new Error("Remote path cannot be empty.");
  }
  if (trimmed.includes("\0")) {
    throw new Error("Remote path cannot contain a null byte.");
  }
  if (trimmed.includes("\\")) {
    throw new Error("Remote path must use POSIX separators ('/'), not '\\'.");
  }
  if (!trimmed.startsWith("/")) {
    throw new Error(`Remote path '${remotePath}' must be absolute (start with '/').`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (!normalized.startsWith("/")) {
    throw new Error(`Remote path '${remotePath}' resolved outside absolute space.`);
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function isWithinRoot(candidate: string, root: string): boolean {
  if (root === "/") return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function assertCommandAllowed(policy: EffectivePolicy, command: string): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command cannot be empty.");
  }

  for (const regex of policy.deniedCommands) {
    if (regex.test(command)) {
      throw new Error(`Command blocked by deniedCommands policy (pattern: ${regex.source}).`);
    }
  }

  if (policy.allowedCommands.length > 0) {
    const allowed = policy.allowedCommands.some((regex) => regex.test(command));
    if (!allowed) {
      throw new Error("Command blocked: it does not match allowedCommands policy.");
    }
  }
}

export function assertPathAllowed(policy: EffectivePolicy, remotePath: string, options: PathPolicyOptions = {}): string {
  const op = options.operation?.trim() || (options.write ? "Write operation" : "Path operation");

  if (options.write && policy.readOnlyMode) {
    throw new Error(`${op} blocked: readOnlyMode is enabled for profile '${policy.profileName}'.`);
  }

  const normalized = normalizeRuntimeRemotePath(remotePath);
  if (policy.allowedRemotePaths.length === 0) return normalized;

  const isAllowed = policy.allowedRemotePaths.some((root) => isWithinRoot(normalized, root));
  if (!isAllowed) {
    throw new Error(`${op} blocked: path '${normalized}' is outside allowedRemotePaths.`);
  }
  return normalized;
}

export function assertWriteAllowed(policy: EffectivePolicy, operation = "Write operation"): void {
  if (policy.readOnlyMode) {
    throw new Error(`${operation} blocked: readOnlyMode is enabled for profile '${policy.profileName}'.`);
  }
}

