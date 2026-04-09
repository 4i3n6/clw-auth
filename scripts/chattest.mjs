#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';

import { loadConfig } from '../src/config.mjs';
import { getAuthPath, getConfigPath, loadAuth, loadJson } from '../src/store.mjs';

const NODE_MIN_MAJOR = 18;
const [nodeMajor] = process.versions.node.split('.').map(Number);

if (nodeMajor < NODE_MIN_MAJOR) {
  process.stderr.write(
    `\nError: clw-auth chattest requires Node.js >= ${NODE_MIN_MAJOR}.\n` +
    `  Current version: ${process.versions.node}\n\n`,
  );
  process.exit(1);
}

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  process.stderr.write(
    '\nError: chattest requires an interactive terminal (TTY).\n' +
    '  Run this command directly in a terminal — do not pipe or redirect it.\n\n',
  );
  process.exit(1);
}

const ESC = '\x1b[';
const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  white: `${ESC}97m`,
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
};

const c = {
  bold: (value) => `${ansi.bold}${value}${ansi.reset}`,
  dim: (value) => `${ansi.dim}${value}${ansi.reset}`,
  cyan: (value) => `${ansi.cyan}${value}${ansi.reset}`,
  green: (value) => `${ansi.green}${value}${ansi.reset}`,
  yellow: (value) => `${ansi.yellow}${value}${ansi.reset}`,
  red: (value) => `${ansi.red}${value}${ansi.reset}`,
  white: (value) => `${ansi.white}${value}${ansi.reset}`,
};

const move = (row, col) => `\x1b[${row};${col}H`;
const clearScreen = () => process.stdout.write('\x1b[2J\x1b[H');
const clearLine = () => process.stdout.write('\x1b[2K\r');

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const ESCAPE_SEQUENCE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const ESCAPE_CHAR_RE = new RegExp(String.fromCharCode(27), 'g');
const CONTROL_CHARS_RE = new RegExp('[\\x00-\\x08\\x0B-\\x1F\\x7F]', 'g');
const PRIMARY_MODEL = 'claude-haiku-4-5';
const FALLBACK_MODEL = 'claude-3-5-haiku-20241022';
const API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const BILLING_HASH_SALT = '59cf53e54c78';
const BILLING_HASH_INDICES = [4, 7, 20];
const CC_SESSION_ID = randomUUID();
const MAX_RENDER_FPS = 30;
const FRAME_MS = Math.floor(1000 / MAX_RENDER_FPS);
const STAINLESS_HEADER_COUNT = 8;

const state = {
  width: process.stdout.columns || 80,
  height: process.stdout.rows || 24,
  inputBuffer: '',
  messages: [],
  conversation: [],
  isRequestInFlight: false,
  renderTimer: null,
  lastRenderAt: 0,
  cleanedUp: false,
  activeAbortController: null,
  activeRequestTimeout: null,
  authPath: getAuthPath(),
  configPath: getConfigPath(),
  authState: { type: 'none' },
  config: loadConfig(),
  lastRequest: buildEmptyLastRequest(),
};

function buildEmptyLastRequest() {
  return {
    model: PRIMARY_MODEL,
    fallbackUsed: false,
    httpStatus: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    streaming: null,
    error: '',
    sessionId: '',
    authHeaderName: 'authorization',
    billingFingerprint: '',
  };
}

function visibleLen(value) {
  return String(value).replace(ANSI_RE, '').length;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizeForDisplay(value) {
  return String(value ?? '')
    .replace(ESCAPE_SEQUENCE_RE, '')
    .replace(ESCAPE_CHAR_RE, '')
    .replace(CONTROL_CHARS_RE, '');
}

function ellipsizeEnd(value, max) {
  const text = sanitizeForDisplay(value);

  if (max <= 0) {
    return '';
  }

  if (text.length <= max) {
    return text;
  }

  if (max <= 1) {
    return text.slice(0, max);
  }

  return `${text.slice(0, max - 1)}…`;
}

function ellipsizeStart(value, max) {
  const text = sanitizeForDisplay(value);

  if (max <= 0) {
    return '';
  }

  if (text.length <= max) {
    return text;
  }

  if (max <= 1) {
    return text.slice(-max);
  }

  return `…${text.slice(-(max - 1))}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return 'n/a';
  }

  if (ms <= 0) {
    return 'expired';
  }

  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${Math.max(1, minutes)}m`;
  }

  return `${hours}h ${minutes}m`;
}

