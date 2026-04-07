# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-04-07

### Added

- **interactive agent selection on export** — clw-auth export openclaw now lists all agents configured in ~/.openclaw/agents/, shows which already have Anthropic credentials, and prompts the user to select one or all before exporting. If only one agent exists, it is used automatically. If options.agentId is passed programmatically, the prompt is skipped.


## [0.5.6] - 2026-04-07

### Fixed

- **add missing methods array to generated plugin** — The generated clw-auth-anthropic.mjs plugin was missing the auth.methods array required by OpenCode's plugin API. When OpenCode called item.methods.map(), it crashed with 'undefined is not an object', fell back to the native Anthropic provider, used the OAuth token as an API key, and got 401 'OAuth authentication is currently not supported.' Fix adds: - import randomBytes, createHash from node:crypto (inline PKCE) - base64Url, generatePKCE, authorizeOAuth, exchangeCode helpers - auth.methods array with Claude Pro/Max OAuth and manual API key methods After clw-auth update + clw-auth export opencode, the new plugin will load correctly and intercept API calls with proper OAuth bearer token.


## [0.5.5] - 2026-04-07

### Fixed

- **add anthropic-beta: oauth-2025-04-20 header for model list** — GET /v1/models with OAuth bearer token requires the oauth-2025-04-20 beta header. Also removes unnecessary Content-Type from GET request.


## [0.5.4] - 2026-04-07

### Fixed

- **add missing clearLine to ansi constants** — ansi.clearLine was removed during refactoring but showAccountInfo still references it, causing process.stdout.write(undefined) crash.


## [0.5.3] - 2026-04-07

### Fixed

- **correct OAuth token exchange using working reference implementation** — Analysis of ~/bin/opencode-anthropic-auth (confirmed working) revealed three critical differences from our implementation: 1. REDIRECT_URI reverted to platform.claude.com (console.anthropic.com was wrong — platform.claude.com is the correct registered callback) 2. code=true parameter added to the auth URL (required by claude.ai) 3. state field added to the token payload alongside code_verifier (Anthropic requires both fields in the exchange request) 4. Content-Type reverted to application/json (working impl uses JSON) 5. TOKEN_ENDPOINTS order restored to platform.claude.com first The missing state field in the token payload was the root cause of the 400 Invalid request format error.


## [0.5.2] - 2026-04-07

### Fixed

- **correct redirect_uri and token endpoint to console.anthropic.com** — platform.claude.com redirects to console.anthropic.com during OAuth. The auth server records the final URI (console.anthropic.com) but the token request was sending platform.claude.com — causing redirect_uri mismatch and 400 Invalid request format on every exchange attempt. Confirmed by 8/8 open-source implementations using the same client_id: all use console.anthropic.com/oauth/code/callback as redirect_uri and console.anthropic.com/v1/oauth/token as primary token endpoint. Also adds user-agent header to token requests as required by Anthropic infrastructure to route OAuth traffic correctly.


## [0.5.1] - 2026-04-07

### Fixed

- **restore executable permission on cli.mjs after git reset** — git reset --hard restores file modes from the index. src/cli.mjs was stored as 100644 (non-executable), causing 'permission denied' after every update. Fixed at three levels: - git index: src/cli.mjs marked 100755 (executable) - update.mjs: chmod +x cli.mjs after reset - install.sh: chmod +x cli.mjs after update reset


## [0.5.0] - 2026-04-07

### Added

- **add --version flag**

### Fixed

- **use clw-auth tui in next-steps output**
- **show full OAuth URL without truncation and return browser status** — The URL was truncated to fit the box width, making it unusable when clipboard copy failed (common on headless Linux). Full URL is now printed outside the box at terminal width so the user can always select and copy it manually. Added xclip install hint for Linux. openBrowser now returns bool so the TUI can report accurate status.


## [0.4.1] - 2026-04-07

### Fixed

