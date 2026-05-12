# Claude Code setup workspace

This workspace exists so npm workspace filters can target Claude Code-specific setup files:

- `npm install -w claude-code`
- `npm install -w codex -w claude-code`

## Quick start with init

Print a Claude-ready MCP snippet:

```bash
npx -y @tavuc/ssh-mcp init --client claude
```

Write a starter snippet file:

```bash
npx -y @tavuc/ssh-mcp init --client claude --write
```

This writes:

- `./ssh-mcp.claude-code.mcp-server.json`

Use it as the payload for `claude mcp add-json`:

```bash
claude mcp add-json -s user ssh-remote "$(cat ./ssh-mcp.claude-code.mcp-server.json)"
```

PowerShell equivalent:

```powershell
claude mcp add-json -s user ssh-remote "$(Get-Content -Raw .\ssh-mcp.claude-code.mcp-server.json)"
```

The generated server object uses:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@tavuc/ssh-mcp"],
  "env": {
    "SSH_PROFILE": "default"
  }
}
```

See the root README for full setup instructions.
