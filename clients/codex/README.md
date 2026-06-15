# Codex setup workspace

This workspace exists so npm workspace filters can target Codex-specific setup files:

- `npm install -w codex`
- `npm install -w codex -w claude-code`

## Quick start with init

Print a Codex-ready MCP snippet:

```bash
npx -y @zuhaadrathore/ssh-mcp init --client codex
```

Write a starter snippet file:

```bash
npx -y @zuhaadrathore/ssh-mcp init --client codex --write
```

This writes:

- `./ssh-mcp.codex.mcp-server.toml`

Merge that snippet into `~/.codex/config.toml`.

The generated server block uses:

```toml
[mcp_servers.ssh_remote]
command = "npx"
args = ["-y", "@zuhaadrathore/ssh-mcp"]
env = { SSH_PROFILE = "default" }
```

See the root README for full setup instructions.