- **use git reset --hard <tag> instead of checkout** — git checkout --force still fails when local changes exist in the install directory. git reset --hard <tag> moves HEAD directly to the target tag AND discards all local changes atomically — no separate checkout step needed.
- **reset working tree before checkout to avoid conflicts** — git checkout on a tag fails when there are uncommitted local changes in the install directory. The install dir is managed by clw-auth and local modifications are unexpected — reset --hard before checkout discards them and allows the update to proceed cleanly.


## [0.4.0] - 2026-04-07

### Added

- **register clw-auth update command**
- **add git-based self-update module** — Detects install dir via import.meta.url, checks for a .git repo, fetches remote tags, compares current vs latest, and checkouts the new tag after confirmation. Handles missing git repo, network errors, and already-up-to-date gracefully. No shell reload needed after update since the symlink stays the same — files update in place.

### Fixed

- **use application/x-www-form-urlencoded for OAuth token exchange** — RFC 6749 requires form-encoded bodies for token endpoints, not JSON. Anthropic's token endpoint rejects JSON with 400 Invalid request format. Fixes oauth-exchange and oauth-refresh for all users.
- **clear shell reload prompt and post-install instructions** — If PATH was modified during install, prints a highlighted reload block with the exact source command before showing next steps. In non-interactive mode (curl | sh piped), appends automatically and still shows the reload. Adds clw-auth update to the next-steps block.

### Changed

- **update README to use clw-auth tui as primary command**
- **rename auth-setup to tui as primary command** — clw-auth tui is clearer and shorter. auth-setup kept as alias for backward compatibility via COMMAND_ALIASES.
- **add clw-auth update command and install shell reload notes** — Documents what the installer does step-by-step, explains the shell reload requirement when PATH is modified, adds Update section with clw-auth update usage, and registers update in the Commands table.


## [0.3.0] - 2026-04-07

### Breaking Changes

- **pre-1.0 breaking changes bump minor not major** — When major version is 0, a breaking change bumps minor (0.2→0.3) following SemVer and release-please pre-1.0 convention. Adds --force flag to skip quality check for commits predating the rule.
- **enforce commit body for changelog quality** — feat and fix commits now require a body of at least 20 chars. Breaking changes (! or BREAKING CHANGE) always require a body. Release is blocked with an actionable error listing which commits fail and how to fix them (amend or rebase). Changelog entries now formatted as: - **subject** — body paragraph instead of bare bullet points.
- **update all data dir and plugin path references to clw-auth** — BREAKING CHANGE: data stored at ~/.local/share/clw-auth/. OpenCode plugin now at ~/.config/opencode/plugins/clw-auth-anthropic.mjs.
- **update crontab detection and log path to clw-auth**
- **rename data dir and plugin to clw-auth** — BREAKING CHANGE: plugin now written to clw-auth-anthropic.mjs. Previous claude-oauth-anthropic.mjs added to legacy cleanup list so it is removed automatically on next export run. DATA_DIR inside generated plugin updated to clw-auth.
- **rename data directory from claude-oauth to clw-auth** — BREAKING CHANGE: credentials and config now stored at ~/.local/share/clw-auth/. Existing data at ~/.local/share/claude-oauth/ must be moved manually.
- **rename binary from claude-oauth to clw-auth** — BREAKING CHANGE: the installed binary is now 'clw-auth' instead of 'claude-oauth'. Existing installations need to re-run the installer or rename the symlink manually.

### Added

- **add local release automation script** — npm run release: reads git log since last tag, detects bump type from conventional commits (feat=minor, fix=patch, !=major), updates package.json and CHANGELOG.md, commits chore(release): vX.Y.Z, creates annotated tag, pushes commit and tag. Zero dependencies, interactive confirmation step.
- **add cron-install, cron-status, cron-logs commands** — cron-install: installs cron entry (idempotent, delegates to installCron). cron-status:  shows installed entry, last run from debug.log, lock state, log info. cron-logs [n]: tails last n lines of cron.log (default 50).
- **add installCron, printCronStatus, printCronLogs** — installCron: writes cron entry (0 */6 * * *) idempotently to crontab. printCronStatus: shows installed entry, last run from debug.log, lock state, log path and size. printCronLogs: tails last N lines of cron.log (default 50).
- **add getCronLogPath helper**
- **add one-liner install script for macOS and Linux** — Idempotent shell installer: checks Node >= 18 and git, clones to ~/.local/share/clw-auth, symlinks to ~/.local/bin/claude-oauth. On re-run, fetches latest release tag and updates in-place. Detects shell and offers to patch PATH automatically if not set. Respects NO_COLOR and non-TTY environments.

