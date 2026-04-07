# claude-oauth

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

Then run the interactive setup wizard:

```bash
claude-oauth auth-setup
```

> **Manual install**: clone the repo and run `node src/cli.mjs` directly — no build step required.

## What it does

1. Authenticates via OAuth 2.0 PKCE or API key
2. Persists tokens at `~/.local/share/claude-oauth/auth.json`
3. Generates `api-reference.json` with endpoint, headers, and authorization ready to use
4. Automatically renews tokens via cron
5. Monitors user-agent and beta header drift against official Anthropic docs
6. Exports credentials to specific systems (OpenCode, OpenClaw) via optional exporters

## How it works

```
claude-oauth (this project)
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

No system is special. This project produces standardized files in `~/.local/share/claude-oauth/`. Any consumer reads them directly — no plugin, no patch, no coupling.

## Requirements

- Node.js >= 18

## Structure

```
claude-oauth/
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
    setup-cron.mjs       # Installs cron entry (idempotent)
  CHANGELOG.md
  LICENSE
  package.json
```

## Output files (`~/.local/share/claude-oauth/`)

| File | Permission | Description |
|---|---|---|
| `auth.json` | 600 | Raw credentials (access, refresh, expires, type) |
| `auth.json.bak` | 600 | Automatic backup before any write |
| `api-reference.json` | 644 | Endpoint + headers + authorization ready for consumption |
| `config.json` | 600 | Beta headers and user-agent |
| `cron.lock` | 600 | Concurrency execution lock |
| `debug.log` | 600 | JSONL operation log |

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
# 1. Generate login URL
node src/cli.mjs oauth-url

# 2. Open in browser, complete login, copy the returned code#state

# 3. Exchange for tokens
node src/cli.mjs oauth-exchange "code#state"

# 4. Verify
node src/cli.mjs status
```

### API key

```bash
node src/cli.mjs api "$ANTHROPIC_API_KEY"
node src/cli.mjs status
```

## Commands

### Core

```bash
claude-oauth oauth-url                    # Generate OAuth URL (PKCE)
claude-oauth oauth-exchange <input>       # Exchange code#state for tokens
claude-oauth refresh                      # Renew OAuth token
claude-oauth status                       # Current auth status
claude-oauth doctor                       # Status + api-ref + config + sources
claude-oauth api <key>                    # Save API key
```

### API reference

```bash
claude-oauth api-ref                      # Print api-reference.json
claude-oauth api-ref-update               # Regenerate api-reference.json
```

### Config

```bash
claude-oauth config                       # Print current config
claude-oauth set-betas <csv|none>         # Set beta headers
claude-oauth set-user-agent <ua|default>  # Set user-agent
claude-oauth config-reset                 # Restore defaults
```

### Upstream

```bash
claude-oauth upstream-check               # Compare local config vs Anthropic docs
claude-oauth sources                      # Print monitored URLs
```

### Exporters

```bash
claude-oauth export                       # List available exporters
claude-oauth export opencode              # Export config to OpenCode
claude-oauth export openclaw              # Export credentials to OpenClaw
```

### Maintenance

```bash
claude-oauth cron-run                     # Run maintenance (for cron/launchd)
```

## Automatic maintenance (cron)

Install a cron entry to run every 6 hours:

```bash
node scripts/setup-cron.mjs
```

The cron runs:
1. OAuth refresh if token expires in less than 1 hour
2. Collect upstream data (Anthropic docs)
3. Automatically update user-agent if stale
4. Regenerate api-reference.json
5. Report beta header drift (without auto-modifying)

Manual run:

```bash
node src/cli.mjs cron-run
```

## Exporters

The exporter system allows integration with any tool without coupling the core.

### OpenCode

```bash
node src/cli.mjs export opencode
```

This exporter:
- Copies credentials to `~/.local/share/opencode/auth.json` (preserves other providers)
- Generates Anthropic plugin at `~/.config/opencode/plugins/claude-oauth-anthropic.mjs`
- Patches `~/.config/opencode/opencode.json` to include the plugin

### OpenClaw

```bash
node src/cli.mjs export openclaw
```

This exporter:
- Syncs OAuth or API key credentials to `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

### Adding a new exporter

1. Create `src/exporters/<system>.mjs` with `export async function run() { ... }`
2. Register in `src/exporters/index.mjs`

The core does not change. Each exporter reads `auth.json` and `api-reference.json` and produces whatever the target system needs.

## Portability

```bash
# Copy to another machine
scp -r ~/Sistemas/claude-oauth user@host:~/claude-oauth

# On destination machine, authenticate
node ~/claude-oauth/src/cli.mjs oauth-url
node ~/claude-oauth/src/cli.mjs oauth-exchange "code#state"
node ~/claude-oauth/src/cli.mjs status

# Optional: export to OpenCode
node ~/claude-oauth/src/cli.mjs export opencode

# Optional: install cron
node ~/claude-oauth/scripts/setup-cron.mjs
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
