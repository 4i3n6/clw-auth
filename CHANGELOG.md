# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-06

### Added

- **`scripts/auth-tui.mjs`** — interactive TUI wizard (`npm run auth-setup`) with zero runtime dependencies. Flow: tool selection (OpenCode / OpenClaw / Both) → authentication method → OAuth or API key → account info with model and context-window table → export to selected tools. Includes ASCII art logos, clipboard and browser integration, TTY detection, signal cleanup (SIGTERM/SIGHUP), retry limits (5 per input), classified error messages for network/filesystem/HTTP errors, and suppression of internal `console.log` output during auth and export calls.
- **`scripts/auth-tui.mjs`** — fetches `GET /v1/models` after authentication and displays a table of available models with their context window (`max_input_tokens`) and max output tokens. Works with both OAuth Bearer and API key auth.
- **`package.json`** — `auth-setup` script alias for the TUI wizard.
- **`.gitignore`** — recursive `AGENTS.md` rule to prevent AI context files from being committed.

### Fixed

- **`src/store.mjs`** — `normalizeAuth` silently discarded the `key` field, causing `setApiKey` to write `{ type: "api" }` without the API key to disk. All consumers of `loadAuth()` would receive an auth object with no usable key.
- **`src/exporters/openclaw.mjs`** — new `auth-profiles.json` files were written without the `version` field required by OpenClaw's `AuthProfileSecretsStore` schema (`{ version: number, profiles: ... }`). Existing stores without a `version` field now default to `1`.
- **`src/exporters/openclaw.mjs`** — `loadJson` was called on the profiles file and would throw on corrupt or missing input. Replaced with a resilient reader that returns `{}` as a safe fallback.

### Changed

- **`src/exporters/opencode.mjs`** — added support for `opencode.jsonc` config files. OpenCode uses JSONC in practice; the exporter now detects, parses (strips comments and trailing commas), and correctly writes to the JSONC path when present.
- **`src/config.mjs`** — updated default `userAgent` from `claude-cli/2.1.2` to `claude-cli/2.1.92`.
- **`src/upstream.mjs`** — migrated all upstream source URLs from the deprecated `docs.anthropic.com` domain to `platform.claude.com/docs`. Updated Claude Code CHANGELOG source to `raw.githubusercontent.com`.
- **`README.md`** — translated from PT-BR to EN-US.

## [0.1.0] - 2026-04-06

### Added

- **OAuth 2.0 PKCE flow** against `claude.ai/oauth/authorize` with dual-endpoint token exchange (`platform.claude.com` and `console.anthropic.com` as fallback). Includes exponential backoff (4 retries) and `Retry-After` header support for 429 responses.
- **API key authentication** as an alternative to OAuth. Key stored as `{ type: "api", key }` in `auth.json`.
- **Atomic filesystem persistence** — all writes use a tmp-file + rename pattern with explicit `chmod` enforcement. File permissions: `auth.json` at `600`, `api-reference.json` at `644`, `config.json` at `600`.
- **Automatic `auth.json` backup** (`auth.json.bak`) created before every credential write, preventing data loss on interrupted writes.
- **`api-reference.json` artifact** — standardized file with `endpoint`, `headers` (including `anthropic-version`, `anthropic-beta`, `user-agent`, `content-type`), `authorization`, `auth_type`, and token expiry metadata. Any downstream tool can consume it directly without a plugin or SDK.
- **Runtime configuration** for `anthropic-beta` headers and `User-Agent` string. Commands: `set-betas <csv|none>`, `set-user-agent <ua|default>`, `config-reset`. Default beta: `interleaved-thinking-2025-05-14`.
- **Upstream drift detection** — scrapes official Anthropic docs and the Claude Code CHANGELOG to detect stale user-agent versions and beta headers.
- **Automatic user-agent version update** via cron when the Claude Code CHANGELOG reports a newer release. Beta header drift is reported but never auto-modified.
- **Cron maintenance orchestrator** with file-based concurrency lock (`cron.lock`, 24h TTL, OS-level atomic `wx` flag).
- **`setup-cron.mjs`** — idempotent cron installer (runs every 6 hours).
- **Exporter system** with registry pattern (`Map`-based). Exporters are isolated from CLI core.
- **OpenCode exporter** — syncs credentials to `~/.local/share/opencode/auth.json`, generates a self-contained Anthropic auth plugin at `~/.config/opencode/plugins/claude-oauth-anthropic.mjs`, and patches `opencode.json` to include the plugin.
- **OpenClaw exporter** — syncs OAuth or API key credentials to `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under the `anthropic:default` profile key.
- **Full CLI** with grouped help, per-command help, and command aliases. All modules loaded via dynamic import to minimize startup cost.
- **`doctor` command** — single-pass diagnostic report combining status, api-ref, config, and upstream sources.
- **JSONL debug log** at `~/.local/share/claude-oauth/debug.log` (mode `600`). Credentials never logged.
- Zero npm runtime dependencies — Node.js built-ins only.
- MIT License.

[Unreleased]: https://github.com/clw-auth/clw-auth/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/clw-auth/clw-auth/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/clw-auth/clw-auth/releases/tag/v0.1.0