### Fixed

- **register auth-setup command — clw-auth auth-setup was broken** — auth-setup existed only as an npm script, not as a CLI command. Running 'clw-auth auth-setup' would silently fall through to help. Registers the command and spawns auth-tui.mjs as a subprocess so the TUI gets full terminal control (raw mode, signals, readline).

### Changed

- **add test suite and integrate as pre-release gate** — 70 tests across 4 modules: - store.test.mjs: normalizeAuth (14 cases — oauth, api key, invalid input) - auth.test.mjs: shouldRefreshOauth (7 cases), splitCodeAndState (7 cases) - openclaw.test.mjs: validateConfiguredAuth, buildOauthProfile, buildApiProfile (14 cases) - release.test.mjs: parseCommit, detectBumpType, checkQuality, formatEntry, groupCommits (28 cases) npm run release now runs tests first and blocks on any failure.
- **export pure functions and add isMain guard** — Allows release.mjs to be imported as a module in tests without triggering the interactive main() flow.
- **export pure functions and simplify buildApiProfile** — Exports validateConfiguredAuth, buildOauthProfile, buildApiProfile for unit testing. Removes redundant raw file read from buildApiProfile — since normalizeAuth now preserves the key field, auth.key is always available.
- **export splitCodeAndState for unit testing**
- **export normalizeAuth and support CLW_DATA_DIR env var** — Allows unit tests to import normalizeAuth directly and to isolate filesystem operations by pointing CLW_DATA_DIR to a temp directory.
- **rename project to clw-auth in README and LICENSE** — Updates title, all command examples, structure diagram, and portability section. Preserves ~/.local/share/claude-oauth/ data path references for backward compatibility.
- **update project name in descriptions and user-facing output** — Updates command references and error messages to clw-auth. Preserves data dir paths (~/.local/share/claude-oauth/) and plugin filename (claude-oauth-anthropic.mjs) for backward compatibility.
- **update command references to clw-auth**
- **update BIN_NAME and all --help examples to clw-auth**
- **remove Windows from platform badge, scoped to macOS+Linux**
- **add badges and install section**


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
- **OpenCode exporter** — syncs credentials to `~/.local/share/opencode/auth.json`, generates a self-contained Anthropic auth plugin at `~/.config/opencode/plugins/clw-auth-anthropic.mjs`, and patches `opencode.json` to include the plugin.
- **OpenClaw exporter** — syncs OAuth or API key credentials to `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under the `anthropic:default` profile key.
- **Full CLI** with grouped help, per-command help, and command aliases. All modules loaded via dynamic import to minimize startup cost.
- **`doctor` command** — single-pass diagnostic report combining status, api-ref, config, and upstream sources.
- **JSONL debug log** at `~/.local/share/clw-auth/debug.log` (mode `600`). Credentials never logged.
- Zero npm runtime dependencies — Node.js built-ins only.
- MIT License.

[Unreleased]: https://github.com/4i3n6/clw-auth/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/4i3n6/clw-auth/compare/v0.5.6...v0.6.0
[0.5.6]: https://github.com/4i3n6/clw-auth/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/4i3n6/clw-auth/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/4i3n6/clw-auth/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/4i3n6/clw-auth/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/4i3n6/clw-auth/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/4i3n6/clw-auth/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/4i3n6/clw-auth/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/4i3n6/clw-auth/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/4i3n6/clw-auth/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/4i3n6/clw-auth/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/clw-auth/clw-auth/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/clw-auth/clw-auth/releases/tag/v0.1.0
