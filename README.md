# clw-auth

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/4i3n6/clw-auth?color=blue)](https://github.com/4i3n6/clw-auth/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-informational)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#install)

Standalone Anthropic OAuth credential manager. Produces standardized files that any system can consume directly.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/4i3n6/clw-auth/master/scripts/install.sh | sh
```

The installer will:
1. Check Node.js >= 18 and git
2. Clone the repo to `~/.local/share/clw-auth`
3. Create a symlink at `~/.local/bin/clw-auth`
4. Add `~/.local/bin` to your PATH (with confirmation) if not already set
5. Print a `source ~/.zshrc` command if your shell profile was modified

Then run the interactive setup wizard:

```bash
clw-auth tui
```

> **Shell reload**: if the installer added `~/.local/bin` to your PATH, run `source ~/.zshrc` (or `~/.bashrc`) before using `clw-auth`, or open a new terminal.

> **Manual install**: clone the repo and run `node src/cli.mjs` directly — no build step required.

## Update

```bash
clw-auth update
```

Fetches the latest release tag from GitHub and updates the installation in place. No shell reload required — the symlink stays the same, files update transparently.

## What it does

1. Authenticates via OAuth 2.0 PKCE or API key
2. Persists tokens at `~/.local/share/clw-auth/auth.json`
3. Generates `api-reference.json` with endpoint, headers, and authorization ready to use
4. Automatically renews tokens via cron
5. Monitors user-agent and beta header drift against official Anthropic docs
6. Exports credentials to specific systems (OpenCode, OpenClaw) via optional exporters

## How it works

```
clw-auth (this project)
    |
    |-- auth.json          (credentials: access, refresh, expires)
    |-- api-reference.json (how to call: endpoint, headers, authorization)
    |-- config.json        (beta headers, user-agent)
    |
    +--> OpenCode reads and uses (via export opencode)
    +--> OpenClaw reads and uses (via export openclaw)
    +--> Python script reads and uses (reads api-reference.json directly)
    +--> curl reads and uses (reads api-reference.json directly)
    +--> any system reads and uses
```

No system is special. This project produces standardized files in `~/.local/share/clw-auth/`. Any consumer reads them directly — no plugin, no patch, no coupling.

## Requirements

- Node.js >= 18

## Structure

```
clw-auth/
  src/
    cli.mjs              # Entry point + command dispatch
    store.mjs            # Atomic persistence (auth.json, api-reference.json, config.json)
    auth.mjs             # OAuth PKCE, exchange, refresh, API key
    config.mjs           # Beta headers, user-agent, defaults
    api-reference.mjs    # api-reference.json generation
    upstream.mjs         # Fetch + analysis of Anthropic docs
    cron.mjs             # Lock + conditional refresh + upstream check
    exporters/
      index.mjs          # Exporter registry
      opencode.mjs       # OpenCode exporter
      openclaw.mjs       # OpenClaw exporter
  scripts/
    install.sh           # One-liner system installer
    auth-tui.mjs         # Interactive setup wizard
    setup-cron.mjs       # Installs cron entry (idempotent)
  CHANGELOG.md
  LICENSE
  package.json
```

## Output files (`~/.local/share/clw-auth/`)

| File | Permission | Description |
|---|---|---|
| `auth.json` | 600 | Raw credentials (access, refresh, expires, type) |
| `auth.json.bak` | 600 | Automatic backup before any write |
| `api-reference.json` | 644 | Endpoint + headers + authorization ready for consumption |
| `config.json` | 600 | Beta headers and user-agent |
| `cron.lock` | 600 | Concurrency execution lock |
| `debug.log` | 600 | JSONL operation log |
| `cron.log` | — | Stdout/stderr of every cron execution |

### Example `api-reference.json`

```json
{
  "endpoint": "https://api.anthropic.com/v1/messages",
  "authorization": "Bearer sk-ant-oat01-...",
  "headers": {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "user-agent": "claude-cli/2.1.92 (external, cli)",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "auth_type": "oauth",
  "token_expires": "2026-04-07T23:42:35.196Z",
  "token_expired": false,
  "last_updated": "2026-04-06T20:42:35.000Z"
}
```

Any system reads this file and makes the call. No plugin, no patch, no coupling.

## Authentication

### OAuth (recommended)

```bash
clw-auth oauth-url                        # 1. Generate login URL
# Open in browser, complete login, copy code#state
clw-auth oauth-exchange "code#state"      # 2. Exchange for tokens
clw-auth status                           # 3. Verify
```

### API key

```bash
clw-auth api "$ANTHROPIC_API_KEY"
clw-auth status
```

## Commands

### Setup

```bash
clw-auth tui                          # Interactive setup wizard (auth + export)
clw-auth update                       # Update to latest release from GitHub
```

### Core

```bash
clw-auth oauth-url                    # Generate OAuth URL (PKCE)
clw-auth oauth-exchange <input>       # Exchange code#state for tokens
clw-auth refresh                      # Renew OAuth token
clw-auth status                       # Current auth status
clw-auth doctor                       # Status + api-ref + config + sources
clw-auth api <key>                    # Save API key
```

### API reference

```bash
clw-auth api-ref                      # Print api-reference.json
clw-auth api-ref-update               # Regenerate api-reference.json
```

### Config

```bash
clw-auth config                       # Print current config
clw-auth set-betas <csv|none>         # Set beta headers
clw-auth set-user-agent <ua|default>  # Set user-agent
clw-auth config-reset                 # Restore defaults
```

### Upstream

```bash
clw-auth upstream-check               # Compare local config vs Anthropic docs
clw-auth sources                      # Print monitored URLs
```

### Exporters

```bash
clw-auth export                       # List available exporters
clw-auth export opencode              # Export credentials to OpenCode
clw-auth export openclaw              # Export credentials to OpenClaw
```

### Maintenance

```bash
clw-auth cron-install                 # Install cron job (every 6 hours)
clw-auth cron-status                  # Check cron installation + last run
clw-auth cron-logs [n]                # Print last N lines of cron log
clw-auth cron-run                     # Run maintenance manually
```

## Automatic maintenance (cron)

```bash
clw-auth cron-install                 # Install (idempotent)
clw-auth cron-status                  # Check installation and last run
clw-auth cron-logs                    # View execution log
```

The cron runs every 6 hours and:

1. Refreshes OAuth token if it expires within 1 hour
2. Collects upstream data from Anthropic docs
3. Automatically updates user-agent if stale
4. Regenerates `api-reference.json`
5. Reports beta header drift (without auto-modifying)

## Exporters

### OpenCode

```bash
clw-auth export opencode
```

- Copies OAuth credentials to `~/.local/share/opencode/auth.json`
- Generates Anthropic auth plugin at `~/.config/opencode/plugins/clw-auth-anthropic.mjs`
- Patches `~/.config/opencode/opencode.json` to register the plugin

### OpenClaw

```bash
clw-auth export openclaw
```

- Syncs OAuth or API key credentials to `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

### Adding a new exporter

1. Create `src/exporters/<system>.mjs` with `export async function run() { ... }`
2. Register in `src/exporters/index.mjs`

The core does not change. Each exporter reads `auth.json` and `api-reference.json` and produces whatever the target system needs.

## Portability

```bash
# Copy to another machine
scp -r ~/.local/share/clw-auth user@host:~/.local/share/clw-auth

# On destination, re-link the binary
ln -sf ~/.local/share/clw-auth/src/cli.mjs ~/.local/bin/clw-auth

# Authenticate
clw-auth oauth-url
clw-auth oauth-exchange "code#state"
clw-auth status

# Export and install cron
clw-auth export opencode
clw-auth cron-install
```

## Monitored upstream sources

- https://platform.claude.com/docs/en/api/beta-headers
- https://platform.claude.com/docs/en/release-notes/overview
- https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md

## Security

- Credentials are never committed (`.gitignore`)
- `auth.json` and `config.json` written with `600` permission
- `api-reference.json` written with `644` permission (readable by other processes)
- All writes are atomic (write tmp + rename)
- Automatic backup of `auth.json` before any overwrite
- Internal lock to prevent concurrent cron executions

## License

MIT — see [LICENSE](LICENSE).
