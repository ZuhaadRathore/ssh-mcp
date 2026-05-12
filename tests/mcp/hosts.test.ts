import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestServer, getText } from "../helpers/server.js";
import { registerHostTools } from "../../src/tools/hosts.js";

interface FixturePaths {
  root: string;
  configPath: string;
  knownHostsPath: string;
}

function createSshFixture(configContent: string, knownHostsContent: string): FixturePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-hosts-"));
  const sshDir = path.join(root, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  const configPath = path.join(sshDir, "config");
  const knownHostsPath = path.join(sshDir, "known_hosts");
  fs.writeFileSync(configPath, configContent, "utf8");
  fs.writeFileSync(knownHostsPath, knownHostsContent, "utf8");
  return { root, configPath, knownHostsPath };
}

describe("host discovery MCP tools", () => {
  let fixture: FixturePaths;
  let callTool: (name: string, args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    fixture = createSshFixture(
      [
        "Host app",
        "  HostName app.example.com",
        "  User deploy",
        "  Port 2222",
        "  IdentityFile ~/.ssh/id_ed25519",
        "",
        "Host *.corp",
        "  User corpuser",
        "",
        "Host bastion",
        "  HostName bastion.example.com",
      ].join("\n"),
      [
        "app.example.com ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQC1",
        "db.local ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC2",
        "[bastion.example.com]:2200 ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQC3",
        "|1|hashed|entry ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQC4",
      ].join("\n")
    );

    const { client } = await createTestServer(registerHostTools);
    callTool = (name, args) => client.callTool({ name, arguments: args }).then(getText);
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("ssh_host_list returns merged hosts from config and known_hosts", async () => {
    const out = await callTool("ssh_host_list", {
      config_path: fixture.configPath,
      known_hosts_path: fixture.knownHostsPath,
    });

    expect(out).toContain("Discovered");
    expect(out).toContain("app -> deploy@app.example.com");
    expect(out).toContain("db.local");
    expect(out).toContain("bastion.example.com");
    expect(out).not.toContain("*.corp");
  });

  it("ssh_host_list can include wildcard patterns", async () => {
    const out = await callTool("ssh_host_list", {
      include_wildcards: true,
      config_path: fixture.configPath,
      known_hosts_path: fixture.knownHostsPath,
    });

    expect(out).toContain("*.corp");
  });

  it("ssh_host_info resolves alias and prints a check command", async () => {
    const out = await callTool("ssh_host_info", {
      host: "app",
      config_path: fixture.configPath,
      known_hosts_path: fixture.knownHostsPath,
    });

    expect(out).toContain("name:         app");
    expect(out).toContain("destination:  deploy@app.example.com");
    expect(out).toContain("sources:      ssh_config");
    expect(out).toContain("-p 2222");
  });

  it("ssh_host_info returns not-found when host does not exist", async () => {
    const out = await callTool("ssh_host_info", {
      host: "does-not-exist",
      config_path: fixture.configPath,
      known_hosts_path: fixture.knownHostsPath,
    });
    expect(out).toContain("was not found");
  });

  it("ssh_host_check returns generated command when execute=false", async () => {
    const out = await callTool("ssh_host_check", {
      host: "bastion",
      timeout: 7,
      probe_command: "echo ready",
      config_path: fixture.configPath,
      known_hosts_path: fixture.knownHostsPath,
    });

    expect(out).toContain("not executed");
    expect(out).toContain("ConnectTimeout=7");
    expect(out).toContain("'echo ready'");
  });

  it("ssh_host_check returns a stub message when execute=true", async () => {
    const out = await callTool("ssh_host_check", {
      host: "bastion",
      execute: true,
      config_path: fixture.configPath,
      known_hosts_path: fixture.knownHostsPath,
    });

    expect(out).toContain("not wired");
    expect(out).toContain("Run this command locally");
  });
});
