import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ParsedConfigHost {
  pattern: string;
  isWildcard: boolean;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  sourcePath: string;
}

export interface ParsedKnownHost {
  host: string;
  port?: number;
  sourcePath: string;
}

export interface DiscoveredHost {
  name: string;
  aliases: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  sources: Array<"ssh_config" | "known_hosts">;
  configPath?: string;
  knownHostsPath?: string;
}

export interface DiscoveryOptions {
  configPath?: string;
  knownHostsPath?: string;
  includeWildcardHosts?: boolean;
}

export interface HostInfoResult {
  query: string;
  host?: DiscoveredHost;
  candidates: DiscoveredHost[];
}

export interface ConnectivityCheckInput {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  timeoutSec?: number;
  probeCommand?: string;
}

export function getDefaultSshConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

export function getDefaultKnownHostsPath(): string {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

export function parseSshConfig(content: string, sourcePath = "<memory>"): ParsedConfigHost[] {
  const lines = content.split(/\r?\n/);
  const discovered: ParsedConfigHost[] = [];
  const globalDefaults: Partial<ParsedConfigHost> = {};
  let currentPatterns: string[] = [];
  let inHostBlock = false;
  let currentOptions: Partial<ParsedConfigHost> = {};

  const flush = (): void => {
    if (!inHostBlock || currentPatterns.length === 0) return;
    for (const pattern of currentPatterns) {
      const merged: ParsedConfigHost = {
        pattern,
        isWildcard: hasWildcard(pattern),
        sourcePath,
      };
      const hostName = currentOptions.hostName ?? globalDefaults.hostName;
      if (hostName !== undefined) merged.hostName = hostName;
      const user = currentOptions.user ?? globalDefaults.user;
      if (user !== undefined) merged.user = user;
      const port = currentOptions.port ?? globalDefaults.port;
      if (port !== undefined) merged.port = port;
      const identityFile = currentOptions.identityFile ?? globalDefaults.identityFile;
      if (identityFile !== undefined) merged.identityFile = expandHomePath(identityFile);
      const proxyJump = currentOptions.proxyJump ?? globalDefaults.proxyJump;
      if (proxyJump !== undefined) merged.proxyJump = proxyJump;
      discovered.push(merged);
    }
    currentPatterns = [];
    currentOptions = {};
  };

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s*(?:=|\s)\s*(.+)$/);
    if (!match) continue;
    const keyRaw = match[1];
    const valueRaw = match[2];
    if (!keyRaw || !valueRaw) continue;
    const key = keyRaw.toLowerCase();
    const value = valueRaw.trim();

    if (key === "host") {
      flush();
      currentPatterns = value.split(/\s+/).filter(Boolean);
      inHostBlock = true;
      continue;
    }

    const target = inHostBlock ? currentOptions : globalDefaults;
    applyOption(target, key, value);
  }

  flush();
  return discovered;
}