function wrapPlainText(value, width) {
  const safeWidth = Math.max(1, width);
  const text = sanitizeForDisplay(value).replace(/\r/g, '');
  const paragraphs = text.split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > safeWidth) {
      let breakAt = remaining.lastIndexOf(' ', safeWidth);
      if (breakAt <= 0) {
        breakAt = safeWidth;
      }

      const segment = remaining.slice(0, breakAt).trimEnd();
      lines.push(segment || remaining.slice(0, safeWidth));
      remaining = remaining.slice(breakAt).trimStart();
    }

    lines.push(remaining);
  }

  return lines.length > 0 ? lines : [''];
}

function padAnsi(value, width) {
  const pad = Math.max(0, width - visibleLen(value));
  return `${value}${' '.repeat(pad)}`;
}

function renderPanel(title, width, innerLines, totalHeight) {
  const safeWidth = Math.max(8, width);
  const innerHeight = Math.max(1, totalHeight - 2);
  const fitted = fitTop(innerLines, innerHeight);
  const top = title
    ? `┌─ ${title} ${'─'.repeat(Math.max(0, safeWidth - title.length - 5))}┐`
    : `┌${'─'.repeat(safeWidth - 2)}┐`;
  const bottom = `└${'─'.repeat(safeWidth - 2)}┘`;
  const lines = [top];

  for (const line of fitted) {
    lines.push(`│${padAnsi(line, safeWidth - 2)}│`);
  }

  lines.push(bottom);
  return lines;
}

function renderChatPanel(width, totalHeight) {
  const safeWidth = Math.max(16, width);
  const contentHeight = Math.max(1, totalHeight - 4);
  const contentLines = fitBottom(buildChatLines(safeWidth - 3), contentHeight);
  const paddedContent = padBottom(contentLines, contentHeight);
  const separator = `├${'─'.repeat(safeWidth - 2)}┤`;
  const inputLine = buildInputLine(safeWidth - 3);
  const lines = [
    `┌─ Chat ${'─'.repeat(Math.max(0, safeWidth - 9))}┐`,
    ...paddedContent.map((line) => `│ ${padAnsi(line, safeWidth - 3)}│`),
    separator,
    `│ ${padAnsi(inputLine, safeWidth - 3)}│`,
    `└${'─'.repeat(safeWidth - 2)}┘`,
  ];

  return lines;
}

function padBottom(lines, size) {
  const result = [...lines];
  while (result.length < size) {
    result.push('');
  }
  return result;
}

function fitTop(lines, limit) {
  if (lines.length <= limit) {
    return padBottom(lines, limit);
  }

  if (limit <= 1) {
    return [c.dim(' …')];
  }

  return [...lines.slice(0, limit - 1), c.dim(' …')];
}

function fitBottom(lines, limit) {
  if (lines.length <= limit) {
    return lines;
  }

  return lines.slice(-limit);
}

function joinSideBySide(leftLines, rightLines, gap = ' ') {
  const output = [];
  const length = Math.max(leftLines.length, rightLines.length);

  for (let index = 0; index < length; index += 1) {
    output.push(`${leftLines[index] || ''}${gap}${rightLines[index] || ''}`);
  }

  return output;
}

function statusSymbol(kind) {
  if (kind === 'ok') {
    return c.green('✓');
  }

  if (kind === 'error') {
    return c.red('✗');
  }

  return c.yellow('●');
}

function bulletLines(kind, text, width) {
  const symbolPlain = kind === 'ok' ? '✓' : kind === 'error' ? '✗' : '●';
  const prefixPlain = `${symbolPlain} `;
  const prefixAnsi = `${statusSymbol(kind)} `;
  const wrapped = wrapPlainText(text, Math.max(1, width - prefixPlain.length));

  return wrapped.map((segment, index) => (index === 0
    ? `${prefixAnsi}${segment}`
    : `${' '.repeat(prefixPlain.length)}${segment}`
  ));
}

function rolePrefix(role) {
  if (role === 'user') {
    return {
      plain: 'You: ',
      ansi: `${ansi.bold}${ansi.cyan}You:${ansi.reset} `,
    };
  }

  if (role === 'assistant') {
    return {
      plain: 'Claude: ',
      ansi: `${ansi.bold}${ansi.green}Claude:${ansi.reset} `,
    };
  }

  if (role === 'error') {
    return {
      plain: 'Error: ',
      ansi: `${ansi.bold}${ansi.red}Error:${ansi.reset} `,
    };
  }

  return {
    plain: 'Info: ',
    ansi: `${ansi.bold}${ansi.yellow}Info:${ansi.reset} `,
  };
}

