# ssh-mcp

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=for-the-badge)](./LICENSE)

An MCP (Model Context Protocol) server that provides a persistent, stateful SSH connection for MCP clients like Claude Code and Codex.

You can run commands, edit files, manage background jobs, inspect system state, and now manage multiple SSH server profiles at runtime.

---

## Highlights

- Persistent shell sessions (`ssh_exec`) with stateful cwd/env per session
- Binary-safe file operations via SFTP
- Background jobs with persisted tracking (`jobs.json`)
- Runtime server profile management:
  - `ssh_server_list`
  - `ssh_server_add`
  - `ssh_server_use`
  - `ssh_server_remove`

---

## Setup

### Prerequisites

- Node.js 18+
- An SSH-reachable server
- Claude Code and/or Codex

### Install and build

```bash
npm install
npm run build
```

### One-command runtime via npx

After publishing, clients can launch this MCP server with:

```bash
npx -y @tavuc/ssh-mcp
```

### Optional workspace-targeted install commands

This repo defines two npm workspaces: `codex` and `claude-code`.

```bash
npm install -w codex
npm install -w claude-code
npm install -w codex -w claude-code
```

Note: npm does not support `-w:codex/claude-code` syntax. Use repeated `-w` flags.

---

## Configure server profiles

Profiles are stored in:

- `SSH_SERVERS_FILE` if set, otherwise
- `~/.ssh-mcp/servers.json`

You can bootstrap with env vars (legacy path), then manage profiles through MCP tools.

### Env bootstrap (optional)

```bash
SSH_HOST=your.server.com
SSH_USER=youruser
SSH_PASSWORD=yourpassword
# or SSH_KEY_PATH=/path/to/private/key
# optional: SSH_PORT=22
# optional: SSH_PROFILE=default
```

After startup, use `ssh_server_add` / `ssh_server_use` for day-to-day profile management.

Security note: profile passwords are stored in plain text in the profile JSON file. Prefer key-based auth where possible.

---

## Register with Claude Code

```bash
claude mcp add-json -s user ssh-remote '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@tavuc/ssh-mcp"],
  "env": {
    "SSH_PROFILE": "default"
  }
}'
```

Restart Claude Code and verify with `/mcp`.

---

## Register with Codex

Add this block to `~/.codex/config.toml`:

```toml
[mcp_servers.ssh_remote]
command = "npx"
args = ["-y", "@tavuc/ssh-mcp"]
env = { SSH_PROFILE = "default" }
```

Then restart Codex.

Client-specific templates are also included:

- `clients/codex/mcp-server.toml.example`
- `clients/claude-code/mcp-server.json.example`

If you are running from a local clone (not a published npm package), keep using `node .../dist/index.js`.

---

## Tools

### Execution

| Tool | Description |
|---|---|
| `ssh_exec` | Run a command in a named, persistent shell session. |
| `ssh_exec_bg` | Start a long-running command in the background. |
| `ssh_exec_sudo` | Run a command through `sudo -n` after a short-lived confirmation token flow. |

### Background jobs

| Tool | Description |
|---|---|
| `ssh_job_output` | Get current output and status (`running` / `done`) of a background job. |
| `ssh_job_list` | List tracked background jobs and live status. |
| `ssh_job_kill` | Kill a running background job. |

### Files

| Tool | Description |
|---|---|
| `ssh_read_file` | Read remote files, including partial reads with `offset`/`limit`. |
| `ssh_write_file` | Write file content via SFTP (auto-creates parent directories). |
| `ssh_edit_file` | Safe exact replacement with ambiguity guardrails, optional SHA256 precondition, and `dry_run` patch preview. |
| `ssh_delete` | Delete files/directories (`recursive` for non-empty dirs). |
| `ssh_move` | Move/rename files and directories. |
| `ssh_chmod` | Change file permissions. |
| `ssh_tail` | Tail the last N lines of a file. |

### Directory and search

| Tool | Description |
|---|---|
| `ssh_list_dir` | List directories via SFTP (`long: true` for metadata). |
| `ssh_stat` | Stat file or directory metadata. |
| `ssh_find` | Find by name and/or content. |

### System

| Tool | Description |
|---|---|
| `ssh_ps` | List running processes (optional filter and limit). |
| `ssh_df` | Show disk usage. |
| `ssh_env` | Dump environment variables for a named shell session. |

