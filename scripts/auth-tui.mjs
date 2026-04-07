#!/usr/bin/env node

/**
 * auth-tui.mjs
 *
 * Interactive TUI wizard for clw-auth authentication.
 * Zero runtime dependencies — readline + ANSI escape codes only.
 *
 * Flow:
 *   1. Choose tool: OpenCode | OpenClaw | Both
 *   2. Choose auth method: OAuth | API key
 *   3. Complete authentication
 *   → Show account info: available models with context windows
 *   4. Export credentials to the selected tool(s)
 *   → Summary
 */

import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

// ---------------------------------------------------------------------------
// Environment checks — fail fast with actionable messages
// ---------------------------------------------------------------------------

const NODE_MIN_MAJOR = 18;
const [nodeMajor] = process.versions.node.split('.').map(Number);

if (nodeMajor < NODE_MIN_MAJOR) {
  process.stderr.write(
    `\nError: clw-auth requires Node.js >= ${NODE_MIN_MAJOR}.\n` +
    `  Current version: ${process.versions.node}\n` +
    `  Get a newer version at https://nodejs.org\n\n`,
  );
  process.exit(1);
}

if (!process.stdout.isTTY) {
  process.stderr.write(
    '\nError: auth-tui requires an interactive terminal (TTY).\n' +
    '  Run this command directly in a terminal — do not pipe or redirect it.\n\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = '\x1b[';

const ansi = {
  reset:    `${ESC}0m`,
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  cyan:     `${ESC}36m`,
  green:    `${ESC}32m`,
  yellow:   `${ESC}33m`,
  red:      `${ESC}31m`,
  white:    `${ESC}97m`,
  hide:     `${ESC}?25l`,
  show:     `${ESC}?25h`,
};

const c = {
  bold:    (s) => `${ansi.bold}${s}${ansi.reset}`,
  dim:     (s) => `${ansi.dim}${s}${ansi.reset}`,
  cyan:    (s) => `${ansi.cyan}${s}${ansi.reset}`,
  green:   (s) => `${ansi.green}${s}${ansi.reset}`,
  yellow:  (s) => `${ansi.yellow}${s}${ansi.reset}`,
  red:     (s) => `${ansi.red}${s}${ansi.reset}`,
  white:   (s) => `${ansi.white}${s}${ansi.reset}`,
  success: (s) => `${ansi.bold}${ansi.green}${s}${ansi.reset}`,
  warn:    (s) => `${ansi.bold}${ansi.yellow}${s}${ansi.reset}`,
  err:     (s) => `${ansi.bold}${ansi.red}${s}${ansi.reset}`,
};

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------

// Adapt to actual terminal width; clamp to a readable range.
const TERM_W = typeof process.stdout.columns === 'number' && process.stdout.columns > 0
  ? process.stdout.columns
  : 80;
const W = Math.min(74, Math.max(40, TERM_W - 6));

// Built via constructor — avoids a literal ESC control character inside a regex literal.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function visibleLen(s) {
  return s.replace(ANSI_RE, '').length;
}

function box(lines, { title = '', color = ansi.cyan } = {}) {
  const top = title
    ? `${color}┌─ ${ansi.reset}${c.bold(title)} ${color}${'─'.repeat(Math.max(0, W - title.length - 4))}┐${ansi.reset}`
    : `${color}┌${'─'.repeat(W)}┐${ansi.reset}`;
  const bottom = `${color}└${'─'.repeat(W)}┘${ansi.reset}`;

  const padded = lines.map((line) => {
    const pad = Math.max(0, W - visibleLen(line) - 2);
    return `${color}│${ansi.reset} ${line}${' '.repeat(pad)} ${color}│${ansi.reset}`;
  });

  console.log(top);
  for (const line of padded) console.log(line);
  console.log(bottom);
}

function rule(label = '') {
  if (!label) {
    console.log(c.dim('─'.repeat(W + 2)));
    return;
  }
  const pad = Math.max(0, W - label.length - 2);
  console.log(`${c.dim('─')} ${c.bold(label)} ${c.dim('─'.repeat(pad))}`);
}

function gap(n = 1) {
  for (let i = 0; i < n; i += 1) console.log('');
}

function banner() {
  try { console.clear(); } catch { /* some CI/dumb terminals don't support it */ }

  const title  = '  clw-auth  ';
  const inner  = W + 2;
  const left   = Math.floor((inner - title.length) / 2);
  const right  = inner - title.length - left;

  console.log(`${ansi.bold}${ansi.cyan}╔${'═'.repeat(inner)}╗${ansi.reset}`);
  console.log(`${ansi.bold}${ansi.cyan}║${' '.repeat(left)}${ansi.reset}${ansi.bold}${ansi.white}${title}${ansi.reset}${ansi.bold}${ansi.cyan}${' '.repeat(right)}║${ansi.reset}`);
  console.log(`${ansi.bold}${ansi.cyan}╚${'═'.repeat(inner)}╝${ansi.reset}`);
  gap();
  console.log(`  ${c.dim('Manage Anthropic credentials for OpenCode & OpenClaw.')}`);
  gap();
}

function stepHeader(n, total, title) {
  gap();
  rule(`Step ${n}/${total}: ${title}`);
  gap();
}

function ok(msg)   { console.log(`  ${c.success('✔')}  ${msg}`); }
function fail(msg) { console.log(`  ${c.err('✖')}  ${msg}`); }
function warn(msg) { console.log(`  ${c.warn('!')}  ${msg}`); }
function info(msg) { console.log(`  ${c.cyan('›')}  ${msg}`); }

// ---------------------------------------------------------------------------
// ASCII art logos — shown after tool selection.
// Require >= 82 columns to display without wrapping.
// ---------------------------------------------------------------------------

const LOGO_MIN_WIDTH = 82;

const LOGO_OPENCODE = [
  '██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║   ██║██║  ██║█████╗  ',
  '██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║   ██║██║  ██║██╔══╝  ',
  '╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

const LOGO_OPENCLAW = [
  '        ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗██╗      █████╗ ██╗    ██╗',
  '       ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║     ██╔══██╗██║    ██║',
  '       ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║     ███████║██║ █╗ ██║',
  '       ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║     ██╔══██║██║███╗██║',
  '       ╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗███████╗██║  ██║╚███╔███╔╝',
  '        ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝',
];

function showLogo(tool) {
  if (TERM_W < LOGO_MIN_WIDTH) return;
  gap();
  if (tool === 'opencode' || tool === 'both') {
    for (const line of LOGO_OPENCODE) {
      console.log(`  ${ansi.bold}${ansi.cyan}${line}${ansi.reset}`);
    }
  }
  if (tool === 'both') {
    gap();
    console.log(`  ${c.dim('─'.repeat(Math.min(74, TERM_W - 4)))}`);
    gap();
  }
  if (tool === 'openclaw' || tool === 'both') {
    for (const line of LOGO_OPENCLAW) {
      console.log(`  ${ansi.bold}${ansi.red}${line}${ansi.reset}`);
    }
  }
  gap();
}

// ---------------------------------------------------------------------------
// Terminal state + signal cleanup
// ---------------------------------------------------------------------------

let rawModeActive = false;

function restoreTerminal() {
  try {
    if (rawModeActive && process.stdin.isTTY && !process.stdin.destroyed) {
      process.stdin.setRawMode(false);
      rawModeActive = false;
    }
  } catch { /* best-effort */ }

  process.stdout.write(ansi.show);
}

// Ensure cursor is restored and raw mode is off even on SIGTERM / SIGHUP.
process.on('SIGTERM', () => { restoreTerminal(); process.exit(0); });
process.on('SIGHUP',  () => { restoreTerminal(); process.exit(0); });

// Last-resort handlers for bugs that escape the try/catch in main().
process.on('uncaughtException', (error) => {
  restoreTerminal();
  gap();
  fail(c.err('Unexpected error: ' + (error instanceof Error ? error.message : String(error))));
  gap();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  restoreTerminal();
  gap();
  fail(c.err('Unhandled rejection: ' + (reason instanceof Error ? reason.message : String(reason))));
  gap();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

let rl = null;
let stdinEnded = false;

const MAX_RETRIES = 5;

function createRl() {
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on('SIGINT', () => {
    restoreTerminal();
    gap();
    console.log(c.dim('  Cancelled.'));
    process.exit(0);
  });

  // Handle EOF / stdin closed externally (e.g. disconnected SSH session).
  rl.on('close', () => {
    if (stdinEnded) return; // already handled
    stdinEnded = true;
    restoreTerminal();
    gap();
    console.log(c.dim('  Input closed — exiting.'));
    process.exit(0);
  });
}

function ask(prompt) {
  return new Promise((resolve, reject) => {
    if (stdinEnded) {
      reject(new Error('Input stream was closed.'));
      return;
    }

    if (!rl) {
      reject(new Error('Readline interface not initialized.'));
      return;
    }

    rl.question(`  ${c.cyan('?')}  ${prompt} `, (answer) => {
      if (stdinEnded) {
        reject(new Error('Input stream was closed.'));
        return;
      }
      resolve(typeof answer === 'string' ? answer.trim() : '');
    });
  });
}

async function choose(prompt, choices, defaultIndex = 0) {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('choose() called with no options — this is a bug.');
  }

  const clamped = Math.min(Math.max(defaultIndex, 0), choices.length - 1);

  for (const [i, ch] of choices.entries()) {
    const marker = i === clamped ? c.cyan('›') : ' ';
    console.log(`  ${marker} ${c.bold(String(i + 1))}  ${ch}`);
  }

  gap();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const raw = await ask(`${prompt} [1-${choices.length}]`);
    const n   = raw === '' ? clamped + 1 : Number.parseInt(raw, 10);

    if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
      return n - 1; // 0-indexed
    }

    const remaining = MAX_RETRIES - attempt - 1;
    warn(`Enter a number between 1 and ${choices.length}.${remaining > 0 ? ` (${remaining} attempt${remaining > 1 ? 's' : ''} left)` : ''}`);
  }

  throw new Error(`No valid selection after ${MAX_RETRIES} attempts.`);
}

/**
 * Prompt for sensitive input with character masking.
 * Falls back to visible readline input when raw mode is unavailable.
 */
function secretInput(prompt) {
  // Non-interactive stdin: graceful fallback with a warning.
  if (!process.stdin.isTTY) {
    warn('Terminal does not support hidden input — characters will be visible.');
    return ask(prompt);
  }

  return new Promise((resolve, reject) => {
    if (stdinEnded) {
      reject(new Error('Input stream was closed.'));
      return;
    }

    process.stdout.write(`  ${c.cyan('?')}  ${prompt} `);

    try {
      process.stdin.setRawMode(true);
      rawModeActive = true;
    } catch {
      // setRawMode can fail in some container / CI environments.
      warn('\nRaw mode unavailable — characters will be visible.');
      process.stdout.write('\n');
      resolve(ask(prompt));
      return;
    }

    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';

    function cleanup() {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);

      try {
        process.stdin.setRawMode(false);
        rawModeActive = false;
        process.stdin.pause();
      } catch { /* best-effort */ }
    }

    function onEnd() {
      cleanup();
      stdinEnded = true;
      process.stdout.write('\n');
      restoreTerminal();
      console.log(c.dim('\n  Input closed.'));
      process.exit(0);
    }

    function onData(ch) {
      if (stdinEnded) {
        cleanup();
        reject(new Error('Input stream was closed.'));
        return;
      }

      // CTRL+C
      if (ch === '\u0003') {
        cleanup();
        restoreTerminal();
        gap();
        console.log(c.dim('  Cancelled.'));
        process.exit(0);
      }

      // CTRL+D — EOF in raw mode
      if (ch === '\u0004') {
        cleanup();
        restoreTerminal();
        process.stdout.write('\n');
        console.log(c.dim('  Input closed.'));
        process.exit(0);
      }

      // Enter / carriage return
      if (ch === '\r' || ch === '\n') {
        process.stdout.write('\n');
        cleanup();
        resolve(input);
        return;
      }

      // Backspace (DEL) or BS
      if (ch === '\u007f' || ch === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      // Ignore all other control / escape sequences (arrows, F-keys, etc.)
      if (ch.charCodeAt(0) < 32 || ch.startsWith(String.fromCharCode(27))) {
        return;
      }

      input += ch;
      process.stdout.write('*');
    }

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
  });
}

// ---------------------------------------------------------------------------
// Suppress console.log during auth/exporter calls that emit their own output
// (printResult, etc.) which would corrupt the TUI display.
// ---------------------------------------------------------------------------

function withSuppressedLog(fn) {
  const original = console.log;
  console.log = () => {};
  return Promise.resolve().then(fn).finally(() => {
    console.log = original;
  });
}

// ---------------------------------------------------------------------------
// Error classification — translate low-level errors into actionable messages.
// ---------------------------------------------------------------------------

function classifyError(error) {
  const msg   = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes('enotfound') || lower.includes('getaddrinfo') || lower.includes('fetch failed')) {
    return 'Network error — check your internet connection and try again.';
  }

  if (lower.includes('econnrefused')) {
    return 'Connection refused — Anthropic servers may be temporarily unreachable.';
  }

  if (lower.includes('econnreset')) {
    return 'Connection reset — the network connection was interrupted.';
  }

  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('abort')) {
    return 'Request timed out — check your connection speed and try again.';
  }

  if (lower.includes('status 401') || lower.includes('unauthorized')) {
    return 'Authentication failed (401) — the code may be expired or already used.';
  }

  if (lower.includes('status 400') || lower.includes('bad request')) {
    return 'Invalid request (400) — the pasted code may be malformed.';
  }

  if (lower.includes('status 403') || lower.includes('forbidden')) {
    return 'Access denied (403) — ensure your account has API access at console.anthropic.com.';
  }

  if (lower.includes('status 429') || lower.includes('rate limit')) {
    return 'Rate limited (429) — wait a few seconds before trying again.';
  }

  if (lower.includes('status 5') || lower.includes('internal server') || lower.includes('service unavailable')) {
    return 'Anthropic server error — try again in a moment.';
  }

  if (lower.includes('eacces') || lower.includes('permission denied')) {
    return 'Permission denied — cannot write to the required directory.\n' +
      '       Check that you have write access and re-run.';
  }

  if (lower.includes('enospc') || lower.includes('no space left')) {
    return 'Disk full — free up disk space and try again.';
  }

  if (lower.includes('enoent')) {
    return 'Path not found — a required directory may not exist.\n' +
      '       Run clw-auth once from the CLI first to initialise data paths.';
  }

  if (lower.includes('input stream') || lower.includes('readline')) {
    return msg; // surface as-is; readable already
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Clipboard + browser helpers (best-effort — never throw)
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  const os = platform();

  try {
    if (os === 'darwin') {
      return spawnSync('pbcopy', { input: text, encoding: 'utf8', timeout: 3000 }).status === 0;
    }

    if (os === 'linux') {
      const candidates = [
        ['xclip', ['-selection', 'clipboard']],
        ['xsel',  ['--clipboard', '--input']],
        ['wl-copy', []],   // Wayland
      ];

      for (const [cmd, args] of candidates) {
        const result = spawnSync(cmd, args, { input: text, encoding: 'utf8', timeout: 3000 });
        if (result.status === 0) return true;
      }

      return false;
    }

    if (os === 'win32') {
      return spawnSync('clip', { input: text, encoding: 'utf8', shell: true, timeout: 3000 }).status === 0;
    }
  } catch { /* best-effort */ }

  return false;
}

function openBrowser(url) {
  const os = platform();

  try {
    if (os === 'darwin') {
      return spawnSync('open', [url], { timeout: 5000 }).status === 0;
    }
    if (os === 'win32') {
      return spawnSync('start', ['', url], { shell: true, timeout: 5000 }).status === 0;
    }
    return spawnSync('xdg-open', [url], { timeout: 5000 }).status === 0;
  } catch { /* best-effort */ }

  return false;
}

// ---------------------------------------------------------------------------
// Dynamic imports — paths resolved relative to this script, not cwd.
// This allows running `node /absolute/path/to/auth-tui.mjs` from any directory.
// ---------------------------------------------------------------------------

const loadAuth      = () => import(new URL('../src/auth.mjs',             import.meta.url).href);
const loadStore     = () => import(new URL('../src/store.mjs',            import.meta.url).href);
const loadApiRef    = () => import(new URL('../src/api-reference.mjs',    import.meta.url).href);
const loadExporters = () => import(new URL('../src/exporters/index.mjs',  import.meta.url).href);

async function safeImport(importFn, moduleName) {
  try {
    return await importFn();
  } catch (error) {
    throw new Error(
      `Could not load "${moduleName}": ${error instanceof Error ? error.message : String(error)}\n` +
      '  Make sure you are running this from the clw-auth project root.',
    );
  }
}

// ---------------------------------------------------------------------------
// Anthropic API — available models
//
// GET /v1/models — confirmed endpoint, returns max_input_tokens per model.
// Works with OAuth Bearer token or standard API key (x-api-key).
// Usage/cost stats require an Admin API key — not attempted here.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_BASE    = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const MODELS_TIMEOUT_MS     = 12000;

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

async function fetchModels() {
  const { loadAuth: readAuth, loadJson, getAuthPath } = await safeImport(loadStore, 'store.mjs');
  const auth = readAuth();

  if (!auth || !auth.type) return null;

  const headers = { 'anthropic-version': ANTHROPIC_API_VERSION, 'content-type': 'application/json' };

  if (auth.type === 'oauth') {
    if (!auth.access) return null;
    headers['authorization'] = `Bearer ${auth.access}`;
  } else if (auth.type === 'api') {
    const key = auth.key || (() => { try { return loadJson(getAuthPath()).key; } catch { return null; } })();
    if (!key) return null;
    headers['x-api-key'] = key;
  } else {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);

  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/models?limit=100`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Tool selection
// ---------------------------------------------------------------------------

async function stepSelectTool() {
  stepHeader(1, 4, 'Tool Selection');

  info('Which tool are you setting up authentication for?');
  gap();

  const idx = await choose('Select tool', [
    'OpenCode',
    'OpenClaw',
    'Both  (OpenCode + OpenClaw)',
  ], 0);

  const tool  = idx === 0 ? 'opencode' : idx === 1 ? 'openclaw' : 'both';
  const label = tool === 'both' ? 'OpenCode + OpenClaw' : tool === 'opencode' ? 'OpenCode' : 'OpenClaw';

  ok(`Configuring: ${c.bold(label)}`);
  showLogo(tool);

  return tool;
}

// ---------------------------------------------------------------------------
// Step 2 — Auth method
// ---------------------------------------------------------------------------

async function stepAuthMethod() {
  stepHeader(2, 4, 'Authentication Method');

  const idx = await choose('How do you want to authenticate?', [
    'OAuth  (recommended — automatic token refresh)',
    'API Key',
  ]);

  return idx === 0 ? 'oauth' : 'api';
}

// ---------------------------------------------------------------------------
// Step 3a — OAuth flow
// ---------------------------------------------------------------------------

async function stepOauth() {
  stepHeader(3, 4, 'OAuth Authentication');

  const { buildOauthUrl, oauthExchange } = await safeImport(loadAuth, 'auth.mjs');

  let url;

  try {
    url = buildOauthUrl();
  } catch (error) {
    throw new Error('Failed to generate OAuth URL: ' + classifyError(error));
  }

  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('Generated OAuth URL is invalid. This is likely a bug — please open an issue.');
  }

  const copied = copyToClipboard(url);
  const browserOpened = openBrowser(url);

  box([
    c.bold('1.  Open this URL in your browser:'),
    '',
    c.bold('2.  Complete the Anthropic login.'),
    c.bold('3.  Copy the callback URL from the address bar.'),
  ], { title: 'Browser Login' });

  gap();

  // Always print the full URL outside the box — never truncate — so the
  // user can select and copy it manually even when clipboard is unavailable.
  console.log(`  ${ansi.cyan}${url}${ansi.reset}`);
  gap();

  if (copied) {
    ok('URL copied to clipboard.');
  } else {
    warn('Clipboard unavailable — select and copy the URL above manually.');
    if (process.platform === 'linux') {
      info('Install xclip for auto-copy: ' + c.dim('sudo apt install xclip'));
    }
  }

  if (browserOpened) {
    ok('Browser opened automatically.');
  } else {
    warn('Could not open browser automatically — open the URL above manually.');
  }

  gap();
  info('After login, paste the full callback URL or the ' + c.dim('code#state') + ' value:');
  gap();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let input;

    try {
      input = await ask('Paste code#state or callback URL:');
    } catch (error) {
      throw new Error('Could not read input: ' + classifyError(error));
    }

    if (!input) {
      const remaining = MAX_RETRIES - attempt - 1;
      warn(`Input cannot be empty.${remaining > 0 ? ` (${remaining} attempt${remaining > 1 ? 's' : ''} left)` : ''}`);

      if (remaining === 0) {
        throw new Error(`No input after ${MAX_RETRIES} attempts.`);
      }

      continue;
    }

    try {
      process.stdout.write(`\n  ${c.dim('Exchanging tokens with Anthropic...')} `);
      process.stdout.write(ansi.hide);

      await withSuppressedLog(() => oauthExchange(input));

      process.stdout.write(ansi.show);
      gap();
      ok('OAuth tokens saved successfully.');
      return;
    } catch (error) {
      process.stdout.write(ansi.show);
      gap();
      fail(classifyError(error));
      gap();

      const remaining = MAX_RETRIES - attempt - 1;

      if (remaining === 0) {
        throw new Error(`OAuth exchange failed after ${MAX_RETRIES} attempts.`);
      }

      const retry = await choose(`Try again? (${remaining} attempt${remaining > 1 ? 's' : ''} left)`, ['Yes', 'No — cancel']);

      if (retry === 1) {
        throw new Error('OAuth exchange cancelled.');
      }

      gap();
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3b — API key flow
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY_RE = /^sk-ant-/;

function looksLikeAnthropicKey(key) {
  return typeof key === 'string' && key.length >= 20 && ANTHROPIC_KEY_RE.test(key);
}

async function stepApiKey() {
  stepHeader(3, 4, 'API Key');

  info('Get your key at: ' + c.cyan('https://console.anthropic.com/settings/keys'));
  info('Expected format: ' + c.dim('sk-ant-api03-...'));
  gap();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let key;

    try {
      key = await secretInput('Anthropic API key (hidden):');
    } catch (error) {
      throw new Error('Could not read key: ' + classifyError(error));
    }

    if (!key || !key.trim()) {
      const remaining = MAX_RETRIES - attempt - 1;
      warn(`Key cannot be empty.${remaining > 0 ? ` (${remaining} attempt${remaining > 1 ? 's' : ''} left)` : ''}`);

      if (remaining === 0) {
        throw new Error(`No key entered after ${MAX_RETRIES} attempts.`);
      }

      continue;
    }

    const trimmed = key.trim();

    // Soft format validation — warn but don't block.
    if (!looksLikeAnthropicKey(trimmed)) {
      gap();
      warn("This doesn't look like an Anthropic API key (expected: sk-ant-...).");

      const proceed = await choose('Continue anyway?', ['Yes — try it', 'No — re-enter']);

      if (proceed === 1) {
        gap();
        attempt += 1;
        continue;
      }
    }

    try {
      const { setApiKey } = await safeImport(loadAuth, 'auth.mjs');
      const { generateApiReference } = await safeImport(loadApiRef, 'api-reference.mjs');

      process.stdout.write(`\n  ${c.dim('Saving key and updating api-reference.json...')} `);
      process.stdout.write(ansi.hide);

      await withSuppressedLog(() => setApiKey(trimmed));
      await withSuppressedLog(() => Promise.resolve(generateApiReference()));

      process.stdout.write(ansi.show);
      gap();
      ok('API key saved and api-reference.json updated.');
      return;
    } catch (error) {
      process.stdout.write(ansi.show);
      gap();
      fail(classifyError(error));
      gap();

      const remaining = MAX_RETRIES - attempt - 1;

      if (remaining === 0) {
        throw new Error(`Failed to save API key after ${MAX_RETRIES} attempts.`);
      }

      const retry = await choose(`Try again? (${remaining} attempt${remaining > 1 ? 's' : ''} left)`, ['Yes', 'No — cancel']);

      if (retry === 1) {
        throw new Error('API key entry cancelled.');
      }

      gap();
    }
  }
}

// ---------------------------------------------------------------------------
// Account info — models table
//
// Shown automatically after successful authentication.
// Fetches GET /v1/models (confirmed endpoint, returns max_input_tokens).
// Usage/cost stats require an Admin API key — not available here.
// ---------------------------------------------------------------------------

async function showAccountInfo() {
  gap();
  rule('Account');
  gap();

  process.stdout.write(`  ${c.dim('Fetching available models...')} `);
  process.stdout.write(ansi.hide);
  const models = await fetchModels();
  process.stdout.write(ansi.show);
  process.stdout.write(ansi.clearLine);

  if (!models || models.length === 0) {
    warn('Could not fetch model list — verify credentials or check connectivity.');
  } else {
    const sorted = [...models].sort((a, b) => (b.display_name || b.id).localeCompare(a.display_name || a.id));
    const COL_NAME = Math.min(40, Math.floor(W * 0.55));
    const COL_CTX  = 8;
    const COL_OUT  = 7;

    console.log(c.dim(`  ${'Model'.padEnd(COL_NAME)} ${'Context'.padStart(COL_CTX)} ${'Output'.padStart(COL_OUT)}`));
    console.log(c.dim(`  ${'─'.repeat(COL_NAME + COL_CTX + COL_OUT + 2)}`));

    for (const model of sorted) {
      const name = (model.display_name || model.id || '').slice(0, COL_NAME).padEnd(COL_NAME);
      const ctx  = formatTokens(model.max_input_tokens).padStart(COL_CTX);
      const out  = formatTokens(model.max_tokens).padStart(COL_OUT);
      console.log(`  ${c.bold(name)} ${c.cyan(ctx)} ${c.dim(out)}`);
    }

    gap();
    ok(`${sorted.length} model${sorted.length !== 1 ? 's' : ''} available.`);
  }

  gap();
  rule('Usage & Billing');
  gap();
  info('Usage stats require an Admin API key — not available via standard auth.');
  info('Usage:   ' + c.cyan('https://console.anthropic.com/settings/usage'));
  info('Billing: ' + c.cyan('https://console.anthropic.com/settings/billing'));
  gap();
}

// ---------------------------------------------------------------------------
// Step 4 — Export credentials to the selected tool(s)
// ---------------------------------------------------------------------------

async function stepExport(tool) {
  stepHeader(4, 4, 'Export Credentials');

  const { loadAuth: readAuth } = await safeImport(loadStore, 'store.mjs');
  const auth    = readAuth();
  const isOauth = auth && auth.type === 'oauth';

  const wantsOpenCode = tool === 'opencode' || tool === 'both';
  const wantsOpenClaw = tool === 'openclaw' || tool === 'both';

  if (wantsOpenCode && !isOauth) {
    warn('OpenCode requires OAuth authentication.');
    info('Re-run with OAuth to export to OpenCode: ' + c.bold('clw-auth export opencode'));
    if (!wantsOpenClaw) return;
    gap();
  }

  const doOpenCode = wantsOpenCode && isOauth;
  const doOpenClaw = wantsOpenClaw;

  if (!doOpenCode && !doOpenClaw) return;

  gap();

  let runExporter;

  try {
    ({ runExporter } = await safeImport(loadExporters, 'exporters/index.mjs'));
  } catch (error) {
    fail('Could not load exporters: ' + classifyError(error));
    info('Export manually: ' + c.bold('clw-auth export opencode') + ' / ' + c.bold('clw-auth export openclaw'));
    return;
  }

  if (doOpenCode) {
    try {
      process.stdout.write(`  ${c.dim('Exporting to OpenCode...')} `);
      process.stdout.write(ansi.hide);
      await withSuppressedLog(() => runExporter('opencode'));
      process.stdout.write(ansi.show);
      ok('OpenCode export complete.');
    } catch (error) {
      process.stdout.write(ansi.show);
      fail('OpenCode: ' + classifyError(error));
      info('Retry: ' + c.bold('clw-auth export opencode'));
    }
  }

  if (doOpenClaw) {
    try {
      process.stdout.write(`  ${c.dim('Exporting to OpenClaw...')} `);
      process.stdout.write(ansi.hide);
      await withSuppressedLog(() => runExporter('openclaw'));
      process.stdout.write(ansi.show);
      ok('OpenClaw export complete.');
    } catch (error) {
      process.stdout.write(ansi.show);
      fail('OpenClaw: ' + classifyError(error));
      info('Retry: ' + c.bold('clw-auth export openclaw'));
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function showSummary() {
  gap();
  rule('Done');
  gap();

  try {
    const { generateApiReference, loadApiReference } = await safeImport(loadApiRef, 'api-reference.mjs');

    await withSuppressedLog(() => Promise.resolve(generateApiReference()));

    const ref = loadApiReference();

    if (ref && ref.auth_type) {
      ok(`Auth type:   ${c.bold(ref.auth_type)}`);
    }

    if (ref && ref.token_expires) {
      const expired   = ref.token_expired === true;
      const expiresAt = new Date(ref.token_expires).toLocaleString();

      if (expired) {
        fail(`Token:       expired (${expiresAt})`);
        warn('Renew with: ' + c.bold('clw-auth refresh'));
      } else {
        ok(`Token:       valid until ${c.bold(expiresAt)}`);
      }
    }
  } catch (error) {
    warn('Could not generate summary: ' + classifyError(error));
  }

  gap();
  info('Full diagnostic: ' + c.bold('clw-auth doctor'));
  info('Check status:    ' + c.bold('clw-auth status'));
  info('Manual export:   ' + c.bold('clw-auth export opencode'));
  gap();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  banner();
  createRl();

  try {
    const tool   = await stepSelectTool();
    const method = await stepAuthMethod();

    if (method === 'oauth') {
      await stepOauth();
    } else {
      await stepApiKey();
    }

    await showAccountInfo();
    await stepExport(tool);
    await showSummary();
  } catch (error) {
    gap();
    fail(c.err(classifyError(error)));
    gap();
    process.exitCode = 1;
  } finally {
    restoreTerminal();

    if (rl) {
      try {
        rl.removeAllListeners('close');
        rl.close();
      } catch { /* best-effort */ }
    }
  }
}

main();