function messageLines(message, width) {
  const prefix = rolePrefix(message.role);
  const wrapped = wrapPlainText(message.text, Math.max(1, width - prefix.plain.length));
  const lines = wrapped.map((segment, index) => {
    const head = index === 0 ? prefix.ansi : ' '.repeat(prefix.plain.length);
    return `${head}${segment}`;
  });

  if (message.streaming) {
    if (lines.length === 0) {
      lines.push(`${prefix.ansi}${c.yellow('▌')}`);
    } else {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${c.yellow('▌')}`;
    }
  }

  return lines;
}

function buildBanner(width) {
  const inner = Math.max(10, width - 2);
  const title = 'clw-auth chattest';
  const left = Math.max(0, Math.floor((inner - title.length) / 2));
  const right = Math.max(0, inner - title.length - left);

  return [
    `${ansi.bold}${ansi.cyan}╔${'═'.repeat(inner)}╗${ansi.reset}`,
    `${ansi.bold}${ansi.cyan}║${' '.repeat(left)}${ansi.reset}${ansi.bold}${ansi.white}${title}${ansi.reset}${ansi.bold}${ansi.cyan}${' '.repeat(right)}║${ansi.reset}`,
    `${ansi.bold}${ansi.cyan}╚${'═'.repeat(inner)}╝${ansi.reset}`,
    '',
  ];
}

function buildInputLine(width) {
  const prefix = '> ';
  const suffix = state.isRequestInFlight ? c.dim('[waiting]') : c.dim('_');
  const available = Math.max(1, width - prefix.length - visibleLen(suffix) - 1);
  const input = state.inputBuffer
    ? ellipsizeStart(state.inputBuffer, available)
    : '';

  return `${prefix}${input}${input ? ' ' : ''}${suffix}`;
}

function buildChatLines(width) {
  const lines = [];

  if (state.messages.length === 0) {
    return [c.dim(' Ready. Type a prompt and press Enter to test streaming.')];
  }

  for (const message of state.messages) {
    lines.push(...messageLines(message, Math.max(12, width - 1)).map((line) => ` ${line}`));
    lines.push('');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function buildConnectionLines(width) {
  const textWidth = Math.max(10, width - 3);
  const lines = [];
  const authState = state.authState;
  const config = state.config;
  const request = state.lastRequest;
  const betaCount = Array.isArray(config.betaHeaders) ? config.betaHeaders.length : 0;
  const betaPreview = betaCount > 0
    ? config.betaHeaders.slice(0, 2).join(', ')
    : '(none)';
  const userAgent = isNonEmptyString(config.userAgent) ? config.userAgent : '(missing)';

  lines.push(` ${c.bold('Auth')}`);
  lines.push(...bulletLines(
    authState.type === 'none' ? 'error' : 'ok',
    `Type: ${authState.type === 'oauth' ? 'OAuth' : authState.type === 'api' ? 'API' : 'none'}`,
    textWidth,
  ));

  if (authState.type === 'api') {
    lines.push(...bulletLines(authState.key ? 'ok' : 'error', `Key: ${authState.key ? 'present' : 'missing'}`, textWidth));
    lines.push(...bulletLines('info', 'Expires: n/a', textWidth));
    lines.push(...bulletLines('info', 'Not expired: n/a', textWidth));
  } else if (authState.type === 'oauth') {
    lines.push(...bulletLines(authState.accessToken ? 'ok' : 'error', `Token: ${authState.accessToken ? 'present' : 'missing'}`, textWidth));
    lines.push(...bulletLines(
      authState.expires === null ? 'error' : authState.expired ? 'error' : 'ok',
      `Expires: ${authState.expires === null ? 'missing' : formatDuration(authState.expires - Date.now())}`,
      textWidth,
    ));
    lines.push(...bulletLines(authState.expired ? 'error' : 'ok', `Not expired: ${authState.expired ? 'no' : 'yes'}`, textWidth));
  } else {
    lines.push(...bulletLines('error', 'Token: missing', textWidth));
    lines.push(...bulletLines('info', 'Expires: n/a', textWidth));
    lines.push(...bulletLines('error', 'Not expired: no auth', textWidth));
  }

  lines.push('');
  lines.push(` ${c.bold('Config')}`);
  lines.push(...bulletLines(isNonEmptyString(config.ccVersion) ? 'ok' : 'error', `CC version: ${config.ccVersion || '(missing)'}`, textWidth));
  lines.push(...bulletLines(betaCount > 0 ? 'ok' : 'info', `Beta headers: ${betaCount}`, textWidth));
  lines.push(`   ${c.dim(ellipsizeEnd(betaPreview, Math.max(1, textWidth - 3)))}`);
  lines.push(...bulletLines(isNonEmptyString(userAgent) ? 'ok' : 'error', `User-agent: ${ellipsizeEnd(userAgent, Math.max(8, textWidth - 12))}`, textWidth));

  lines.push('');
  lines.push(` ${c.bold('Last Request')}`);
  if (request.httpStatus === null && !request.error) {
    lines.push(...bulletLines('info', 'No requests yet', textWidth));
  } else {
    const httpKind = request.httpStatus >= 200 && request.httpStatus < 300 ? 'ok' : 'error';
    lines.push(...bulletLines(httpKind, `HTTP: ${request.httpStatus ?? 'n/a'}`, textWidth));
    lines.push(...bulletLines('info', `Latency: ${Number.isFinite(request.latencyMs) ? `${request.latencyMs}ms` : 'n/a'}`, textWidth));
    lines.push(...bulletLines('info', `Input tokens: ${Number.isFinite(request.inputTokens) ? request.inputTokens : 'n/a'}`, textWidth));
    lines.push(...bulletLines('info', `Output tokens: ${Number.isFinite(request.outputTokens) ? request.outputTokens : 'n/a'}`, textWidth));
    lines.push(...bulletLines(
      request.streaming === 'ok' ? 'ok' : request.streaming === 'failed' ? 'error' : 'info',
      `Streaming: ${request.streaming || 'pending'}`,
      textWidth,
    ));
    lines.push(...bulletLines('info', `Model: ${request.model}`, textWidth));
    if (request.fallbackUsed) {
      lines.push(...bulletLines('info', `Fallback: ${FALLBACK_MODEL}`, textWidth));
    }
    if (request.error) {
      lines.push(...bulletLines('error', `Error: ${request.error}`, textWidth));
    }
  }

  lines.push('');
  lines.push(` ${c.bold('Headers Sent')}`);
  const authHeaderLabel = request.authHeaderName || (authState.type === 'api' ? 'x-api-key' : 'authorization');
  lines.push(...bulletLines(authState.type === 'none' ? 'error' : 'ok', authHeaderLabel, textWidth));
  lines.push(...bulletLines(betaCount > 0 ? 'ok' : 'info', `anthropic-beta (${betaCount})`, textWidth));
  lines.push(...bulletLines('ok', 'x-app: cli', textWidth));
  lines.push(...bulletLines(request.sessionId ? 'ok' : 'info', 'x-claude-code-session-id', textWidth));
  lines.push(...bulletLines(request.billingFingerprint ? 'ok' : 'info', 'billing fingerprint', textWidth));
  lines.push(...bulletLines('ok', `x-stainless-* (${STAINLESS_HEADER_COUNT} headers)`, textWidth));

  return lines;
}

function buildFooter(width) {
  const footer = state.isRequestInFlight
    ? 'q/Ctrl+C: quit | Enter: wait | Ctrl+L: clear after response'
    : 'q/Ctrl+C: quit | Enter: send | Ctrl+L: clear chat';

  return ` ${c.dim(ellipsizeEnd(footer, Math.max(1, width - 1)))}`;
}

function buildWideFrame() {
  const width = Math.max(80, state.width);
  const height = Math.max(18, state.height);
  const gap = 1;
  const chatWidth = Math.max(44, Math.floor((width - gap) * 0.62));
  const sidebarWidth = Math.max(24, width - gap - chatWidth);
  const banner = buildBanner(state.width);
  const footer = buildFooter(state.width);
  const paneHeight = Math.max(8, height - banner.length - 1);
  const chat = renderChatPanel(chatWidth, paneHeight);
  const sidebar = renderPanel('Connection', sidebarWidth, buildConnectionLines(sidebarWidth), paneHeight);
  const joined = joinSideBySide(chat, sidebar, ' ');

  return [...banner, ...joined, footer].join('\n');
}

function buildCompactFrame() {
  const width = Math.max(40, state.width);
  const height = Math.max(18, state.height);
  const banner = buildBanner(width);
  const footer = buildFooter(width);
  const remaining = Math.max(8, height - banner.length - 1);
  const statusHeight = Math.max(8, Math.min(16, Math.floor(remaining * 0.45)));
  const chatHeight = Math.max(8, remaining - statusHeight);
  const status = renderPanel('Connection', width, buildConnectionLines(width), statusHeight);
  const chat = renderChatPanel(width, chatHeight);

  return [...banner, ...status, ...chat, footer].join('\n');
}

function render() {
  state.width = process.stdout.columns || state.width || 80;
  state.height = process.stdout.rows || state.height || 24;
  state.lastRenderAt = Date.now();

  clearLine();
  clearScreen();
  process.stdout.write(move(1, 1));
  process.stdout.write(state.width < 80 ? buildCompactFrame() : buildWideFrame());
}

function scheduleRender(force = false) {
  if (force) {
    if (state.renderTimer) {
      clearTimeout(state.renderTimer);
      state.renderTimer = null;
    }

    render();
    return;
  }

  if (state.renderTimer) {
    return;
  }

  const elapsed = Date.now() - state.lastRenderAt;
  const delay = elapsed >= FRAME_MS ? 0 : FRAME_MS - elapsed;

  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    render();
  }, delay);
}

function safeLoadRawAuth() {
  try {
    const raw = loadJson(state.authPath);
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

function resolveAuthState(auth, rawAuth) {
  const storedType = isNonEmptyString(auth.type)
    ? auth.type.trim()
    : isNonEmptyString(rawAuth.type)
      ? rawAuth.type.trim()
      : '';

  if (storedType === 'api' || isNonEmptyString(rawAuth.key)) {
    const key = isNonEmptyString(rawAuth.key)
      ? rawAuth.key.trim()
      : isNonEmptyString(auth.key)
        ? auth.key.trim()
        : isNonEmptyString(rawAuth.access) && rawAuth.type === 'api'
          ? rawAuth.access.trim()
          : isNonEmptyString(auth.access) && auth.type === 'api'
            ? auth.access.trim()
            : '';

    return {
      type: 'api',
      key,
      expired: false,
      expires: null,
    };
  }

  if (
    storedType === 'oauth'
    || isNonEmptyString(auth.access)
    || isNonEmptyString(rawAuth.access)
    || isNonEmptyString(auth.refresh)
    || isNonEmptyString(rawAuth.refresh)
  ) {
    const accessToken = isNonEmptyString(auth.access)
      ? auth.access.trim()
      : isNonEmptyString(rawAuth.access)
        ? rawAuth.access.trim()
        : '';
    const refreshToken = isNonEmptyString(auth.refresh)
      ? auth.refresh.trim()
      : isNonEmptyString(rawAuth.refresh)
        ? rawAuth.refresh.trim()
        : '';
    const normalizedExpires = Number(auth.expires);
    const rawExpires = Number(rawAuth.expires);
    const expires = Number.isFinite(normalizedExpires)
      ? normalizedExpires
      : Number.isFinite(rawExpires)
        ? rawExpires
        : null;

    return {
      type: 'oauth',
      accessToken,
      refreshToken,
      expires,
      expired: !Number.isFinite(expires) || expires <= Date.now(),
    };
  }

  return { type: 'none', expired: true, expires: null };
}

function refreshRuntimeState() {
  let auth = {};

  try {
    auth = loadAuth();
  } catch {
    auth = {};
  }

  try {
    state.config = loadConfig();
  } catch {
    state.config = {
      betaHeaders: [],
      userAgent: '',
      ccVersion: '0.0.0',
    };
  }

  state.authState = resolveAuthState(auth, safeLoadRawAuth());
}

function pushMessage(role, text, options = {}) {
  const message = {
    role,
    text: sanitizeForDisplay(text),
    streaming: Boolean(options.streaming),
  };

  state.messages.push(message);
  return state.messages.length - 1;
}

function seedStartupMessages() {
  pushMessage('system', 'Ready. Type a prompt and press Enter to test Anthropic API streaming.');

  if (state.authState.type === 'none') {
    pushMessage('error', 'No authentication is configured. Run clw-auth tui, oauth-exchange, or api first.');
    return;
  }

  if (state.authState.type === 'api' && !state.authState.key) {
    pushMessage('error', 'API key authentication is selected, but the stored key is missing.');
    return;
  }

  if (state.authState.type === 'oauth' && !state.authState.accessToken) {
    pushMessage('error', 'OAuth authentication is selected, but the stored access token is missing.');
    return;
  }

  if (state.authState.type === 'oauth' && state.authState.expired) {
    pushMessage('error', 'The stored OAuth token is expired. Run clw-auth refresh and try again.');
  }
}

function clearChat() {
  state.messages = [];
  state.conversation = [];

  if (state.authState.type === 'none') {
    pushMessage('error', 'No authentication is configured.');
  } else if (state.authState.type === 'oauth' && state.authState.expired) {
    pushMessage('error', 'The stored OAuth token is expired.');
  }

  scheduleRender(true);
}

function computeBillingFingerprint(text) {
  const chars = BILLING_HASH_INDICES.map((index) => text[index] || '0').join('');
  const input = BILLING_HASH_SALT + chars + state.config.ccVersion;
  return createHash('sha256').update(input).digest('hex').slice(0, 3);
}

function buildBillingSystemBlock(userMessage) {
  const fingerprint = computeBillingFingerprint(userMessage);

  return {
    fingerprint,
    block: {
      type: 'text',
      text: `x-anthropic-billing-header: cc_version=${state.config.ccVersion}.${fingerprint}; cc_entrypoint=cli; cch=00000;`,
    },
  };
}

function buildRequestHeaders(authState) {
  const osName = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : 'Linux';
  const arch = process.arch === 'arm64'
    ? 'arm64'
    : process.arch === 'x64'
      ? 'x64'
      : process.arch;
  const headers = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'user-agent': state.config.userAgent,
    'x-app': 'cli',
    'x-claude-code-session-id': CC_SESSION_ID,
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': osName,
    'x-stainless-package-version': '0.81.0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'anthropic-dangerous-direct-browser-access': 'true',
  };

  if (Array.isArray(state.config.betaHeaders) && state.config.betaHeaders.length > 0) {
    headers['anthropic-beta'] = state.config.betaHeaders.join(',');
  }

  if (authState.type === 'api') {
    headers['x-api-key'] = authState.key;
  } else {
    headers.authorization = `Bearer ${authState.accessToken}`;
  }

  return headers;
}

function extractErrorMessage(raw) {
  const text = sanitizeForDisplay(raw).trim();

  if (!text) {
    return 'Request failed.';
  }

  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed.error) && isNonEmptyString(parsed.error.message)) {
      return sanitizeForDisplay(parsed.error.message);
    }
    if (isNonEmptyString(parsed.message)) {
      return sanitizeForDisplay(parsed.message);
    }
  } catch {
    // Fall through to plain text.
  }

  return ellipsizeEnd(text.replace(/\s+/g, ' '), 220);
}

function shouldRetryWithFallback(status, message, model) {
  if (model !== PRIMARY_MODEL) {
    return false;
  }

  if (status !== 400 && status !== 404) {
    return false;
  }

  return /model|unknown|not found|not available|unsupported/i.test(message);
}

function updateUsageFromEvent(payload) {
  if (isRecord(payload.message) && isRecord(payload.message.usage)) {
    const inputTokens = Number(payload.message.usage.input_tokens);
    const outputTokens = Number(payload.message.usage.output_tokens);

    if (Number.isFinite(inputTokens)) {
      state.lastRequest.inputTokens = inputTokens;
    }

    if (Number.isFinite(outputTokens)) {
      state.lastRequest.outputTokens = outputTokens;
    }
  }

  if (isRecord(payload.usage)) {
    const inputTokens = Number(payload.usage.input_tokens);
    const outputTokens = Number(payload.usage.output_tokens);

    if (Number.isFinite(inputTokens)) {
      state.lastRequest.inputTokens = inputTokens;
    }

    if (Number.isFinite(outputTokens)) {
      state.lastRequest.outputTokens = outputTokens;
    }
  }
}

function parseSseEvent(rawEvent, assistantIndex) {
  const lines = rawEvent.split('\n');
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return;
  }

  const payloadText = dataLines.join('\n').trim();

  if (!payloadText || payloadText === '[DONE]') {
    return;
  }

  const payload = JSON.parse(payloadText);
  updateUsageFromEvent(payload);

  if (payload.type === 'error') {
    throw new Error(extractErrorMessage(JSON.stringify(payload)));
  }

  if (
    payload.type === 'content_block_start'
    && isRecord(payload.content_block)
    && payload.content_block.type === 'text'
    && isNonEmptyString(payload.content_block.text)
  ) {
    state.messages[assistantIndex].text += sanitizeForDisplay(payload.content_block.text);
    scheduleRender();
    return;
  }

  if (
    payload.type === 'content_block_delta'
    && isRecord(payload.delta)
    && payload.delta.type === 'text_delta'
    && isNonEmptyString(payload.delta.text)
  ) {
    state.messages[assistantIndex].text += sanitizeForDisplay(payload.delta.text);
    scheduleRender();
  }
}

async function readStreamingResponse(response, assistantIndex) {
  if (!response.body) {
    throw new Error('Streaming response body is not available.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      if (rawEvent.trim()) {
        parseSseEvent(rawEvent, assistantIndex);
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    parseSseEvent(trailing, assistantIndex);
  }
}

async function attemptRequest(model, requestConversation, userMessage, assistantIndex, startedAt) {
  const authState = state.authState;
  const billing = buildBillingSystemBlock(userMessage);
  const headers = buildRequestHeaders(authState);
  const controller = state.activeAbortController;
  const body = {
    model,
    max_tokens: 1024,
    stream: true,
    system: [billing.block],
    messages: requestConversation,
  };

  state.lastRequest.model = model;
  state.lastRequest.sessionId = CC_SESSION_ID;
  state.lastRequest.billingFingerprint = billing.fingerprint;
  state.lastRequest.authHeaderName = authState.type === 'api' ? 'x-api-key' : 'authorization';
  state.lastRequest.streaming = 'pending';
  state.lastRequest.error = '';
  scheduleRender(true);

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller ? controller.signal : undefined,
  });

  state.lastRequest.httpStatus = response.status;
  state.lastRequest.latencyMs = Date.now() - startedAt;
  scheduleRender(true);

  if (!response.ok) {
    const rawBody = await response.text();
    const message = extractErrorMessage(rawBody);

    return {
      ok: false,
      retryWithFallback: shouldRetryWithFallback(response.status, message, model),
      message,
    };
  }

  await readStreamingResponse(response, assistantIndex);

  return {
    ok: true,
    retryWithFallback: false,
    message: '',
  };
}

async function submitInput() {
  const userMessage = state.inputBuffer.trim();

  if (!userMessage || state.isRequestInFlight) {
    return;
  }

  refreshRuntimeState();
  pushMessage('user', userMessage);
  state.inputBuffer = '';

  if (state.authState.type === 'none') {
    state.lastRequest = {
      ...buildEmptyLastRequest(),
      authHeaderName: 'authorization',
      streaming: 'failed',
      error: 'No authentication is configured.',
    };
    pushMessage('error', 'No authentication is configured.');
    scheduleRender(true);
    return;
  }

  if (state.authState.type === 'api' && !state.authState.key) {
    state.lastRequest = {
      ...buildEmptyLastRequest(),
      authHeaderName: 'x-api-key',
      streaming: 'failed',
      error: 'Stored API key is missing.',
    };
    pushMessage('error', 'Stored API key is missing.');
    scheduleRender(true);
    return;
  }

  if (state.authState.type === 'oauth' && !state.authState.accessToken) {
    state.lastRequest = {
      ...buildEmptyLastRequest(),
      authHeaderName: 'authorization',
      streaming: 'failed',
      error: 'Stored OAuth access token is missing.',
    };
    pushMessage('error', 'Stored OAuth access token is missing.');
    scheduleRender(true);
    return;
  }

  if (state.authState.type === 'oauth' && state.authState.expired) {
    pushMessage('error', 'Stored OAuth token appears expired. Attempting request anyway for troubleshooting.');
  }

  const requestConversation = [...state.conversation, { role: 'user', content: userMessage }];
  const assistantIndex = pushMessage('assistant', '', { streaming: true });
  const startedAt = Date.now();

  state.isRequestInFlight = true;
  state.activeAbortController = new AbortController();
  state.activeRequestTimeout = setTimeout(() => {
    if (state.activeAbortController) {
      state.activeAbortController.abort();
    }
  }, 600000);
  state.lastRequest = {
    ...buildEmptyLastRequest(),
    authHeaderName: state.authState.type === 'api' ? 'x-api-key' : 'authorization',
  };
  scheduleRender(true);

  try {
    let result = await attemptRequest(PRIMARY_MODEL, requestConversation, userMessage, assistantIndex, startedAt);

    if (result.retryWithFallback) {
      state.lastRequest.fallbackUsed = true;
      pushMessage('system', `Primary model unavailable. Retrying with ${FALLBACK_MODEL}.`);
      scheduleRender(true);
      result = await attemptRequest(FALLBACK_MODEL, requestConversation, userMessage, assistantIndex, startedAt);
    }

    if (!result.ok) {
      state.lastRequest.streaming = 'failed';
      state.lastRequest.error = result.message;

      if (!state.messages[assistantIndex].text) {
        state.messages.splice(assistantIndex, 1);
      } else {
        state.messages[assistantIndex].streaming = false;
      }

      pushMessage('error', result.message);
      scheduleRender(true);
      return;
    }

    state.messages[assistantIndex].streaming = false;
    if (!state.messages[assistantIndex].text.trim()) {
      state.messages[assistantIndex].text = '(No text content returned.)';
    }

    state.conversation = [
      ...requestConversation,
      { role: 'assistant', content: state.messages[assistantIndex].text },
    ];
    state.lastRequest.streaming = 'ok';
    scheduleRender(true);
  } catch (error) {
    const message = error instanceof Error ? sanitizeForDisplay(error.message) : sanitizeForDisplay(String(error));

    state.lastRequest.streaming = 'failed';
    state.lastRequest.error = message;

    if (!state.messages[assistantIndex]?.text) {
      state.messages.splice(assistantIndex, 1);
    } else if (state.messages[assistantIndex]) {
      state.messages[assistantIndex].streaming = false;
    }

    pushMessage('error', message === 'This operation was aborted'
      ? 'Request aborted.'
      : message);
    scheduleRender(true);
  } finally {
    state.isRequestInFlight = false;

    if (state.activeRequestTimeout) {
      clearTimeout(state.activeRequestTimeout);
      state.activeRequestTimeout = null;
    }

    state.activeAbortController = null;
    scheduleRender(true);
  }
}

function handleKeypress(key) {
  if (key === '\u0003') {
    exitGracefully(0);
    return;
  }

  if (key === '\u0004') {
    exitGracefully(0);
    return;
  }

  if (key === '\u000c') {
    if (!state.isRequestInFlight) {
      clearChat();
    }
    return;
  }

  if ((key === '\r' || key === '\n') && !state.isRequestInFlight) {
    void submitInput();
    return;
  }

  if (key === '\u007f' || key === '\b' || key === '\u0008') {
    state.inputBuffer = state.inputBuffer.slice(0, -1);
    scheduleRender(true);
    return;
  }

  if (key === 'q' && state.inputBuffer.length === 0) {
    exitGracefully(0);
    return;
  }

  if (key.charCodeAt(0) < 32 || key.startsWith(String.fromCharCode(27))) {
    return;
  }

  state.inputBuffer += key;
  scheduleRender(true);
}

function handleInput(data) {
  if (typeof data !== 'string' || data.length === 0) {
    return;
  }

  if (data.startsWith(String.fromCharCode(27))) {
    return;
  }

  for (const key of data) {
    handleKeypress(key);
  }
}

function cleanup() {
  if (state.cleanedUp) {
    return;
  }

  state.cleanedUp = true;

  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }

  if (state.activeRequestTimeout) {
    clearTimeout(state.activeRequestTimeout);
    state.activeRequestTimeout = null;
  }

  if (state.activeAbortController) {
    try {
      state.activeAbortController.abort();
    } catch {
      // Best effort.
    }
  }

  try {
    if (process.stdin.isTTY && !process.stdin.destroyed) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  } catch {
    // Best effort.
  }

  try {
    process.stdout.write(ansi.show);
    process.stdout.write('\x1b[0m');
    process.stdout.write('\x1b[?1049l');
  } catch {
    // Best effort.
  }
}

function exitGracefully(code) {
  cleanup();
  process.exit(code);
}

process.on('exit', cleanup);
process.on('SIGINT', () => exitGracefully(0));
process.on('SIGTERM', () => exitGracefully(0));
process.on('SIGWINCH', () => scheduleRender(true));
process.on('uncaughtException', (error) => {
  cleanup();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nError: ${message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  cleanup();
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`\nError: ${message}\n`);
  process.exit(1);
});

function main() {
  refreshRuntimeState();
  seedStartupMessages();

  process.stdout.write('\x1b[?1049h');
  process.stdout.write(ansi.hide);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handleInput);
  process.stdin.on('end', () => exitGracefully(0));

  scheduleRender(true);
}

main();
