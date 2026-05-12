/**
 * config.ts
 *
 * Runtime SSH server profile management.
 *
 * Profiles are loaded from:
 *   1) SSH_SERVERS_FILE JSON (default: ~/.ssh-mcp/servers.json)
 *   2) Environment fallback (SSH_HOST/SSH_USER/...)
 *
 * This keeps backward compatibility with env-based setups while enabling
 * adding/switching/removing servers at runtime.
 */
import type { ConnectConfig } from "ssh2";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface StoredServer {
  host: string;
  username: string;
  port: number;
  password?: string;
  keyPath?: string;
}

interface StoredConfigFile {
  version: number;
  active: string;
  servers: Record<string, Partial<StoredServer>>;
}

export interface ServerProfile {
  name: string;
  host: string;
  username: string;
  port: number;
  password?: string;
  keyPath?: string;
}

export interface AddServerInput {
  name: string;
  host: string;
  username: string;
  port?: number;
  password?: string;
  keyPath?: string;
  overwrite?: boolean;
  setActive?: boolean;
}

const configFilePath = process.env.SSH_SERVERS_FILE?.trim() || path.join(os.homedir(), ".ssh-mcp", "servers.json");
const servers = new Map<string, StoredServer>();
let activeServerName = "";
const warnedNoAuth = new Set<string>();

function normalizePort(port: number | undefined): number {
  if (port === undefined) return 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SSH port: ${port}`);
  }
  return port;
}

function normalizeServer(input: Partial<StoredServer>): StoredServer {
  if (!input.host || !input.username) {
    throw new Error("Server profile requires host and username.");
  }
  const s: StoredServer = {
    host: input.host.trim(),
    username: input.username.trim(),
    port: normalizePort(input.port),
  };
  if (input.password) s.password = input.password;
  if (input.keyPath) s.keyPath = input.keyPath;
  return s;
}

function persist(): void {
  const payload: StoredConfigFile = { version: 1, active: activeServerName, servers: {} };
  for (const [name, server] of servers) {
    payload.servers[name] = { ...server };
  }
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  fs.writeFileSync(configFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function tryLoadFromFile(): void {
  if (!fs.existsSync(configFilePath)) return;

  const raw = fs.readFileSync(configFilePath, "utf8");
  if (!raw.trim()) return;
  const parsed = JSON.parse(raw) as StoredConfigFile;

  if (!parsed || typeof parsed !== "object" || !parsed.servers || typeof parsed.servers !== "object") {
    throw new Error(`Invalid server config file format: ${configFilePath}`);
  }

  for (const [name, value] of Object.entries(parsed.servers)) {
    servers.set(name, normalizeServer(value));
  }
  if (typeof parsed.active === "string" && parsed.active) {
    activeServerName = parsed.active;
  }
}

function tryLoadFromEnv(): void {
  const host = process.env.SSH_HOST?.trim();
  const username = process.env.SSH_USER?.trim();
  if (!host || !username) return;

  const name = process.env.SSH_PROFILE?.trim() || "default";
  const fromEnvInput: Partial<StoredServer> = {
    host,
    username,
    port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22,
  };
  if (process.env.SSH_PASSWORD) fromEnvInput.password = process.env.SSH_PASSWORD;
  if (process.env.SSH_KEY_PATH) fromEnvInput.keyPath = process.env.SSH_KEY_PATH;
  const fromEnv = normalizeServer(fromEnvInput);

  if (!servers.has(name)) {
    servers.set(name, fromEnv);
    if (!activeServerName) activeServerName = name;
  }
}

function initialize(): void {
  try {
    tryLoadFromFile();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: Failed to load ${configFilePath}: ${msg}\n`);
    process.exit(1);
  }

  try {
    tryLoadFromEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: Invalid SSH_* environment config: ${msg}\n`);
    process.exit(1);
  }

  if (servers.size > 0 && (!activeServerName || !servers.has(activeServerName))) {
    activeServerName = servers.keys().next().value as string;
  }
}

initialize();

function requireServer(name: string): StoredServer {
  if (!name) {
    throw new Error("No active server profile configured. Add one with ssh_server_add.");
  }
  const profile = servers.get(name);
  if (!profile) throw new Error(`Unknown server profile '${name}'.`);
  return profile;
}

export function getServersFilePath(): string {
  return configFilePath;
}

export function listServerProfiles(): ServerProfile[] {
  return [...servers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, profile]) => ({ name, ...profile }));
}

export function getActiveServerName(): string {
  return activeServerName;
}

export function getActiveServerProfile(): ServerProfile {
  return { name: activeServerName, ...requireServer(activeServerName) };
}

export function addServerProfile(input: AddServerInput): ServerProfile {
  const name = input.name.trim();
  if (!name) throw new Error("Server profile name cannot be empty.");
  if (servers.has(name) && !input.overwrite) {
    throw new Error(`Server profile '${name}' already exists. Pass overwrite=true to replace it.`);
  }

  const normalizedInput: Partial<StoredServer> = {
    host: input.host.trim(),
    username: input.username.trim(),
  };
  if (input.port !== undefined) normalizedInput.port = input.port;
  if (input.password) normalizedInput.password = input.password;
  if (input.keyPath) normalizedInput.keyPath = input.keyPath;
  const normalized = normalizeServer(normalizedInput);

  if (normalized.keyPath && !fs.existsSync(normalized.keyPath)) {
    throw new Error(`SSH key file not found: ${normalized.keyPath}`);
  }

  servers.set(name, normalized);
  if (input.setActive || !activeServerName) activeServerName = name;
  persist();
  return { name, ...normalized };
}

export function useServerProfile(name: string): ServerProfile {
  const profile = requireServer(name);
  activeServerName = name;
  persist();
  return { name, ...profile };
}

export function removeServerProfile(name: string): { removed: string; active: string } {
  if (!servers.has(name)) throw new Error(`Unknown server profile '${name}'.`);
  if (servers.size === 1) {
    throw new Error("Cannot remove the only server profile. Add another profile first.");
  }

  servers.delete(name);
  if (activeServerName === name) {
    activeServerName = servers.keys().next().value as string;
  }
  persist();
  return { removed: name, active: activeServerName };
}

export function getActiveSshConfig(): ConnectConfig {
  const p = requireServer(activeServerName);
  const auth: Partial<ConnectConfig> =
    p.password
      ? { password: p.password }
      : p.keyPath
      ? { privateKey: fs.readFileSync(p.keyPath) }
      : {};

  if (!p.password && !p.keyPath && !warnedNoAuth.has(activeServerName)) {
    warnedNoAuth.add(activeServerName);
    process.stderr.write(
      `WARN: Active profile '${activeServerName}' has no password or keyPath configured; connection may fail.\n`
    );
  }

  return {
    host: p.host,
    port: p.port,
    username: p.username,
    readyTimeout: 10000,
    ...auth,
  };
}