export function parseKnownHosts(content: string, sourcePath = "<memory>"): ParsedKnownHost[] {
  const discovered: ParsedKnownHost[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const first = parts[0];
    if (!first) continue;
    let hostField = first;
    if (hostField.startsWith("@")) {
      if (parts.length < 3) continue;
      const withMarker = parts[1];
      if (!withMarker) continue;
      hostField = withMarker;
    }
    if (hostField.startsWith("|")) continue;

    for (const candidate of hostField.split(",")) {
      const parsed = parseKnownHostToken(candidate.trim());
      if (!parsed) continue;
      const key = `${parsed.host.toLowerCase()}::${parsed.port ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push({
        host: parsed.host,
        ...(parsed.port !== undefined ? { port: parsed.port } : {}),
        sourcePath,
      });
    }
  }

  return discovered;
}

export function discoverHosts(options: DiscoveryOptions = {}): DiscoveredHost[] {
  const configPath = options.configPath ?? getDefaultSshConfigPath();
  const knownHostsPath = options.knownHostsPath ?? getDefaultKnownHostsPath();
  const includeWildcardHosts = options.includeWildcardHosts ?? false;
  const configEntries = parseSshConfig(readUtf8IfExists(configPath), configPath);
  const knownEntries = parseKnownHosts(readUtf8IfExists(knownHostsPath), knownHostsPath);
  const index = new Map<string, DiscoveredHost>();

  for (const entry of configEntries) {
    if (!includeWildcardHosts && entry.isWildcard) continue;
    const key = entry.pattern.toLowerCase();
    const existing = index.get(key);
    if (!existing) {
      const aliases = [entry.pattern];
      const hostName = entry.hostName;
      if (hostName && !aliases.some(a => a.toLowerCase() === hostName.toLowerCase())) aliases.push(hostName);
      index.set(key, {
        name: entry.pattern,
        aliases,
        ...(entry.hostName ? { hostName: entry.hostName } : {}),
        ...(entry.user ? { user: entry.user } : {}),
        ...(entry.port !== undefined ? { port: entry.port } : {}),
        ...(entry.identityFile ? { identityFile: entry.identityFile } : {}),
        ...(entry.proxyJump ? { proxyJump: entry.proxyJump } : {}),
        sources: ["ssh_config"],
        configPath: entry.sourcePath,
      });
      continue;
    }

    if (!existing.sources.includes("ssh_config")) existing.sources.push("ssh_config");
    if (entry.hostName && !existing.hostName) existing.hostName = entry.hostName;
    if (entry.user && !existing.user) existing.user = entry.user;
    if (entry.port !== undefined && existing.port === undefined) existing.port = entry.port;
    if (entry.identityFile && !existing.identityFile) existing.identityFile = entry.identityFile;
    if (entry.proxyJump && !existing.proxyJump) existing.proxyJump = entry.proxyJump;
    if (!existing.aliases.some(a => a.toLowerCase() === entry.pattern.toLowerCase())) existing.aliases.push(entry.pattern);
    const hostName = entry.hostName;
    if (hostName && !existing.aliases.some(a => a.toLowerCase() === hostName.toLowerCase())) {
      existing.aliases.push(hostName);
    }
  }

  for (const entry of knownEntries) {
    const key = entry.host.toLowerCase();
    const existing = index.get(key);
    if (!existing) {
      index.set(key, {
        name: entry.host,
        aliases: [entry.host],
        ...(entry.port !== undefined ? { port: entry.port } : {}),
        sources: ["known_hosts"],
        knownHostsPath: entry.sourcePath,
      });
      continue;
    }

    if (!existing.sources.includes("known_hosts")) existing.sources.push("known_hosts");
    if (existing.port === undefined && entry.port !== undefined) existing.port = entry.port;
    if (!existing.knownHostsPath) existing.knownHostsPath = entry.sourcePath;
    if (!existing.aliases.some(a => a.toLowerCase() === entry.host.toLowerCase())) existing.aliases.push(entry.host);
  }

  return [...index.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getHostInfo(query: string, options: DiscoveryOptions = {}): HostInfoResult {
  const needle = query.trim().toLowerCase();
  const all = discoverHosts(options);
  const candidates = all.filter(
    host =>
      host.name.toLowerCase() === needle ||
      host.aliases.some(alias => alias.toLowerCase() === needle) ||
      host.hostName?.toLowerCase() === needle
  );

  if (candidates.length === 1) {
    const single = candidates[0];
    if (single) return { query, host: single, candidates };
  }
  return { query, candidates };
}

export function buildConnectivityCheckCommand(input: ConnectivityCheckInput): string {
  const timeoutSec = normalizeTimeout(input.timeoutSec);
  const probe = input.probeCommand?.trim() || "echo mcp-ok";
  const args: string[] = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${timeoutSec}`,
  ];
  if (input.identityFile) args.push("-i", shellQuote(expandHomePath(input.identityFile)));
  if (input.port !== undefined) args.push("-p", String(input.port));
  const destination = input.user ? `${input.user}@${input.host}` : input.host;
  args.push(shellQuote(destination), shellQuote(probe));
  return args.join(" ");
}

function applyOption(target: Partial<ParsedConfigHost>, key: string, value: string): void {
  // Preserve the first value encountered for each option to better match OpenSSH behavior.
  if (key === "hostname") {
    if (!target.hostName) target.hostName = value;
    return;
  }
  if (key === "user") {
    if (!target.user) target.user = value;
    return;
  }
  if (key === "port") {
    if (target.port !== undefined) return;
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) target.port = parsed;
    return;
  }
  if (key === "identityfile") {
    if (!target.identityFile) target.identityFile = value;
    return;
  }
  if (key === "proxyjump") {
    if (!target.proxyJump) target.proxyJump = value;
  }
}

function hasWildcard(pattern: string): boolean {
  return /[*?!]/.test(pattern);
}

function parseKnownHostToken(token: string): { host: string; port?: number } | null {
  if (!token) return null;

  if (token.startsWith("[") && token.includes("]:")) {
    const closeBracket = token.indexOf("]");
    if (closeBracket > 1) {
      const host = token.slice(1, closeBracket);
      const portPart = token.slice(closeBracket + 2);
      const port = Number.parseInt(portPart, 10);
      if (host && Number.isInteger(port) && port > 0 && port <= 65535) return { host, port };
      if (host) return { host };
    }
  }

  const cleaned = token.replace(/^\[|\]$/g, "");
  if (!cleaned) return null;
  return { host: cleaned };
}

function stripInlineComment(line: string): string {
  return line.replace(/\s+#.*$/, "");
}

function readUtf8IfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeTimeout(timeoutSec: number | undefined): number {
  if (timeoutSec === undefined) return 5;
  if (!Number.isFinite(timeoutSec)) return 5;
  return Math.max(1, Math.min(60, Math.floor(timeoutSec)));
}

function expandHomePath(p: string): string {
  if (!p) return p;
  if (!p.startsWith("~")) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
