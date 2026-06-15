# ssh-mcp

[![npm](https://img.shields.io/npm/v/@zuhaadrathore/ssh-mcp?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/@zuhaadrathore/ssh-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=for-the-badge)](./LICENSE)

MCP server that gives Claude Code and Codex a persistent SSH connection to a remote machine. Run commands, edit files, manage background jobs, and switch between server profiles — all from your AI client.

---

## Quickstart

**Claude Code**

```bash
claude mcp add-json -s user ssh-remote '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@zuhaadrathore/ssh-mcp"]
}'
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.ssh_remote]
command = "npx"
args = ["-y", "@zuhaadrathore/ssh-mcp"]
```

Then add your first server in the AI chat:

```
Add an SSH server: host=your.server.com user=youruser key=~/.ssh/id_rsa
```

Or use env vars to bootstrap on first launch (see [Environment variables](#environment-variables)).

---

## What you get

Once connected, your AI client can:

- Run commands in **named persistent shell sessions** (each session keeps its own cwd and env)
- Read, write, edit, move, delete, and tail **remote files** via SFTP
- Launch and monitor **background jobs**
- Run **sudo commands** via a short-lived confirmation token flow
- Switch between **multiple server profiles** at runtime without restarting
- Discover SSH hosts from `~/.ssh/config` and `known_hosts`
- Inspect processes, disk usage, and environment variables

---

## Server profiles

Profiles are stored in `~/.ssh-mcp/servers.json`. Manage them through the AI:

```
List my SSH servers
Add server prod: host=prod.example.com user=deploy key=~/.ssh/prod_key
Switch to prod
Remove the staging server
```

Or use env vars for a one-off bootstrap (profile is created on first launch, then managed in the profile file):

```bash
SSH_HOST=your.server.com
SSH_USER=youruser
SSH_KEY_PATH=/path/to/key   # or SSH_PASSWORD=...
SSH_PORT=22                  # optional, default 22
SSH_PROFILE=default          # optional, names the profile
```

---

## Named sessions

Each `ssh_exec` call runs in a named shell that persists across calls:

```
Run `cd /app && npm run dev` in session "server"
Run `npm test` in session "tests"
```

Sessions are independent and keep their working directory between commands. Switching profiles resets sessions to the new server.

---

## Tools reference

### Execution

| Tool | Description |
|---|---|
| `ssh_exec` | Run a command in a named persistent shell session |
| `ssh_exec_bg` | Start a long-running command in the background |
| `ssh_exec_sudo` | Run a command via `sudo -n` with a confirmation token |

### Background jobs

| Tool | Description |
|---|---|
| `ssh_job_list` | List tracked jobs and their status |
| `ssh_job_output` | Get output and status of a background job |
| `ssh_job_kill` | Kill a running background job |

### Files

| Tool | Description |
|---|---|
| `ssh_read_file` | Read a remote file (supports `offset`/`limit` for partial reads) |
| `ssh_write_file` | Write file content via SFTP (auto-creates directories) |
| `ssh_edit_file` | Exact string replacement with optional SHA256 precondition and dry-run preview |
| `ssh_delete` | Delete files or directories |
| `ssh_move` | Move or rename files and directories |
| `ssh_chmod` | Change file permissions |
| `ssh_tail` | Tail the last N lines of a file |

### Directory and search

| Tool | Description |
|---|---|
| `ssh_list_dir` | List a directory (`long: true` for metadata) |
| `ssh_stat` | Stat a file or directory |
| `ssh_find` | Find files by name and/or content |

### System

| Tool | Description |
|---|---|
| `ssh_ps` | List running processes |
| `ssh_df` | Show disk usage |
| `ssh_env` | Dump environment variables for a shell session |

### Host discovery

| Tool | Description |
|---|---|
| `ssh_host_list` | List hosts from `~/.ssh/config` and `known_hosts` |
| `ssh_host_info` | Show SSH config details for a host alias |
| `ssh_host_check` | Generate a connectivity check command |

### Connection and profiles

| Tool | Description |
|---|---|
| `ssh_status` | Show active profile, connection state, and session snapshots |
| `ssh_reconnect` | Reconnect a session or the full connection |
| `ssh_server_list` | List configured profiles |
| `ssh_server_add` | Add or update a profile |
| `ssh_server_use` | Switch active profile and reconnect |
| `ssh_server_remove` | Remove a profile |

---

## Environment variables

| Variable | Description |
|---|---|
| `SSH_HOST` | Bootstrap host (used if profile file is empty) |
| `SSH_USER` | Bootstrap username |
| `SSH_PASSWORD` | Bootstrap password auth |
| `SSH_KEY_PATH` | Bootstrap key auth |
| `SSH_PORT` | Bootstrap port (default `22`) |
| `SSH_PROFILE` | Bootstrap profile name (default `default`) |
| `SSH_SERVERS_FILE` | Override profile file path |
| `SSH_POLICY_FILE` | Override policy file path (default `~/.ssh-mcp/policy.json`) |
| `SSH_AUDIT_FILE` | Override audit log path (default `~/.ssh-mcp/audit.log.jsonl`) |

---

## Security policy

Optional. If no policy file exists, all tools work normally. When present, the JSON policy restricts commands, paths, and writes — globally or per profile.

`~/.ssh-mcp/policy.json` example:

```json
{
  "deniedCommands": ["rm\\s+-rf\\s+/"],
  "allowedRemotePaths": ["/srv/app", "/var/log"],
  "profiles": {
    "prod": {
      "readOnlyMode": true,
      "allowedCommands": ["^(ls|cat|tail|grep|df|ps)\\b"]
    }
  }
}
```

---

## Audit log

All command and file operations are appended as JSONL to `~/.ssh-mcp/audit.log.jsonl`. Command entries store a SHA256 hash rather than raw text.

---

## License

MIT
