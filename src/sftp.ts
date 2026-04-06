/**
 * sftp.ts
 *
 * SFTP subsystem singleton. A single SFTPWrapper is reused for all file
 * operations; a new one is opened on demand if none exists.
 *
 * The session is cleared (not explicitly ended) when the SSH connection drops,
 * via onConnectionClose(). The next getSftp() call will open a fresh session
 * against the new connection.
 */
import type { SFTPWrapper } from "ssh2";
import { getConnection, onConnectionClose } from "./connection.js";

let session: SFTPWrapper | null = null;

/** Return the current SFTPWrapper, or null if none is open. */
export function getSftpSession(): SFTPWrapper | null {
  return session;
}

/** Resolve with the active SFTPWrapper, opening one against the current connection if needed. */
export async function getSftp(): Promise<SFTPWrapper> {
  if (session) return session;
  const client = await getConnection();
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      session = sftp;
      resolve(sftp);
    });
  });
}

/** End the SFTP session and clear the singleton. */
export function closeSftp(): void {
  try { session?.end(); } catch {}
  session = null;
}

// Clear SFTP session when SSH connection drops — it's no longer usable
onConnectionClose(() => { session = null; });
