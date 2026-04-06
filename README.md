# ssh-mcp

An MCP (Model Context Protocol) server that gives Claude Code a persistent, stateful connection to a remote SSH server. Claude can run commands, edit files, manage background jobs, and inspect the system exactly as it would work locally — no manual `ssh` wrappers needed.

---

## How it works

A single SSH connection is kept open for the lifetime of the server. Commands run inside persistent no-PTY shell sessions, so state (working directory, environment variables, activated virtualenvs, etc.) carries across calls. File operations go through the SFTP subsystem for binary safety. All of this is invisible to Claude — it just calls tools.

---

## Setup

### Prerequisites

- Node.js 18+
- A remote server accessible over SSH
- Claude Code CLI

### Install

```bash
git clone https://github.com/ZuhaadRathore/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

### Register with Claude Code

```bash
claude mcp add-json -s user ssh-remote '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/ssh-mcp/dist/index.js"],
  "env": {
    "SSH_HOST": "your.server.com",
    "SSH_USER": "youruser",
    "SSH_PASSWORD": "yourpassword"
  }
}'
```

Use `SSH_KEY_PATH` instead of `SSH_PASSWORD` to authenticate with a private key:

```json
"SSH_KEY_PATH": "/home/you/.ssh/id_rsa"
```

Optional: set `SSH_PORT` if your server doesn't use port 22.

Restart Claude Code after registering. Verify it loaded with `/mcp`.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SSH_HOST` | Yes | Remote hostname or IP |
| `SSH_USER` | Yes | Remote username |
| `SSH_PASSWORD` | One of these | Password authentication |
| `SSH_KEY_PATH` | One of these | Path to PEM private key |
| `SSH_PORT` | No | Remote port (default: `22`) |

---

## Tools

### Execution

| Tool | Description |
|---|---|
| `ssh_exec` | Run a command in a named, persistent shell session. Shell state (cwd, env vars, venvs) persists across calls within the same session. |
| `ssh_exec_bg` | Start a long-running command in the background. Returns a job ID immediately — use `ssh_job_output` to poll. |

**`ssh_exec` parameters:**
- `command` — the shell command to run
- `session` — named session (default: `"default"`); use multiple for parallel contexts
- `timeout` — timeout in seconds (default: 60)

**`ssh_exec_bg` parameters:**
- `command` — the command to run in the background
- `label` — optional human-readable label

---

### Background jobs

| Tool | Description |
|---|---|
| `ssh_job_output` | Get current output and status (`running` / `done`) of a background job. |
| `ssh_job_list` | List all tracked background jobs with their live status. |
| `ssh_job_kill` | Kill a running background job (SIGTERM by default, SIGKILL with `force: true`). |

**`ssh_job_output` parameters:**
- `id` — job ID from `ssh_exec_bg`
- `tail` — only show last N lines of output (default: all)

Jobs are persisted to `jobs.json` and survive MCP server restarts.

---

### Files

| Tool | Description |
|---|---|
| `ssh_read_file` | Read a file. Supports partial reads with `offset` and `limit` (1-based line numbers) for large files. |
| `ssh_write_file` | Write content to a path via SFTP. Auto-creates parent directories. Binary-safe. |
| `ssh_edit_file` | Exact find-and-replace on a remote file. Fails if `old_string` is not found or matches more than once (unless `replace_all` is set) — prevents accidental edits. |
| `ssh_delete` | Delete a file or directory (`recursive: true` for non-empty directories). |
| `ssh_move` | Move or rename a file/directory. |
| `ssh_chmod` | Change file permissions. |
| `ssh_tail` | Read the last N lines of a file — useful for logs. |

**`ssh_edit_file` parameters:**
- `path` — remote file path
- `old_string` — exact string to find (must match character-for-character)
- `new_string` — replacement string
- `replace_all` — replace every occurrence instead of requiring uniqueness (default: `false`)

---

### Directory & search

| Tool | Description |
|---|---|
| `ssh_list_dir` | List a directory via SFTP. Pass `long: true` for permissions, size, owner, and mtime. |
| `ssh_stat` | Get metadata for a path: type, size, permissions, uid/gid, modified/accessed timestamps. |
| `ssh_find` | Find files by name pattern and/or content. Uses `grep -r` for pure content searches, `find` when depth limits or type filters are needed. |

**`ssh_find` parameters:**
- `path` — root path to search from (default: `.`)
- `name` — filename glob e.g. `*.ts`
- `content` — search inside files for this string
- `type` — `"file"`, `"dir"`, or `"any"` (default: `"any"`)
- `maxDepth` — limit search depth
- `caseSensitive` — default: `true`

---

### System

| Tool | Description |
|---|---|
| `ssh_ps` | List running processes sorted by CPU usage. Accepts an optional `filter` string and `limit`. |
| `ssh_df` | Show disk space usage. Optionally scoped to a specific path. |
| `ssh_env` | Dump the environment variables of a named session. Accepts an optional `filter` pattern. |

---

### Connection management

| Tool | Description |
|---|---|
| `ssh_status` | Show connection state, open sessions, and the cwd + user of each shell. |
| `ssh_reconnect` | Re-establish the SSH connection and all sessions. Pass `session` to reconnect only one named session. |

---

## Sessions

Named sessions let Claude maintain multiple independent shell contexts in parallel:

```
ssh_exec(command="cd /app && npm run dev", session="server")
ssh_exec(command="cd /app && npm test", session="tests")
```

Each session has its own shell process with its own cwd, environment, and state. The `"default"` session is used when no name is specified.

---

## Development

```bash
npm run dev        # run without building (tsx)
npm run build      # compile to dist/
npm test           # unit + MCP-layer tests (no SSH needed)
npm run test:integration  # real SSH tests (requires SSH_HOST etc.)
```

Integration tests are automatically skipped when `SSH_HOST` is not set.

---

## Architecture

```
src/
  index.ts          — entry point, registers all tool groups
  config.ts         — env var parsing, SSH ConnectConfig
  connection.ts     — SSH Client singleton with reconnect/waiter queue
  shell.ts          — persistent ShellSession, serial command queue, marker-based output parsing
  sftp.ts           — SFTPWrapper singleton
  jobs.ts           — background job registry + disk persistence
  helpers.ts        — q() shell quoting, fmt() result formatting
  tools/
    exec.ts         — ssh_exec, ssh_exec_bg
    jobs.ts         — ssh_job_output, ssh_job_list, ssh_job_kill
    files.ts        — ssh_read_file, ssh_write_file, ssh_edit_file, ssh_delete, ssh_move, ssh_chmod, ssh_tail
    directory.ts    — ssh_list_dir, ssh_stat, ssh_find
    system.ts       — ssh_ps, ssh_df, ssh_env
    manage.ts       — ssh_status, ssh_reconnect
```

---

## License

ISC
