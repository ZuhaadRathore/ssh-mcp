#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const entry = path.resolve(__dirname, "../dist/index.js");
const argv = process.argv.slice(2);

if (argv[0] === "init") {
  runInit(argv.slice(1));
  process.exit(0);
}

if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
  printHelp();
  process.exit(0);
}

if (!fs.existsSync(entry)) {
  process.stderr.write(
    "ssh-mcp: dist/index.js not found. Run 'npm run build' in this package before launching.\n"
  );
  process.exit(1);
}

await import(pathToFileURL(entry).href);

function printHelp() {
  process.stdout.write(`ssh-mcp

Usage:
  ssh-mcp                 Start MCP server
  ssh-mcp init [options]  Print/write starter client config snippets

Init options:
  --client <name>   codex | claude | all (default: all)
  --write           Write snippet files to disk
  --dir <path>      Output directory for --write (default: current directory)
  --force           Overwrite existing files when used with --write
  -h, --help        Show init help
`);
}

function printInitHelp() {
  process.stdout.write(`ssh-mcp init

Usage:
  ssh-mcp init [options]

Options:
  --client <name>   codex | claude | all (default: all)
  --write           Write snippet files to disk
  --dir <path>      Output directory for --write (default: current directory)
  --force           Overwrite existing files when used with --write
  -h, --help        Show this help
`);
}

function runInit(args) {
  const options = {
    client: "all",
    write: false,
    dir: process.cwd(),
    force: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      printInitHelp();
      return;
    }
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--client") {
      i += 1;
      const value = args[i];
      if (!value) {
        failInit("Missing value for --client.");
      }
      options.client = value;
      continue;
    }
    if (arg.startsWith("--client=")) {
      options.client = arg.slice("--client=".length);
      continue;
    }
    if (arg === "--dir") {
      i += 1;
      const value = args[i];
      if (!value) {
        failInit("Missing value for --dir.");
      }
      options.dir = value;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
      continue;
    }

    failInit(`Unknown option: ${arg}`);
  }

  const target = options.client.toLowerCase();
  if (target !== "all" && target !== "codex" && target !== "claude") {
    failInit(`Invalid --client value: ${options.client}`);
  }

  const snippets = {
    codex: `[mcp_servers.ssh_remote]
command = "npx"
args = ["-y", "@tavuc/ssh-mcp"]
env = { SSH_PROFILE = "default" }
`,
    claude: `{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@tavuc/ssh-mcp"],
  "env": {
    "SSH_PROFILE": "default"
  }
}
`,
  };

  const targets = target === "all" ? ["codex", "claude"] : [target];
  if (!options.write) {
    printSnippets(snippets, targets);
    return;
  }

  const outDir = path.resolve(process.cwd(), options.dir);
  fs.mkdirSync(outDir, { recursive: true });

  const writes = [
    {
      client: "codex",
      fileName: "ssh-mcp.codex.mcp-server.toml",
      content: snippets.codex,
    },
    {
      client: "claude",
      fileName: "ssh-mcp.claude-code.mcp-server.json",
      content: snippets.claude,
    },
  ].filter((item) => targets.includes(item.client));

  for (const item of writes) {
    const outPath = path.join(outDir, item.fileName);
    if (fs.existsSync(outPath) && !options.force) {
      failInit(`File already exists: ${outPath}. Use --force to overwrite.`);
    }
    fs.writeFileSync(outPath, item.content, "utf8");
    process.stdout.write(`Wrote ${outPath}\n`);
  }

  process.stdout.write("\nNext steps:\n");
  if (targets.includes("codex")) {
    process.stdout.write(
      `- Merge ${path.join(outDir, "ssh-mcp.codex.mcp-server.toml")} into ~/.codex/config.toml\n`
    );
  }
  if (targets.includes("claude")) {
    process.stdout.write(
      `- Use ${path.join(outDir, "ssh-mcp.claude-code.mcp-server.json")} with 'claude mcp add-json'\n`
    );
  }
}

function printSnippets(snippets, targets) {
  process.stdout.write("Starter MCP config snippets for @tavuc/ssh-mcp (npx -y):\n\n");
  if (targets.includes("codex")) {
    process.stdout.write("=== Codex (~/.codex/config.toml) ===\n");
    process.stdout.write(snippets.codex);
    process.stdout.write("\n");
  }
  if (targets.includes("claude")) {
    process.stdout.write("=== Claude Code (stdin server object for claude mcp add-json) ===\n");
    process.stdout.write(snippets.claude);
    process.stdout.write("\n");
  }
}

function failInit(message) {
  process.stderr.write(`ssh-mcp init: ${message}\n\n`);
  printInitHelp();
  process.exit(1);
}
