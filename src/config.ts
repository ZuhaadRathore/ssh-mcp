/**
 * config.ts
 *
 * Reads SSH connection parameters from environment variables and builds the
 * ConnectConfig object used everywhere else. Exits immediately at startup if
 * the required SSH_HOST / SSH_USER variables are missing.
 *
 * Supported env vars:
 *   SSH_HOST       — remote hostname or IP (required)
 *   SSH_USER       — remote username (required)
 *   SSH_PORT       — remote port (default: 22)
 *   SSH_PASSWORD   — password auth (takes precedence over key)
 *   SSH_KEY_PATH   — path to a PEM private key file
 */
import type { ConnectConfig } from "ssh2";
import * as fs from "fs";

const sshHost = process.env.SSH_HOST;
const sshUser = process.env.SSH_USER;

if (!sshHost || !sshUser) {
  process.stderr.write("ERROR: SSH_HOST and SSH_USER environment variables are required.\n");
  process.exit(1);
}

const auth: Partial<ConnectConfig> = process.env.SSH_PASSWORD
  ? { password: process.env.SSH_PASSWORD }
  : process.env.SSH_KEY_PATH
  ? { privateKey: fs.readFileSync(process.env.SSH_KEY_PATH) }
  : {};

if (!process.env.SSH_PASSWORD && !process.env.SSH_KEY_PATH) {
  process.stderr.write("WARN: No SSH_PASSWORD or SSH_KEY_PATH set — connection will likely fail.\n");
}

export const sshConfig: ConnectConfig = {
  host: sshHost,
  port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22,
  username: sshUser,
  readyTimeout: 10000,
  ...auth,
};
