/**
 * tests/unit/shell-parser.test.ts
 *
 * Unit tests for parseMarkerOutput() — the pure function that scans the raw
 * SSH data stream for our exit marker and extracts stdout + exit code.
 *
 * This is the most critical logic in the project: a bug here causes commands
 * to hang forever or silently report wrong exit codes. The tests cover all
 * edge cases including incomplete buffers, non-zero exits, NaN corruption
 * (regression for the original parseInt() || 0 bug), and multiple commands
 * whose output arrives in the same buffer chunk.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  sshConfig: { host: "test", port: 22, username: "test" },
}));

import { parseMarkerOutput } from "../../src/shell.js";

// parseMarkerOutput is the heart of the persistent shell — it scans the raw
// byte stream for our exit marker and extracts stdout + exit code.
// Bugs here cause silent data corruption or commands that never complete.

const TOKEN = "abc123";

describe("parseMarkerOutput()", () => {
  it("returns null when the marker is not yet in the buffer (command still running)", () => {
    expect(parseMarkerOutput("some output so far\n", TOKEN)).toBeNull();
  });

  it("returns null when the marker is present but the line is incomplete (still receiving data)", () => {
    // Marker appeared but the \n hasn't arrived yet
    const buf = `output\n__MCPEXIT_${TOKEN}_0`; // no trailing newline
    expect(parseMarkerOutput(buf, TOKEN)).toBeNull();
  });

  it("extracts stdout and exit code 0 from a well-formed buffer", () => {
    const buf = `hello world\n__MCPEXIT_${TOKEN}_0\n`;
    const result = parseMarkerOutput(buf, TOKEN);
    expect(result).not.toBeNull();
    expect(result!.stdout).toBe("hello world");
    expect(result!.code).toBe(0);
  });

  it("correctly extracts a non-zero exit code", () => {
    const buf = `__MCPEXIT_${TOKEN}_127\n`;
    const result = parseMarkerOutput(buf, TOKEN);
    expect(result!.code).toBe(127);
  });

  it("returns -1 for exit code when the marker line is malformed — not 0 (regression: was parseInt() || 0)", () => {
    // If something corrupts the exit code field, we must not silently report success
    const buf = `__MCPEXIT_${TOKEN}_NaN\n`;
    const result = parseMarkerOutput(buf, TOKEN);
    expect(result!.code).toBe(-1);
  });

  it("handles a command that produces no output", () => {
    const buf = `__MCPEXIT_${TOKEN}_0\n`;
    const result = parseMarkerOutput(buf, TOKEN);
    expect(result!.stdout).toBe("");
    expect(result!.code).toBe(0);
  });

  it("trims leading/trailing whitespace from stdout", () => {
    const buf = `\n\nsome output\n\n__MCPEXIT_${TOKEN}_0\n`;
    expect(parseMarkerOutput(buf, TOKEN)!.stdout).toBe("some output");
  });

  it("preserves remaining buffer content after the marker for the next command", () => {
    // The shell can send the next command's output before we've processed this marker
    const buf = `output\n__MCPEXIT_${TOKEN}_0\nnext command output\n`;
    const result = parseMarkerOutput(buf, TOKEN);
    expect(result!.remaining).toBe("next command output\n");
  });

  it("does not match a different token — tokens are per-command random hex", () => {
    const buf = `output\n__MCPEXIT_different_0\n`;
    expect(parseMarkerOutput(buf, TOKEN)).toBeNull();
  });

  it("handles multi-line stdout correctly", () => {
    const buf = `line1\nline2\nline3\n__MCPEXIT_${TOKEN}_0\n`;
    const result = parseMarkerOutput(buf, TOKEN);
    expect(result!.stdout).toBe("line1\nline2\nline3");
  });
});
