/**
 * policy-config.ts
 *
 * Strict parsing and validation for the security policy configuration.
 *
 * The policy has global defaults plus optional per-profile overrides.
 */

export interface PolicyRuleOverride {
  allowedCommands?: string[];
  deniedCommands?: string[];
  allowedRemotePaths?: string[];
  readOnlyMode?: boolean;
}

export interface PolicyConfig {
  allowedCommands: string[];
  deniedCommands: string[];
  allowedRemotePaths: string[];
  readOnlyMode: boolean;
  profiles: Record<string, PolicyRuleOverride>;
}

const RULE_KEYS = new Set<keyof PolicyRuleOverride>([
  "allowedCommands",
  "deniedCommands",
  "allowedRemotePaths",
  "readOnlyMode",
]);

const TOP_LEVEL_KEYS = new Set<string>(["allowedCommands", "deniedCommands", "allowedRemotePaths", "readOnlyMode", "profiles"]);

function fail(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainObject(value: unknown, location: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`${location} must be an object.`);
  }
  return value;
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, location: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail(`${location} contains unknown key '${key}'.`);
    }
  }
}

function parseRegexList(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${fieldPath} must be an array of regex strings.`);
  }

  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      fail(`${fieldPath}[${i}] must be a string.`);
    }
    if (!entry.trim()) {
      fail(`${fieldPath}[${i}] cannot be empty.`);
    }
    try {
      // Compile to validate syntax now; runtime compilation happens in policy.ts.
      // eslint-disable-next-line no-new
      new RegExp(entry);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`${fieldPath}[${i}] is not a valid regex: ${msg}`);
    }
    return entry;
  });
}

function parseAllowedPaths(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${fieldPath} must be an array of POSIX absolute paths.`);
  }

  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      fail(`${fieldPath}[${i}] must be a string.`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      fail(`${fieldPath}[${i}] cannot be empty.`);
    }
    if (trimmed.includes("\0")) {
      fail(`${fieldPath}[${i}] cannot contain a null byte.`);
    }
    if (trimmed.includes("\\")) {
      fail(`${fieldPath}[${i}] must use POSIX separators ('/'), not '\\'.`);
    }
    if (!trimmed.startsWith("/")) {
      fail(`${fieldPath}[${i}] must be an absolute path starting with '/'.`);
    }
    return trimmed;
  });
}

function parseRuleOverride(value: unknown, location: string): PolicyRuleOverride {
  const obj = assertPlainObject(value, location);
  assertKnownKeys(obj, RULE_KEYS as unknown as Set<string>, location);

  const out: PolicyRuleOverride = {};
  if ("allowedCommands" in obj) out.allowedCommands = parseRegexList(obj.allowedCommands, `${location}.allowedCommands`);
  if ("deniedCommands" in obj) out.deniedCommands = parseRegexList(obj.deniedCommands, `${location}.deniedCommands`);
  if ("allowedRemotePaths" in obj) out.allowedRemotePaths = parseAllowedPaths(obj.allowedRemotePaths, `${location}.allowedRemotePaths`);
  if ("readOnlyMode" in obj) {
    if (typeof obj.readOnlyMode !== "boolean") {
      fail(`${location}.readOnlyMode must be a boolean.`);
    }
    out.readOnlyMode = obj.readOnlyMode;
  }
  return out;
}

export function parsePolicyConfig(input: unknown): PolicyConfig {
  const obj = assertPlainObject(input, "policy");
  assertKnownKeys(obj, TOP_LEVEL_KEYS, "policy");

  const rootFieldsOnly: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    if (key in obj) rootFieldsOnly[key] = obj[key];
  }
  const rootOverride = parseRuleOverride(rootFieldsOnly, "policy");
  const profiles: Record<string, PolicyRuleOverride> = {};

  if ("profiles" in obj) {
    const profileObj = assertPlainObject(obj.profiles, "policy.profiles");
    for (const [name, value] of Object.entries(profileObj)) {
      const trimmed = name.trim();
      if (!trimmed) {
        fail("policy.profiles contains an empty profile name.");
      }
      if (trimmed !== name) {
        fail(`policy.profiles key '${name}' has leading/trailing whitespace.`);
      }
      profiles[name] = parseRuleOverride(value, `policy.profiles.${name}`);
    }
  }

  return {
    allowedCommands: rootOverride.allowedCommands ?? [],
    deniedCommands: rootOverride.deniedCommands ?? [],
    allowedRemotePaths: rootOverride.allowedRemotePaths ?? [],
    readOnlyMode: rootOverride.readOnlyMode ?? false,
    profiles,
  };
}
