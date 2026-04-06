/**
 * jobs.ts
 *
 * In-memory registry and disk persistence for background jobs started with
 * ssh_exec_bg. Jobs are written to jobs.json (next to the built binary) on
 * every create and kill, so they survive MCP server restarts.
 *
 * The file is loaded automatically on module import via the loadJobs() call
 * at the bottom of this file.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const JOB_STORE = path.join(__dirname, "..", "jobs.json");

export interface Job {
  id: string;
  pid: number;
  command: string;
  label: string;
  outFile: string;
  exitFile: string;
  startedAt: string;
}

export const jobs = new Map<string, Job>();

/** Load persisted jobs from JOB_STORE into the in-memory map. Silently no-ops if the file is missing or corrupt. */
export function loadJobs(): void {
  try {
    const raw = fs.readFileSync(JOB_STORE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, Job>;
    for (const job of Object.values(parsed)) jobs.set(job.id, job);
  } catch {
    // File doesn't exist yet or is malformed — start fresh
  }
}

/** Persist the current jobs map to JOB_STORE. Logs a warning on write failure but does not throw. */
export function saveJobs(): void {
  try {
    fs.writeFileSync(JOB_STORE, JSON.stringify(Object.fromEntries(jobs), null, 2));
  } catch (err) {
    process.stderr.write(`WARN: Could not save jobs.json: ${err}\n`);
  }
}

loadJobs();
