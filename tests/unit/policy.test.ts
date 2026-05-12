import { describe, expect, it } from "vitest";
import { parsePolicyConfig } from "../../src/policy-config.js";
import { assertCommandAllowed, assertPathAllowed, assertWriteAllowed, compilePolicy, resolvePolicyForProfile } from "../../src/policy.js";

describe("policy-config parsing", () => {
  it("parses an empty policy object into safe defaults", () => {
    const parsed = parsePolicyConfig({});
    expect(parsed).toEqual({
      allowedCommands: [],
      deniedCommands: [],
      allowedRemotePaths: [],
      readOnlyMode: false,
      profiles: {},
    });
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parsePolicyConfig({ notARealField: true })).toThrow("policy contains unknown key 'notARealField'.");
  });

  it("rejects invalid regex patterns", () => {
    expect(() => parsePolicyConfig({ allowedCommands: ["("] })).toThrow("policy.allowedCommands[0] is not a valid regex");
  });

  it("rejects non-absolute allowedRemotePaths", () => {
    expect(() => parsePolicyConfig({ allowedRemotePaths: ["tmp/logs"] })).toThrow(
      "policy.allowedRemotePaths[0] must be an absolute path starting with '/'."
    );
  });

  it("parses per-profile overrides", () => {
    const parsed = parsePolicyConfig({
      readOnlyMode: true,
      profiles: {
        dev: { readOnlyMode: false, allowedCommands: ["^ls(\\s|$)"] },
      },
    });
    expect(parsed.readOnlyMode).toBe(true);
    expect(parsed.profiles.dev?.readOnlyMode).toBe(false);
    expect(parsed.profiles.dev?.allowedCommands).toEqual(["^ls(\\s|$)"]);
  });
});

describe("policy enforcement", () => {
  it("applies per-profile overrides over defaults", () => {
    const compiled = compilePolicy(
      parsePolicyConfig({
        allowedCommands: ["^ls(\\s|$)"],
        readOnlyMode: true,
        profiles: {
          deploy: { allowedCommands: ["^kubectl(\\s|$)"], readOnlyMode: false },
        },
      })
    );

    const deploy = resolvePolicyForProfile(compiled, "deploy");
    expect(deploy.readOnlyMode).toBe(false);
    expect(deploy.allowedCommands).toHaveLength(1);
    expect(deploy.allowedCommands[0]?.source).toBe("^kubectl(\\s|$)");
  });

  it("deniedCommands blocks matching command even if allowlist also matches", () => {
    const compiled = compilePolicy(
      parsePolicyConfig({
        allowedCommands: [".*"],
        deniedCommands: ["rm\\s+-rf"],
      })
    );
    const policy = resolvePolicyForProfile(compiled, "default");

    expect(() => assertCommandAllowed(policy, "rm -rf /tmp/foo")).toThrow("Command blocked by deniedCommands policy");
  });

  it("blocks commands when allowlist is configured and no pattern matches", () => {
    const compiled = compilePolicy(
      parsePolicyConfig({
        allowedCommands: ["^ls(\\s|$)", "^cat(\\s|$)"],
      })
    );
    const policy = resolvePolicyForProfile(compiled, "default");

    expect(() => assertCommandAllowed(policy, "uname -a")).toThrow(
      "Command blocked: it does not match allowedCommands policy."
    );
  });

  it("allows command when it matches allowlist and no deny rule matches", () => {
    const compiled = compilePolicy(
      parsePolicyConfig({
        allowedCommands: ["^ls(\\s|$)"],
      })
    );
    const policy = resolvePolicyForProfile(compiled, "default");

    expect(() => assertCommandAllowed(policy, "ls -la /tmp")).not.toThrow();
  });

  it("blocks write operations in read-only mode", () => {
    const compiled = compilePolicy(parsePolicyConfig({ readOnlyMode: true }));
    const policy = resolvePolicyForProfile(compiled, "default");

    expect(() => assertWriteAllowed(policy, "ssh_write_file")).toThrow(
      "ssh_write_file blocked: readOnlyMode is enabled for profile 'default'."
    );
  });

  it("enforces allowedRemotePaths and returns normalized paths", () => {
    const compiled = compilePolicy(
      parsePolicyConfig({
        allowedRemotePaths: ["/srv/app"],
      })
    );
    const policy = resolvePolicyForProfile(compiled, "default");

    const normalized = assertPathAllowed(policy, "/srv/app/../app/logs/app.log", { operation: "ssh_read_file" });
    expect(normalized).toBe("/srv/app/logs/app.log");
    expect(() => assertPathAllowed(policy, "/etc/passwd", { operation: "ssh_read_file" })).toThrow(
      "ssh_read_file blocked: path '/etc/passwd' is outside allowedRemotePaths."
    );
  });

  it("supports overriding readOnlyMode per profile", () => {
    const compiled = compilePolicy(
      parsePolicyConfig({
        readOnlyMode: true,
        profiles: {
          dev: { readOnlyMode: false },
        },
      })
    );

    const dev = resolvePolicyForProfile(compiled, "dev");
    const prod = resolvePolicyForProfile(compiled, "prod");
    expect(dev.readOnlyMode).toBe(false);
    expect(prod.readOnlyMode).toBe(true);
  });
});