### SSH host discovery

| Tool | Description |
|---|---|
| `ssh_host_list` | List hosts discovered from `~/.ssh/config` and `~/.ssh/known_hosts`. |
| `ssh_host_info` | Show merged SSH config/known_hosts details for one alias or host. |
| `ssh_host_check` | Generate a local SSH connectivity check command. |

### Connection and profile management

| Tool | Description |
|---|---|
| `ssh_status` | Show active profile, connection state, sessions, and shell cwd/user snapshots. |
| `ssh_reconnect` | Reconnect one session or the full connection stack. |
| `ssh_server_list` | List configured server profiles and active profile. |
| `ssh_server_add` | Add/update a server profile, optionally activate it. |
| `ssh_server_use` | Switch active profile and reconnect immediately. |
| `ssh_server_remove` | Remove a server profile (cannot remove the last one). |

---

## Sessions

Named sessions are independent shell contexts on the currently active server profile:

```txt
ssh_exec(command="cd /app && npm run dev", session="server")
ssh_exec(command="cd /app && npm test", session="tests")
```

Switching profile with `ssh_server_use` reconnects and resets shell session processes against the new server.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SSH_HOST` | Bootstrap fallback | Legacy bootstrap host (used if profile file is empty) |
| `SSH_USER` | Bootstrap fallback | Legacy bootstrap username |
| `SSH_PASSWORD` | Optional | Password auth for bootstrap profile |
| `SSH_KEY_PATH` | Optional | Key auth for bootstrap profile |
| `SSH_PORT` | Optional | Port for bootstrap profile (default `22`) |
| `SSH_PROFILE` | Optional | Name for bootstrap profile (default `default`) |
| `SSH_SERVERS_FILE` | Optional | Override profile file path |
| `SSH_POLICY_FILE` | Optional | Override policy file path (default `~/.ssh-mcp/policy.json`) |
| `SSH_AUDIT_FILE` | Optional | Override audit log path (default `~/.ssh-mcp/audit.log.jsonl`) |

---

## Security policy

Policy is optional. If no policy file exists, tools behave as normal. When present, the JSON policy can restrict command execution, remote paths, and write operations globally or per server profile.

Example `~/.ssh-mcp/policy.json`:

```json
{
  "deniedCommands": ["rm\\s+-rf\\s+/"],
  "allowedRemotePaths": ["/srv/app", "/var/log"],
  "readOnlyMode": false,
  "profiles": {
    "prod": {
      "readOnlyMode": true,
      "allowedCommands": ["^(ls|cat|tail|grep|df|ps)\\b"]
    }
  }
}
```

Remote path restrictions are enforced on file, directory, search, tail, chmod, move, and delete tools. Command restrictions are enforced on direct command execution, sudo execution, and system command tools.

---

## Audit logging

Command and file operations append structured JSONL records to `~/.ssh-mcp/audit.log.jsonl` by default. Command logs store SHA256 command hashes and metadata rather than raw command text.

---

## Development

```bash
npm run build
npm test
npm run test:integration
```

Integration tests require a real SSH server.

Copy `.env.example` to `.env`, fill credentials, then run `npm run test:integration`.

The `.env` file is consumed by tests only, not by the MCP runtime unless your launch environment explicitly exports those variables.

---

## Architecture

```txt
src/
  index.ts          — entry point, registers all tool groups
  config.ts         — server profile store + active SSH config
  connection.ts     — SSH client singleton
  shell.ts          — persistent command sessions
  sftp.ts           — SFTP singleton
  jobs.ts           — background job registry + disk persistence
  audit.ts          — append-only JSONL audit logger
  runtime-policy.ts — optional file-backed policy loader
  policy*.ts        — policy parsing, compilation, and enforcement
  helpers.ts        — quoting + result formatting
  tools/
    exec.ts         — ssh_exec, ssh_exec_bg
    jobs.ts         — ssh_job_output, ssh_job_list, ssh_job_kill
    files.ts        — file operations
    directory.ts    — list/stat/find
    hosts.ts        — ssh_host_list, ssh_host_info, ssh_host_check
    privileged.ts   — ssh_exec_sudo
    system.ts       — ssh_ps, ssh_df, ssh_env
    manage.ts       — ssh_status, ssh_reconnect, ssh_server_*
```

---

## License

MIT
