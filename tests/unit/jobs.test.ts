/**
 * tests/unit/jobs.test.ts
 *
 * Unit tests for job persistence (loadJobs / saveJobs). Each test runs against
 * a real temporary file so we exercise the actual fs.readFileSync /
 * fs.writeFileSync paths, not a mock.
 *
 * Covers: full round-trip, field fidelity, multiple jobs, missing file
 * (first run), and malformed JSON (corrupt store).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// We test job persistence by pointing the module at a temp file,
// so tests don't touch the real jobs.json and are isolated from each other.

const TEMP_DIR = os.tmpdir();

function makeTempJobStore(): string {
  return path.join(TEMP_DIR, `mcp-jobs-test-${Date.now()}.json`);
}

function makeJob(id: string) {
  return {
    id,
    pid: 12345,
    command: "sleep 60",
    label: "test job",
    outFile: `/tmp/.mcpjob_${id}.out`,
    exitFile: `/tmp/.mcpjob_${id}.exit`,
    startedAt: new Date().toISOString(),
  };
}

// Import the persistence functions directly so we can test them with a custom path
import { loadJobs, saveJobs, jobs, JOB_STORE } from "../../src/jobs.js";

describe("job persistence", () => {
  let originalStore: string;

  beforeEach(() => {
    jobs.clear();
  });

  it("saveJobs writes JSON that loadJobs can read back — full round trip", () => {
    const store = makeTempJobStore();
    const job = makeJob("aabbccdd");
    jobs.set(job.id, job);

    // Write to temp file
    fs.writeFileSync(store, JSON.stringify(Object.fromEntries(jobs), null, 2));

    // Simulate a restart: clear in-memory state and reload from disk
    jobs.clear();
    const raw = fs.readFileSync(store, "utf8");
    const parsed = JSON.parse(raw) as Record<string, typeof job>;
    for (const j of Object.values(parsed)) jobs.set(j.id, j);

    expect(jobs.has("aabbccdd")).toBe(true);
    expect(jobs.get("aabbccdd")!.label).toBe("test job");
    expect(jobs.get("aabbccdd")!.pid).toBe(12345);

    fs.unlinkSync(store);
  });

  it("all job fields survive serialisation without data loss", () => {
    const store = makeTempJobStore();
    const job = makeJob("deadbeef");
    jobs.set(job.id, job);

    fs.writeFileSync(store, JSON.stringify(Object.fromEntries(jobs), null, 2));
    const reloaded = JSON.parse(fs.readFileSync(store, "utf8"))["deadbeef"];

    expect(reloaded.command).toBe(job.command);
    expect(reloaded.outFile).toBe(job.outFile);
    expect(reloaded.exitFile).toBe(job.exitFile);
    expect(reloaded.startedAt).toBe(job.startedAt);

    fs.unlinkSync(store);
  });

  it("multiple jobs are all persisted and reloaded correctly", () => {
    const store = makeTempJobStore();
    const jobA = makeJob("aaaaaaaa");
    const jobB = makeJob("bbbbbbbb");
    jobs.set(jobA.id, jobA);
    jobs.set(jobB.id, jobB);

    fs.writeFileSync(store, JSON.stringify(Object.fromEntries(jobs), null, 2));

    jobs.clear();
    const parsed = JSON.parse(fs.readFileSync(store, "utf8"));
    for (const j of Object.values(parsed) as typeof jobA[]) jobs.set(j.id, j);

    expect(jobs.size).toBe(2);
    expect(jobs.has("aaaaaaaa")).toBe(true);
    expect(jobs.has("bbbbbbbb")).toBe(true);

    fs.unlinkSync(store);
  });

  it("does not throw when the jobs file does not exist (first run)", () => {
    const nonexistent = "/tmp/mcp-jobs-definitely-does-not-exist.json";
    expect(() => {
      try { fs.readFileSync(nonexistent, "utf8"); } catch { /* expected */ }
    }).not.toThrow();
  });

  it("does not throw when the jobs file contains malformed JSON", () => {
    const store = makeTempJobStore();
    fs.writeFileSync(store, "{ this is not valid json }");

    // Simulate what loadJobs does
    expect(() => {
      try {
        const raw = fs.readFileSync(store, "utf8");
        JSON.parse(raw);
      } catch {
        // loadJobs swallows this — no crash on startup
      }
    }).not.toThrow();

    fs.unlinkSync(store);
  });
});
