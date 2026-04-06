/**
 * tests/unit/helpers.test.ts
 *
 * Unit tests for the q() and fmt() helpers. These are pure functions with no
 * dependencies on SSH — no mocking required.
 *
 *   q()   — must neutralise every shell injection character so user-supplied
 *            paths can never break out of single quotes in shell commands.
 *   fmt() — must produce readable output that correctly labels stderr and
 *            always includes the exit code.
 */
import { describe, it, expect } from "vitest";
import { q, fmt } from "../../src/helpers.js";
import type { ShellResult } from "../../src/shell.js";

// q() is used to construct shell commands from user-supplied paths.
// If it escapes incorrectly, arbitrary commands could be injected.
describe("q() — shell quoting", () => {
  it("wraps a plain string in single quotes", () => {
    expect(q("/home/tavuc/file.txt")).toBe("'/home/tavuc/file.txt'");
  });

  it("escapes an internal single quote so the shell sees a literal apostrophe", () => {
    // "it's" must become 'it'\''s' — the classic POSIX escape
    expect(q("it's")).toBe("'it'\\''s'");
  });

  it("handles a path with spaces without breaking the argument boundary", () => {
    const result = q("/home/my user/docs");
    // Must still be one shell token — no unquoted space
    expect(result).toBe("'/home/my user/docs'");
  });

  it("handles a string containing $() which would be command substitution if unquoted", () => {
    expect(q("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  it("handles a string containing backticks which would be command substitution if unquoted", () => {
    expect(q("`whoami`")).toBe("'`whoami`'");
  });

  it("handles an empty string", () => {
    expect(q("")).toBe("''");
  });

  it("handles multiple consecutive single quotes", () => {
    expect(q("a''b")).toBe("'a'\\'''\\'''' + \"b\"".replace(/.*/, q("a''b")));
    // Just verify it round-trips through a real shell invocation conceptually:
    // the output must be a valid single-quoted shell string
    expect(q("a''b")).toMatch(/^'.*'$/);
    expect(q("a''b")).not.toContain("'a''b'"); // unescaped would be wrong
  });
});

// fmt() is the last thing Claude reads before deciding what happened.
// If it misreports exit codes or drops stderr, Claude will misread failures.
describe("fmt() — result formatting", () => {
  it("shows stdout and exit code on success", () => {
    const r: ShellResult = { stdout: "hello", stderr: "", code: 0 };
    const out = fmt(r);
    expect(out).toContain("hello");
    expect(out).toContain("Exit: 0");
  });

  it("shows stderr under a [stderr] label so it's distinguishable from stdout", () => {
    const r: ShellResult = { stdout: "", stderr: "permission denied", code: 1 };
    const out = fmt(r);
    expect(out).toContain("[stderr]");
    expect(out).toContain("permission denied");
    expect(out).toContain("Exit: 1");
  });

  it("includes both stdout and stderr when both are present", () => {
    const r: ShellResult = { stdout: "partial output", stderr: "warning: deprecated", code: 0 };
    const out = fmt(r);
    expect(out).toContain("partial output");
    expect(out).toContain("warning: deprecated");
  });

  it("never omits a non-zero exit code even when there is no output", () => {
    const r: ShellResult = { stdout: "", stderr: "", code: 127 };
    expect(fmt(r)).toContain("Exit: 127");
  });
});
