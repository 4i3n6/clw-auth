import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.mjs';
import { loadAuth, loadApiRef } from '../store.mjs';
import { compareVersions } from '../upstream.mjs';

const PACKAGE_VERSION = createRequire(import.meta.url)('../../package.json').version;
const PLUGIN_META_MARKER = '// clw-auth-plugin-meta:';

const CLW_DATA_DIR = join(homedir(), '.local', 'share', 'clw-auth');
const OPENCODE_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');
const OPENCODE_CONFIG_JSONC_PATH = join(homedir(), '.config', 'opencode', 'opencode.jsonc');
const OPENCODE_PLUGIN_PATH = join(homedir(), '.config', 'opencode', 'plugins', 'clw-auth-anthropic.mjs');
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';
const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  schemaVersion: 1,
  betaHeaders: [
    'oauth-2025-04-20',
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'advanced-tool-use-2025-11-20',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'effort-2025-11-24',
    'fast-mode-2026-02-01',
  ],
  userAgent: 'claude-cli/2.1.97 (external, cli)',
});
const OH_MY_PLUGIN_ANCHORS = new Set(['oh-my-opencode@latest', 'oh-my-openagent@latest']);
const LEGACY_PLUGIN_NAMES = new Set([
  'opencode-anthropic-auth-patched.mjs',
  'claude-oauth-anthropic.mjs',
]);
const GENERATED_PLUGIN_NAME = 'clw-auth-anthropic.mjs';

const BETA_HEADER_PATHS = [
  ['betaHeaders'],
  ['beta_headers'],
  ['headers', 'betaHeaders'],
  ['headers', 'beta_headers'],
  ['headers', 'anthropic-beta'],
  ['anthropic', 'betaHeaders'],
  ['anthropic', 'beta_headers'],
  ['anthropic', 'headers', 'betaHeaders'],
  ['anthropic', 'headers', 'beta_headers'],
  ['anthropic', 'headers', 'anthropic-beta'],
  ['runtime', 'betaHeaders'],
  ['runtime', 'beta_headers'],
  ['config', 'betaHeaders'],
  ['config', 'beta_headers'],
];

const USER_AGENT_PATHS = [
  ['userAgent'],
  ['user_agent'],
  ['headers', 'userAgent'],
  ['headers', 'user_agent'],
  ['headers', 'user-agent'],
  ['anthropic', 'userAgent'],
  ['anthropic', 'user_agent'],
  ['anthropic', 'headers', 'userAgent'],
  ['anthropic', 'headers', 'user_agent'],
  ['anthropic', 'headers', 'user-agent'],
  ['runtime', 'userAgent'],
  ['runtime', 'user_agent'],
  ['config', 'userAgent'],
  ['config', 'user_agent'],
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJsonFile(filePath, fallbackValue = {}) {
  ensureParent(filePath);

  if (!existsSync(filePath)) {
    return cloneJsonValue(fallbackValue);
  }

  const rawValue = readFileSync(filePath, 'utf8');

  if (!rawValue.trim()) {
    return cloneJsonValue(fallbackValue);
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stripJsonComments(rawText) {
  let output = '';
  let i = 0;

  let inString = false;
  let stringQuote = '';
  let inEscape = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < rawText.length) {
    const current = rawText[i];
    const next = rawText[i + 1] ?? '';

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        output += current;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inString) {
      output += current;
      if (inEscape) {
        inEscape = false;
        i += 1;
        continue;
      }

      if (current === '\\') {
        inEscape = true;
      } else if (current === stringQuote) {
        inString = false;
      }

      i += 1;
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      stringQuote = current;
    }

    output += current;
    i += 1;
  }

  return output;
}

function normalizeJsoncText(rawText) {
  const stripped = stripJsonComments(rawText);
  return stripped.replace(/,\s*([}]|])/g, '$1');
}

function readJsoncFile(filePath, fallbackValue = {}) {
  ensureParent(filePath);

  if (!existsSync(filePath)) {
    return cloneJsonValue(fallbackValue);
  }

  const rawValue = readFileSync(filePath, 'utf8');

  if (!rawValue.trim()) {
    return cloneJsonValue(fallbackValue);
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    try {
      const normalized = normalizeJsoncText(rawValue);
      return JSON.parse(normalized);
    } catch (jsoncError) {
      const parsedError = jsoncError instanceof Error ? jsoncError.message : String(jsoncError);
      throw new Error(
        `Failed to parse JSON/JSONC at ${filePath}: ${error instanceof Error ? error.message : String(error)}; normalized parse: ${parsedError}`,
      );
    }
  }
}

function resolveOpenCodeConfigPath() {
  if (existsSync(OPENCODE_CONFIG_JSONC_PATH)) {
    return OPENCODE_CONFIG_JSONC_PATH;
  }
  return OPENCODE_CONFIG_PATH;
}


function writeTextAtomic(filePath, payload, mode = 0o600) {
  ensureParent(filePath);

  const temporaryPath = join(dirname(filePath), `.tmp-${process.pid}-${Date.now()}`);

  writeFileSync(temporaryPath, payload, { mode });
  chmodSync(temporaryPath, mode);

  try {
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, mode);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }

    throw error;
  }
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function normalizeAuth(auth) {
  if (!isPlainObject(auth)) {
    return {};
  }

  const normalized = {};

  if (typeof auth.type === 'string' && auth.type.trim()) {
    normalized.type = auth.type.trim();
  }

  if (typeof auth.access === 'string' && auth.access) {
    normalized.access = auth.access;
  }

  if (typeof auth.refresh === 'string' && auth.refresh) {
    normalized.refresh = auth.refresh;
  }

  const expires = Number(auth.expires);
  if (Number.isFinite(expires)) {
    normalized.expires = expires;
  }

  return normalized;
}

function validateOauthAuth(auth) {
  const normalizedAuth = normalizeAuth(auth);

  if (normalizedAuth.type !== 'oauth') {
    throw new Error('OpenCode exporter requires OAuth credentials. Run: clw-auth oauth-url');
  }

  if (!normalizedAuth.access) {
    throw new Error('auth.json is missing the OAuth access token. Run: clw-auth oauth-url');
  }

  if (!normalizedAuth.refresh) {
    throw new Error('auth.json is missing the OAuth refresh token. Run: clw-auth oauth-url');
  }

  if (!Number.isFinite(normalizedAuth.expires) || normalizedAuth.expires <= 0) {
    throw new Error('auth.json is missing a valid OAuth expiry timestamp. Run: clw-auth refresh');
  }

  return normalizedAuth;
}

function getNestedValue(source, pathSegments) {
  let currentValue = source;

  for (const segment of pathSegments) {
    if (!isPlainObject(currentValue) || !(segment in currentValue)) {
      return undefined;
    }

    currentValue = currentValue[segment];
  }

  return currentValue;
}

function pickNestedValue(source, candidatePaths) {
  for (const candidatePath of candidatePaths) {
    const value = getNestedValue(source, candidatePath);

    if (typeof value !== 'undefined') {
      return value;
    }
  }

  return undefined;
}

function normalizeBetaHeaders(value, fallbackValue) {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);

    return normalized.length > 0 ? normalized : [...fallbackValue];
  }

  if (typeof value === 'string') {
    const normalized = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    return normalized.length > 0 ? normalized : [...fallbackValue];
  }

  return [...fallbackValue];
}

function normalizeUserAgent(value, fallbackValue) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return fallbackValue;
}

function extractRuntimeConfigDefaults(apiRef) {
  const source = isPlainObject(apiRef) ? apiRef : {};
  const betaHeaders = normalizeBetaHeaders(
    pickNestedValue(source, BETA_HEADER_PATHS),
    DEFAULT_RUNTIME_CONFIG.betaHeaders,
  );
  const userAgent = normalizeUserAgent(
    pickNestedValue(source, USER_AGENT_PATHS),
    DEFAULT_RUNTIME_CONFIG.userAgent,
  );

  return {
    schemaVersion: DEFAULT_RUNTIME_CONFIG.schemaVersion,
    betaHeaders,
    userAgent,
  };
}

function updateOpenCodeAuth(auth) {
  const currentAuthStore = readJsonFile(OPENCODE_AUTH_PATH, {});

  if (!isPlainObject(currentAuthStore)) {
    throw new Error(`OpenCode auth file must contain a JSON object: ${OPENCODE_AUTH_PATH}`);
  }

  const nextAuthStore = {
    ...currentAuthStore,
    anthropic: normalizeAuth(auth),
  };

  writeJsonAtomic(OPENCODE_AUTH_PATH, nextAuthStore, 0o600);

  return {
    path: OPENCODE_AUTH_PATH,
    preservedProviders: Object.keys(currentAuthStore).filter((providerName) => providerName !== 'anthropic').length,
  };
}

function isPluginReferenceMatch(reference, fileName) {
  if (typeof reference !== 'string') {
    return false;
  }

  return reference === fileName || reference.endsWith(`/${fileName}`) || reference.includes(`${fileName}?`);
}

function patchOpenCodeConfig(pluginUri) {
  const configPath = resolveOpenCodeConfigPath();
  const readConfig = configPath.endsWith('.jsonc') ? readJsoncFile : readJsonFile;
  const currentConfig = readConfig(configPath, {});

  if (!isPlainObject(currentConfig)) {
    throw new Error(`OpenCode config file must contain a JSON object: ${configPath}`);
  }

  const currentPlugins = Array.isArray(currentConfig.plugin) ? [...currentConfig.plugin] : [];
  const nextPlugins = [];
  let removedLegacyPlugins = 0;

  for (const pluginEntry of currentPlugins) {
    if ([...LEGACY_PLUGIN_NAMES].some((name) => isPluginReferenceMatch(pluginEntry, name))) {
      removedLegacyPlugins += 1;
      continue;
    }

    if (pluginEntry === pluginUri || isPluginReferenceMatch(pluginEntry, GENERATED_PLUGIN_NAME)) {
      continue;
    }

    nextPlugins.push(pluginEntry);
  }

  const anchorIndex = nextPlugins.findIndex(
    (pluginEntry) => typeof pluginEntry === 'string' && OH_MY_PLUGIN_ANCHORS.has(pluginEntry),
  );

  if (anchorIndex >= 0) {
    nextPlugins.splice(anchorIndex + 1, 0, pluginUri);
  } else {
    nextPlugins.push(pluginUri);
  }

  const nextConfig = {
    ...currentConfig,
    plugin: nextPlugins,
  };

  if (typeof nextConfig.$schema !== 'string' || !nextConfig.$schema.trim()) {
    nextConfig.$schema = OPENCODE_SCHEMA_URL;
  }

  writeJsonAtomic(configPath, nextConfig, 0o600);

  return {
    path: configPath,
    pluginUri,
    pluginCount: nextPlugins.length,
    removedLegacyPlugins,
    insertedAfter: anchorIndex >= 0 ? nextPlugins[anchorIndex] : null,
  };
}

function buildPluginSource(defaultRuntimeConfig, ccVersion, deviceId) {
  const serializedDefaultConfig = JSON.stringify(defaultRuntimeConfig, null, 2);
  // Plugin meta header — read by inspectInstall() to detect stale plugins after
  // clw-auth upgrades. The version is the clw-auth that generated the plugin;
  // bumping it on every release flips installed plugins to "outdated" so
  // `clw-auth update` can reapply them automatically.
  const pluginMeta = JSON.stringify({
    exporter: 'opencode',
    clwVersion: PACKAGE_VERSION,
    generatedAt: new Date().toISOString(),
  });

  return [
    `${PLUGIN_META_MARKER} ${pluginMeta}`,
    "import {",
    "  appendFileSync,",
    "  chmodSync,",
    "  existsSync,",
    "  mkdirSync,",
    "  readFileSync,",
    "  renameSync,",
    "  unlinkSync,",
    "  writeFileSync,",
    "} from 'node:fs';",
    "import { randomBytes, createHash, randomUUID } from 'node:crypto';",
    "import { homedir } from 'node:os';",
    "import { dirname, join } from 'node:path';",
    '',
    "const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';",
    "const PLATFORM_HOST = 'platform.claude.com';",
    "const LEGACY_CONSOLE_HOST = 'console.anthropic.com';",
    "const TOKEN_ENDPOINTS = [",
    "  'https://' + PLATFORM_HOST + '/v1/oauth/token',",
    "  'https://' + LEGACY_CONSOLE_HOST + '/v1/oauth/token',",
    "];",
    "const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];",
    "const TOOL_PREFIX = 'mcp_';",
    // Billing fingerprint constants — must match real CC's utils/fingerprint.ts.
    // CC_VERSION and CC_DEVICE_ID are baked in at export time; SESSION_ID refreshes per process.
    `const CC_VERSION = '${ccVersion}';`,
    `const CC_DEVICE_ID = '${deviceId}';`,
    "const CC_SESSION_ID = randomUUID();",
    "const BILLING_HASH_SALT = '59cf53e54c78';",
    "const BILLING_HASH_INDICES = [4, 7, 20];",
    'let ACTIVE_TOOL_ALIAS_MAP = {};',
    "const DATA_DIR = join(homedir(), '.local', 'share', 'clw-auth');",
    "const AUTH_PATH = join(DATA_DIR, 'auth.json');",
    "const CONFIG_PATH = join(DATA_DIR, 'config.json');",
    "const DEBUG_LOG_PATH = join(homedir(), '.local', 'state', 'opencode', 'anthropic-auth-debug.log');",
    `const DEFAULT_RUNTIME_CONFIG = ${serializedDefaultConfig};`,
    '',
    'function ensureParent(filePath) {',
    "  mkdirSync(dirname(filePath), { recursive: true });",
    '}',
    '',
    'function isPlainObject(value) {',
    "  return value !== null && typeof value === 'object' && !Array.isArray(value);",
    '}',
    '',
    'function debugLog(event, details = {}) {',
    '  try {',
    '    ensureParent(DEBUG_LOG_PATH);',
    '    appendFileSync(DEBUG_LOG_PATH, JSON.stringify({',
    "      ts: new Date().toISOString(),",
    '      event,',
    '      details,',
    "    }) + '\\n', { mode: 0o600 });",
    '    chmodSync(DEBUG_LOG_PATH, 0o600);',
    '  } catch {',
    '    // Ignore debug logging failures.',
    '  }',
    '}',
    '',
    'function loadJson(filePath) {',
    '  ensureParent(filePath);',
    '',
    '  if (!existsSync(filePath)) {',
    '    return {};',
    '  }',
    '',
    '  return JSON.parse(readFileSync(filePath, \"utf8\"));',
    '}',
    '',
    'function writeJsonAtomic(filePath, value, mode = 0o600) {',
    '  ensureParent(filePath);',
    '',
    "  const temporaryPath = join(dirname(filePath), '.tmp-' + process.pid + '-' + Date.now());",
    "  const payload = JSON.stringify(value, null, 2) + '\\n';",
    '',
    '  writeFileSync(temporaryPath, payload, { mode });',
    '  chmodSync(temporaryPath, mode);',
    '',
    '  try {',
    '    renameSync(temporaryPath, filePath);',
    '    chmodSync(filePath, mode);',
    '  } catch (error) {',
    '    if (existsSync(temporaryPath)) {',
    '      unlinkSync(temporaryPath);',
    '    }',
    '',
    '    throw error;',
    '  }',
    '}',
    '',
    'function normalizeAuth(auth) {',
    '  if (!isPlainObject(auth)) {',
    '    return {};',
    '  }',
    '',
    '  const normalized = {};',
    '',
    "  if (typeof auth.type === 'string' && auth.type.trim()) {",
    '    normalized.type = auth.type.trim();',
    '  }',
    '',
    "  if (typeof auth.access === 'string' && auth.access) {",
    '    normalized.access = auth.access;',
    '  }',
    '',
    "  if (typeof auth.refresh === 'string' && auth.refresh) {",
    '    normalized.refresh = auth.refresh;',
    '  }',
    '',
    "  if (typeof auth.expires === 'number' || typeof auth.expires === 'string') {",
    '    normalized.expires = auth.expires;',
    '  }',
    '',
    '  return normalized;',
    '}',
    '',
    'function normalizeConfig(rawConfig) {',
    '  const source = isPlainObject(rawConfig) ? rawConfig : {};',
    '',
    '  const schemaVersion = source.schemaVersion === DEFAULT_RUNTIME_CONFIG.schemaVersion',
    '    ? source.schemaVersion',
    '    : DEFAULT_RUNTIME_CONFIG.schemaVersion;',
    '',
    '  const betaHeaders = Array.isArray(source.betaHeaders)',
    '    ? source.betaHeaders',
    "      .filter((value) => typeof value === 'string')",
    '      .map((value) => value.trim())',
    '      .filter(Boolean)',
    '    : [...DEFAULT_RUNTIME_CONFIG.betaHeaders];',
    '',
    "  const userAgent = typeof source.userAgent === 'string' && source.userAgent.trim()",
    '    ? source.userAgent.trim()',
    '    : DEFAULT_RUNTIME_CONFIG.userAgent;',
    '',
    '  return {',
    '    schemaVersion,',
    '    betaHeaders,',
    '    userAgent,',
    '  };',
    '}',
    '',
    'function loadSharedAuth() {',
    '  try {',
    '    return normalizeAuth(loadJson(AUTH_PATH));',
    '  } catch (error) {',
    "    debugLog('shared_auth_load_failed', {",
    "      message: error instanceof Error ? error.message : String(error),",
    '    });',
    '    return {};',
    '  }',
    '}',
    '',
    'function persistSharedAuth(auth) {',
    '  writeJsonAtomic(AUTH_PATH, normalizeAuth(auth), 0o600);',
    '}',
    '',
    'function loadSharedConfig() {',
    '  try {',
    '    return normalizeConfig(loadJson(CONFIG_PATH));',
    '  } catch (error) {',
    "    debugLog('shared_config_load_failed', {",
    "      message: error instanceof Error ? error.message : String(error),",
    '    });',
    '    return normalizeConfig(DEFAULT_RUNTIME_CONFIG);',
    '  }',
    '}',
    '',
    'function sleep(ms) {',
    '  return new Promise((resolve) => setTimeout(resolve, ms));',
    '}',
    '',
    'async function parseError(response) {',
    '  const text = await response.text();',
    '',
    '  try {',
    '    const json = JSON.parse(text);',
    "    const message = json && (json.error_description || (json.error && json.error.message) || text);",
    '    return message || response.statusText;',
    '  } catch {',
    '    return text || response.statusText;',
    '  }',
    '}',
    '',
    'async function exchangeWithEndpoint(url, payload) {',
    '  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {',
    '    const result = await fetch(url, {',
    "      method: 'POST',",
    '      headers: {',
    "        accept: 'application/json',",
    "        'content-type': 'application/json',",
    '      },',
    '      body: JSON.stringify(payload),',
    '    });',
    '',
    '    if (result.ok) {',
    '      return {',
    '        ok: true,',
    '        endpoint: url,',
    '        json: await result.json(),',
    '      };',
    '    }',
    '',
    '    const message = await parseError(result);',
    "    const retryAfterHeader = result.headers.get('retry-after');",
    '    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;',
    '    const retryDelay = Number.isFinite(retryAfterSeconds)',
    '      ? retryAfterSeconds * 1000',
    '      : RATE_LIMIT_RETRY_DELAYS_MS[attempt];',
    '    const isLastAttempt = attempt === RATE_LIMIT_RETRY_DELAYS_MS.length;',
    '',
    "    debugLog('exchange_response', {",
    '      endpoint: url,',
    '      attempt,',
    '      status: result.status,',
    '      message,',
    '      retryAfterHeader,',
    '      retryDelay,',
    '      isLastAttempt,',
    '    });',
    '',
    '    if (result.status !== 429 || typeof retryDelay !== \"number\" || isLastAttempt) {',
    '      return {',
    '        ok: false,',
    '        status: result.status,',
    '        message,',
    '        endpoint: url,',
    '      };',
    '    }',
    '',
    '    await sleep(retryDelay);',
    '  }',
    '',
    '  return {',
    '    ok: false,',
    '    status: 429,',
    "    message: 'Rate limited after retrying Anthropic OAuth endpoint.',",
    '    endpoint: null,',
    '  };',
    '}',
    '',
    'async function requestTokens(payload, context) {',
    '  let failure = null;',
    '',
    '  for (const endpoint of TOKEN_ENDPOINTS) {',
    '    const result = await exchangeWithEndpoint(endpoint, payload);',
    '',
    '    debugLog(context + \"_attempt\", {',
    '      endpoint,',
    '      ok: result.ok,',
    '      status: result.ok ? 200 : result.status,',
    '      message: result.ok ? \"success\" : result.message,',
    '    });',
    '',
    '    if (result.ok) {',
    '      return result;',
    '    }',
    '',
    '    failure = result;',
    '  }',
    '',
    '  debugLog(context + \"_failed\", {',
    '    endpoint: failure && failure.endpoint,',
    '    status: failure && failure.status,',
    '    message: failure && failure.message,',
    '  });',
    '',
    '  return {',
    '    ok: false,',
    '    status: failure && failure.status,',
    "    message: (failure && failure.message) || 'Token exchange failed during Anthropic OAuth flow.',",
    '    endpoint: failure && failure.endpoint,',
    '  };',
    '}',
    '',
    'function buildOauthCredential(tokenResponse, currentRefresh) {',
    "  if (!tokenResponse || typeof tokenResponse.access_token !== 'string' || !tokenResponse.access_token) {",
    "    throw new Error('OAuth token response did not include access_token.');",
    '  }',
    '',
    "  if (typeof tokenResponse.expires_in !== 'number') {",
    "    throw new Error('OAuth token response did not include expires_in.');",
    '  }',
    '',
    '  const refreshToken = tokenResponse.refresh_token || currentRefresh;',
    '',
    '  if (!refreshToken) {',
    "    throw new Error('OAuth token response did not include refresh_token.');",
    '  }',
    '',
    '  return {',
    "    type: 'oauth',",
    '    refresh: refreshToken,',
    '    access: tokenResponse.access_token,',
    '    expires: Date.now() + tokenResponse.expires_in * 1000,',
    '  };',
    '}',
    '',
    'async function syncOpenCodeAuth(client, auth) {',
    '  try {',
    "    if (!client || !client.auth || typeof client.auth.set !== 'function') {",
    '      return;',
    '    }',
    '',
    '    await client.auth.set({',
    '      path: {',
    "        id: 'anthropic',",
    '      },',
    '      body: auth,',
    '    });',
    '  } catch (error) {',
    "    debugLog('opencode_auth_sync_failed', {",
    "      message: error instanceof Error ? error.message : String(error),",
    '    });',
    '  }',
    '}',
    '',
    'async function refreshOauthCredential(client, auth) {',
    '  const previousRefresh = auth && auth.refresh;',
    '',
    "  debugLog('refresh_start', {",
    '    hasRefresh: Boolean(auth && auth.refresh),',
    '    expires: auth && auth.expires,',
    '  });',
    '',
    '  const result = await requestTokens({',
    "    grant_type: 'refresh_token',",
    '    refresh_token: auth.refresh,',
    '    client_id: CLIENT_ID,',
    "  }, 'refresh');",
    '',
    '  if (!result.ok) {',
    "    throw new Error('Token refresh failed: ' + result.status + ' ' + result.message + ' (' + result.endpoint + ')');",
    '  }',
    '',
    '  const nextAuth = buildOauthCredential(result.json, auth && auth.refresh);',
    '  persistSharedAuth(nextAuth);',
    '  await syncOpenCodeAuth(client, nextAuth);',
    '',
    "  debugLog('refresh_success', {",
    '    endpoint: result.endpoint,',
    '    expires: nextAuth.expires,',
    '    refreshRotated: nextAuth.refresh !== previousRefresh,',
    '  });',
    '',
    '  return nextAuth;',
    '}',
    '',
    // ── Hybrid refresh: delegate to `clw-auth ensure-fresh` first ────────────
    // Why: `clw-auth ensure-fresh` uses an inter-process file lock so the
    // plugin, the cron, and any other clw-auth caller serialize correctly.
    // Anthropic rotates the refresh_token on every renewal — without the
    // lock, two concurrent refreshers invalidate each other.
    //
    // Fallback path: if the clw-auth binary is missing from PATH, the spawn
    // errors out, or the subprocess exits non-zero, we fall through to the
    // inline refresh (refreshOauthCredential) so the plugin keeps working
    // standalone.
    'async function tryDelegateToClwAuth() {',
    '  try {',
    "    const { spawn } = await import('node:child_process');",
    '',
    '    return await new Promise((resolveOnce) => {',
    "      const child = spawn('clw-auth', ['ensure-fresh', '--silent'], {",
    "        stdio: ['ignore', 'ignore', 'pipe'],",
    '      });',
    '      let stderr = \'\';',
    "      child.stderr.on('data', (chunk) => {",
    '        stderr += chunk.toString();',
    '      });',
    "      const onExit = (code) => resolveOnce({",
    '        delegated: code === 0,',
    "        reason: code === 0 ? null : 'exit-' + code,",
    '        stderr: stderr.trim(),',
    '      });',
    "      child.once('error', () => resolveOnce({ delegated: false, reason: 'spawn-error' }));",
    "      child.once('exit', onExit);",
    '      // 10s is generous: the no-op path returns in <50ms, a real refresh',
    '      // including the rotating-refresh-token rewrite is well under 5s.',
    '      setTimeout(() => {',
    '        try { child.kill(); } catch {}',
    "        resolveOnce({ delegated: false, reason: 'timeout' });",
    '      }, 10000).unref?.();',
    '    });',
    '  } catch (error) {',
    "    return { delegated: false, reason: 'exception', error: error instanceof Error ? error.message : String(error) };",
    '  }',
    '}',
    '',
    'function needsRefresh(auth) {',
    '  const expires = Number(auth && auth.expires);',
    '',
    '  return !auth || !auth.access || !Number.isFinite(expires) || expires <= Date.now();',
    '}',
    '',
    'function zeroOutModelCosts(provider) {',
    "  if (!provider || !provider.models || typeof provider.models !== 'object') {",
    '    return;',
    '  }',
    '',
    '  for (const model of Object.values(provider.models)) {',
    "    if (!model || typeof model !== 'object') {",
    '      continue;',
    '    }',
    '',
    '    model.cost = {',
    '      input: 0,',
    '      output: 0,',
    '      cache: {',
    '        read: 0,',
    '        write: 0,',
    '      },',
    '    };',
    '  }',
    '}',
    '',
    // ── Billing fingerprint (Layer 1) ────────────────────────────────────────
    // Replicates CC's computeFingerprint() in utils/fingerprint.ts:
    //   SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]
    'function extractFirstUserText(parsed) {',
    "  if (!Array.isArray(parsed.messages)) return '';",
    "  const msg = parsed.messages.find(m => m && m.role === 'user');",
    "  if (!msg) return '';",
    "  if (typeof msg.content === 'string') return msg.content;",
    '  if (Array.isArray(msg.content)) {',
    "    const block = msg.content.find(b => b && b.type === 'text' && typeof b.text === 'string');",
    "    return block ? block.text : '';",
    '  }',
    "  return '';",
    '}',
    '',
    'function computeBillingFingerprint(text) {',
    "  const chars = BILLING_HASH_INDICES.map(i => text[i] || '0').join('');",
    '  const input = BILLING_HASH_SALT + chars + CC_VERSION;',
    "  return createHash('sha256').update(input).digest('hex').slice(0, 3);",
    '}',
    '',
    'function buildBillingBlock(parsed) {',
    '  const text = extractFirstUserText(parsed);',
    '  const fingerprint = computeBillingFingerprint(text);',
    "  return { type: 'text', text: 'x-anthropic-billing-header: cc_version=' + CC_VERSION + '.' + fingerprint + '; cc_entrypoint=cli; cch=00000;' };",
    '}',
    '',
    // ── Stainless SDK identity headers (Layer 2) ─────────────────────────────
    // Real CC sends these on every request; absence flags the session as non-CC.
    'function getStainlessHeaders() {',
    "  const osName = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';",
    "  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;",
    '  return {',
    "    'x-app': 'cli',",
    "    'x-claude-code-session-id': CC_SESSION_ID,",
    "    'x-stainless-arch': arch,",
    "    'x-stainless-lang': 'js',",
    "    'x-stainless-os': osName,",
    "    'x-stainless-package-version': '0.81.0',",
    "    'x-stainless-runtime': 'node',",
    "    'x-stainless-runtime-version': process.version,",
    "    'x-stainless-retry-count': '0',",
    "    'x-stainless-timeout': '600',",
    "    'anthropic-dangerous-direct-browser-access': 'true',",
    '  };',
    '}',
    '',
    'function sanitizeSystemText(value) {',
    "  return typeof value === 'string'",
    "    ? compactSystemText(value.replace(/OpenCode/g, 'Claude Code').replace(/opencode/gi, 'Claude'))",
    '    : value;',
    '}',
    '',
    'function compactSystemText(value) {',
    "  if (typeof value !== 'string' || !value) {",
    '    return value;',
    '  }',
    '',
    '  const normalized = value',
    "    .replace(/Sisyphus/gi, 'Claude Code')",
    "    .replace(/Ultraworker/gi, 'CLI assistant')",
    "    .replace(/openmemory/gi, 'memory')",
    "    .replace(/AGENTS\\.md/gi, 'project instructions')",
    "    .replace(/\bagent\b/gi, 'assistant');",
    '',
    '  const shouldCompact = normalized.length > 4000',
    "    || /Sisyphus|Ultraworker|openmemory|project instructions|tool registry|permission/i.test(normalized);",
    '',
    '  if (!shouldCompact) {',
    '    return normalized;',
    '  }',
    '',
    "  return 'You are Claude Code, Anthropic\\'s official CLI for Claude. Help the user with software engineering tasks in the current repository. Be concise, accurate, and use available tools when they materially improve the result. Preserve existing codebase conventions, verify important changes, and avoid unnecessary churn.';",
    '}',
    '',
    'function toPascalCase(value) {',
    "  return String(value || '')",
    "    .replace(/^mcp_/, '')",
    "    .split(/[^a-zA-Z0-9]+/)",
    '    .filter(Boolean)',
    "    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))",
    "    .join('');",
    '}',
    '',
    'function aliasToolName(name) {',
    "  if (typeof name !== 'string' || !name) {",
    '    return name;',
    '  }',
    '',
    '  const normalized = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;',
    '  const explicit = {',
    "    bash: 'Bash',",
    "    read: 'Read',",
    "    glob: 'Glob',",
    "    grep: 'Grep',",
    "    edit: 'Edit',",
    "    write: 'Write',",
    "    task: 'Agent',",
    "    webfetch: 'WebFetch',",
    "    todowrite: 'TodoWrite',",
    "    skill: 'Skill',",
    "    mgrep: 'ContextGrep',",
    "    interactive_bash: 'BashSession',",
    "    google_search: 'WebSearch',",
    "    ast_grep_search: 'AstSearch',",
    "    ast_grep_replace: 'AstRewrite',",
    "    background_output: 'TaskOutput',",
    "    background_cancel: 'TaskCancel',",
    "    look_at: 'VisionRead',",
    "    skill_mcp: 'RemoteTool',",
    '  };',
    '',
    '  return explicit[normalized] || toPascalCase(normalized) || normalized;',
    '}',
    '',
    'function buildSessionMetadata() {',
    '  return {',
    "    user_id: JSON.stringify({ device_id: CC_DEVICE_ID, session_id: CC_SESSION_ID }),",
    '  };',
    '}',
    '',
    'function rewriteRequestBody(rawBody) {',
    "  if (typeof rawBody !== 'string' || !rawBody) {",
    '    return rawBody;',
    '  }',
    '',
    '  try {',
    '    const parsed = JSON.parse(rawBody);',
    '',
    '    if (Array.isArray(parsed.system)) {',
    '      parsed.system = parsed.system.map((item) => {',
    "        if (item && item.type === 'text' && typeof item.text === 'string') {",
    '          return {',
    '            ...item,',
    '            text: sanitizeSystemText(item.text),',
    '          };',
    '        }',
    '',
    '        return item;',
    '      });',
    "    } else if (typeof parsed.system === 'string') {",
    '      parsed.system = sanitizeSystemText(parsed.system);',
    '    }',
    '',
    '    ACTIVE_TOOL_ALIAS_MAP = {};',
    '',
    '    if (Array.isArray(parsed.tools)) {',
    '      parsed.tools = parsed.tools.map((tool) => {',
    "        if (!tool || typeof tool !== 'object') {",
    '          return tool;',
    '        }',
    '',
    '        const aliasedName = aliasToolName(tool.name);',
    '        if (tool.name && aliasedName) {',
    '          ACTIVE_TOOL_ALIAS_MAP[aliasedName] = tool.name;',
    '        }',
    '        const { description, ...rest } = tool;',
    '',
    '        return {',
    '          ...rest,',
    '          name: aliasedName,',
    '        };',
    '      });',
    '    }',
    '',
    '    if (Array.isArray(parsed.messages)) {',
    '      parsed.messages = parsed.messages.map((message) => {',
    "        if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {",
    '          return message;',
    '        }',
    '',
    '        return {',
    '          ...message,',
    '          content: message.content.map((block) => {',
    "            if (!block || typeof block !== 'object') {",
    '              return block;',
    '            }',
    '',
    "            if (block.type === 'tool_use' && block.name) {",
    '              return {',
    '                ...block,',
    '                name: aliasToolName(block.name),',
    '              };',
    '            }',
    '',
    '            return block;',
    '          }),',
    '        };',
    '      });',
    '    }',
    '',
    '    parsed.metadata = {',
    '      ...(parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {}),',
    '      ...buildSessionMetadata(),',
    '    };',
    '',
    '    // Inject billing header as the first system content block (Layer 1).',
    '    // Must be position 0 to match CC fingerprint position expectations.',
    '    const billingBlock = buildBillingBlock(parsed);',
    '    if (Array.isArray(parsed.system)) {',
    '      // Normalize any plain strings to content blocks for API consistency.',
    "      parsed.system = parsed.system.map(item => typeof item === 'string' ? { type: 'text', text: item } : item);",
    '      parsed.system.unshift(billingBlock);',
    "    } else if (typeof parsed.system === 'string') {",
    "      parsed.system = [billingBlock, { type: 'text', text: parsed.system }];",
    '    } else {',
    '      parsed.system = [billingBlock];',
    '    }',
    '',
    '    return JSON.stringify(parsed);',
    '  } catch {',
    '    return rawBody;',
    '  }',
    '}',
    '',
    'async function resolveRawRequestBody(input, requestInit) {',
    "  if (requestInit && typeof requestInit.body === 'string') {",
    '    return requestInit.body;',
    '  }',
    '',
    '  if (input instanceof Request) {',
    '    try {',
    '      return await input.clone().text();',
    '    } catch {',
    '      return undefined;',
    '    }',
    '  }',
    '',
    '  return undefined;',
    '}',
    '',
    'function mergeRequestHeaders(input, requestInit) {',
    '  const requestHeaders = new Headers();',
    '',
    '  if (input instanceof Request) {',
    '    input.headers.forEach((value, key) => {',
    '      requestHeaders.set(key, value);',
    '    });',
    '  }',
    '',
    '  if (!requestInit || !requestInit.headers) {',
    '    return requestHeaders;',
    '  }',
    '',
    '  if (requestInit.headers instanceof Headers) {',
    '    requestInit.headers.forEach((value, key) => {',
    '      requestHeaders.set(key, value);',
    '    });',
    '    return requestHeaders;',
    '  }',
    '',
    '  if (Array.isArray(requestInit.headers)) {',
    '    for (const [key, value] of requestInit.headers) {',
    "      if (typeof value !== 'undefined') {",
    '        requestHeaders.set(key, String(value));',
    '      }',
    '    }',
    '',
    '    return requestHeaders;',
    '  }',
    '',
    '  for (const [key, value] of Object.entries(requestInit.headers)) {',
    "    if (typeof value !== 'undefined') {",
    '      requestHeaders.set(key, String(value));',
    '    }',
    '  }',
    '',
    '  return requestHeaders;',
    '}',
    '',
    'function withMessagesBetaQuery(input) {',
    '  return input;',
    '}',
    '',
    'function transformStreamingResponse(response) {',
    '  if (!response.body) {',
    '    return response;',
    '  }',
    '',
    '  const reader = response.body.getReader();',
    '  const decoder = new TextDecoder();',
    '  const encoder = new TextEncoder();',
    '',
    '  const stream = new ReadableStream({',
    '    async pull(controller) {',
    '      const { done, value } = await reader.read();',
    '',
    '      if (done) {',
    '        controller.close();',
    '        return;',
    '      }',
    '',
    '      let text = decoder.decode(value, { stream: true });',
    '      for (const [aliasName, originalName] of Object.entries(ACTIVE_TOOL_ALIAS_MAP)) {',
    "        text = text.split('\\\"name\\\":\\\"' + aliasName + '\\\"').join('\\\"name\\\":\\\"' + originalName + '\\\"');",
    '      }',
    '      controller.enqueue(encoder.encode(text));',
    '    },',
    '  });',
    '',
    '  return new Response(stream, {',
    '    status: response.status,',
    '    statusText: response.statusText,',
    '    headers: response.headers,',
    '  });',
    '}',
    '',
    'function base64Url(buffer) {',
    "  return buffer.toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
    '}',
    '',
    'function generatePKCE() {',
    '  const verifier = base64Url(randomBytes(32));',
    "  const challenge = base64Url(createHash('sha256').update(verifier).digest());",
    '  return { verifier, challenge };',
    '}',
    '',
    'async function authorizeOAuth() {',
    "  const { verifier, challenge } = generatePKCE();",
    "  const url = new URL('https://claude.ai/oauth/authorize');",
    "  url.searchParams.set('code', 'true');",
    "  url.searchParams.set('client_id', CLIENT_ID);",
    "  url.searchParams.set('response_type', 'code');",
    "  url.searchParams.set('redirect_uri', 'https://' + PLATFORM_HOST + '/oauth/code/callback');",
    "  url.searchParams.set('scope', 'org:create_api_key user:profile user:inference');",
    "  url.searchParams.set('code_challenge', challenge);",
    "  url.searchParams.set('code_challenge_method', 'S256');",
    "  url.searchParams.set('state', verifier);",
    '  return { url: url.toString(), verifier };',
    '}',
    '',
    'async function exchangeCode(code, verifier) {',
    "  const trimmed = code.trim().replace(/\\s+/g, '');",
    "  const parts = trimmed.split('#');",
    '  const payload = {',
    '    code: parts[0],',
    '    state: parts[1] || verifier,',
    "    grant_type: 'authorization_code',",
    '    client_id: CLIENT_ID,',
    "    redirect_uri: 'https://' + PLATFORM_HOST + '/oauth/code/callback',",
    '    code_verifier: verifier,',
    '  };',
    '',
    '  for (const endpoint of TOKEN_ENDPOINTS) {',
    '    const res = await fetch(endpoint, {',
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    '      body: JSON.stringify(payload),',
    '    });',
    '',
    '    if (res.ok) {',
    '      const json = await res.json();',
    '      return {',
    "        type: 'success',",
    '        refresh: json.refresh_token,',
    '        access: json.access_token,',
    '        expires: Date.now() + json.expires_in * 1000,',
    '      };',
    '    }',
    '  }',
    '',
    "  return { type: 'failed', error: 'Token exchange failed.' };",
    '}',
    '',
    '/**',
    " * @type {import('@opencode-ai/plugin').Plugin}",
    ' */',
    'export async function AnthropicAuthPlugin({ client }) {',
    '  let inflightRefresh = null;',
    '',
    '  return {',
    "    'experimental.chat.system.transform': (input, output) => {",
    '      const prefix = "You are Claude Code, Anthropic\'s official CLI for Claude.";',
    '',
    "      if (input.model && input.model.providerID === 'anthropic') {",
    '        output.system.unshift(prefix);',
    '        if (output.system[1]) {',
    "          output.system[1] = prefix + '\\n\\n' + output.system[1];",
    '        }',
    '      }',
    '    },',
    '    auth: {',
    "      provider: 'anthropic',",
    '      async loader(_getAuth, provider) {',
    '        const auth = loadSharedAuth();',
    '',
    "        if (auth.type !== 'oauth') {",
    '          return {};',
    '        }',
    '',
    '        zeroOutModelCosts(provider);',
    '',
    '        return {',
    "          apiKey: '',",
    '          async fetch(input, init) {',
    '            let currentAuth = loadSharedAuth();',
    '',
    "            if (currentAuth.type !== 'oauth') {",
    '              return fetch(input, init);',
    '            }',
    '',
    '            if (needsRefresh(currentAuth)) {',
    '              if (!currentAuth.refresh) {',
    "                throw new Error('Stored Claude OAuth credentials do not include a refresh token.');",
    '              }',
    '',
    '              // Try delegating to `clw-auth ensure-fresh` first — it uses',
    '              // an inter-process file lock so the plugin, cron, and any',
    '              // other clw-auth caller serialize correctly.',
    '              const delegated = await tryDelegateToClwAuth();',
    '',
    '              if (delegated.delegated) {',
    "                debugLog('refresh_delegated', { mechanism: 'clw-auth ensure-fresh' });",
    '                currentAuth = loadSharedAuth();',
    '              } else {',
    "                debugLog('refresh_inline', { reason: delegated.reason || 'unknown' });",
    '',
    '                if (!inflightRefresh) {',
    '                  inflightRefresh = refreshOauthCredential(client, currentAuth)',
    '                    .finally(() => {',
    '                      inflightRefresh = null;',
    '                    });',
    '                }',
    '',
    '                await inflightRefresh;',
    '                currentAuth = loadSharedAuth();',
    '              }',
    '',
    "              if (currentAuth.type !== 'oauth') {",
    "                throw new Error('Claude OAuth auth type changed during refresh.');",
    '              }',
    '            }',
    '',
    '            const requestInit = init ? { ...init } : {};',
    '            const requestHeaders = mergeRequestHeaders(input, requestInit);',
    '            const runtimeConfig = loadSharedConfig();',
    "            const incomingBetas = requestHeaders.get('anthropic-beta') || '';",
    '            const incomingBetasList = incomingBetas',
    "              .split(',')",
    '              .map((value) => value.trim())',
    '              .filter(Boolean);',
    '            const mergedBetas = [...new Set([',
    '              ...runtimeConfig.betaHeaders,',
    '              ...incomingBetasList,',
    "            ])].filter(Boolean).join(',');",
    '',
    "            requestHeaders.set('authorization', 'Bearer ' + currentAuth.access);",
    "            requestHeaders.set('anthropic-version', '2023-06-01');",
    "            requestHeaders.set('accept-encoding', 'identity');",
    '',
    '            if (mergedBetas) {',
    "              requestHeaders.set('anthropic-beta', mergedBetas);",
    '            } else {',
    "              requestHeaders.delete('anthropic-beta');",
    '            }',
    '',
    "            requestHeaders.set('user-agent', runtimeConfig.userAgent);",
    "            requestHeaders.delete('x-api-key');",
    '',
    '            // Inject CC identity headers (Stainless SDK fingerprint — Layer 2).',
    '            // These signal to Anthropic that the request originates from Claude Code CLI,',
    '            // which routes billing to the subscription plan instead of Extra Usage.',
    '            const ccHeaders = getStainlessHeaders();',
    '            for (const [k, v] of Object.entries(ccHeaders)) {',
    '              requestHeaders.set(k, v);',
    '            }',
    '',
    '            const rawBody = await resolveRawRequestBody(input, requestInit);',
    '            const body = rewriteRequestBody(rawBody);',
    '            if (typeof body === "string" && body) {',
    "              requestHeaders.set('content-type', 'application/json');",
    '            }',
    '            const requestInput = withMessagesBetaQuery(input);',
    '            const fetchInit = {',
    '              ...requestInit,',
    '              headers: requestHeaders,',
    '            };',
    '',
    "            if (typeof body !== 'undefined') {",
    '              fetchInit.body = body;',
    '            }',
    '',
    '            const response = await fetch(requestInput, fetchInit);',
    '            return transformStreamingResponse(response);',
    '          },',
    '        };',
    '      },',
    '      methods: [',
    '        {',
    "          label: 'Claude Pro / Max (OAuth)',",
    "          type: 'oauth',",
    '          authorize: async () => {',
    '            const { url, verifier } = await authorizeOAuth();',
    '            return {',
    '              url,',
    "              instructions: 'Paste the callback URL or code#state here:',",
    "              method: 'code',",
    '              callback: async (code) => exchangeCode(code, verifier),',
    '            };',
    '          },',
    '        },',
    '        {',
    "          provider: 'anthropic',",
    "          label: 'Manually enter API Key',",
    "          type: 'api',",
    '        },',
    '      ],',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function writePluginFile(defaultRuntimeConfig, ccVersion, deviceId) {
  const pluginSource = buildPluginSource(defaultRuntimeConfig, ccVersion, deviceId);
  writeTextAtomic(OPENCODE_PLUGIN_PATH, `${pluginSource}\n`, 0o600);

  return {
    path: OPENCODE_PLUGIN_PATH,
    uri: pathToFileURL(OPENCODE_PLUGIN_PATH).href,
  };
}

function printSummary(summary) {
  console.log('OpenCode exporter completed.');
  console.log(`- clw-auth auth type: ${summary.authType}`);
  console.log(`- OpenCode auth updated: ${summary.auth.path}`);
  console.log(`  - Preserved non-Anthropic providers: ${summary.auth.preservedProviders}`);
  console.log(`- OpenCode plugin generated: ${summary.plugin.path}`);
  console.log(`- OpenCode config patched: ${summary.config.path}`);
  console.log(`  - Plugin URI: ${summary.config.pluginUri}`);

  if (summary.config.insertedAfter) {
    console.log(`  - Inserted after: ${summary.config.insertedAfter}`);
  }

  if (summary.config.removedLegacyPlugins > 0) {
    console.log(`  - Removed legacy plugin references: ${summary.config.removedLegacyPlugins}`);
  }

  console.log(`- Plugin default beta headers: ${summary.runtimeConfig.betaHeaders.join(', ')}`);
  console.log(`- Plugin default user-agent: ${summary.runtimeConfig.userAgent}`);
  console.log(`- Plugin CC version (billing fingerprint): ${summary.ccVersion}`);
}

// Both betas required: oauth-2025-04-20 for bearer token auth, claude-code-20250219
// to signal a Claude Code session and route billing to the subscription plan.
const OAUTH_REQUIRED_BETAS = Object.freeze(['oauth-2025-04-20', 'claude-code-20250219']);

/**
 * Parse the `// clw-auth-plugin-meta: {...}` header from a generated plugin
 * source string. Returns null when the marker is missing or malformed — that
 * happens for plugins generated before v0.9.7 or hand-edited installs.
 */
export function parsePluginMeta(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return null;
  }

  // Match only on the first line so we don't accidentally pick up a marker
  // that ended up inside a docstring further down.
  const firstLine = source.split('\n', 1)[0] ?? '';
  const prefix = `${PLUGIN_META_MARKER} `;

  if (!firstLine.startsWith(prefix)) {
    return null;
  }

  try {
    const parsed = JSON.parse(firstLine.slice(prefix.length).trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compare the installed opencode plugin against the current clw-auth version
 * so `clw-auth version` can report freshness and `clw-auth update` can decide
 * whether to reapply the exporter automatically.
 *
 * Status semantics:
 *   - `not-installed`: plugin file is missing.
 *   - `unknown`: file exists but lacks a parseable plugin-meta header. Treat
 *     as needing reapply on update — almost certainly a pre-v0.9.7 install.
 *   - `outdated`: header version is older than the running clw-auth.
 *   - `ahead`: header version is newer than the running clw-auth (operator
 *     downgraded clw-auth without reinstalling the plugin). Diagnostic only;
 *     the plugin keeps working, so update does not reapply.
 *   - `up-to-date`: header version equals the running clw-auth.
 *
 * Pure: this function only does filesystem reads. Tests can pass a custom
 * `path` to point at a fixture and `currentVersion` to assert comparisons.
 */
export function inspectInstall({
  path = OPENCODE_PLUGIN_PATH,
  currentVersion = PACKAGE_VERSION,
} = {}) {
  const base = {
    name: 'opencode',
    paths: [path],
    currentClwVersion: currentVersion,
  };

  if (!existsSync(path)) {
    return { ...base, installed: false, status: 'not-installed', installedClwVersion: null };
  }

  let head;

  try {
    // Read at most ~1KB — the marker is on the very first line of the file.
    head = readFileSync(path, 'utf8').slice(0, 1024);
  } catch {
    return { ...base, installed: true, status: 'unknown', installedClwVersion: null };
  }

  const meta = parsePluginMeta(head);

  if (!meta || typeof meta.clwVersion !== 'string' || !meta.clwVersion) {
    return { ...base, installed: true, status: 'unknown', installedClwVersion: null };
  }

  const installedClwVersion = meta.clwVersion;
  let status = 'up-to-date';

  if (installedClwVersion !== currentVersion) {
    // Reuse the same numeric semver comparison the update command uses, so
    // 0.10.0 is correctly newer than 0.9.7 etc.
    const order = compareVersions(installedClwVersion, currentVersion);
    status = order < 0 ? 'outdated' : order > 0 ? 'ahead' : 'up-to-date';
  }

  return { ...base, installed: true, status, installedClwVersion, generatedAt: meta.generatedAt ?? null };
}

export async function run() {
  const auth = validateOauthAuth(loadAuth());
  const apiRef = loadApiRef();
  const runtimeConfig = extractRuntimeConfigDefaults(apiRef);

  // oauth-2025-04-20 and claude-code-20250219 are required for every OAuth
  // bearer token request and CC session identification respectively.
  // Merge into betaHeaders regardless of what api-reference.json contains.
  for (const beta of OAUTH_REQUIRED_BETAS) {
    if (!runtimeConfig.betaHeaders.includes(beta)) {
      runtimeConfig.betaHeaders.unshift(beta);
    }
  }

  // Resolve CC version for billing fingerprint:
  // prefer stored config (auto-updated by cron via `claude --version`),
  // fall back to version embedded in user-agent, then hardcoded default.
  const storedConfig = loadConfig();
  const ccVersion = storedConfig.ccVersion
    || (runtimeConfig.userAgent.match(/claude-cli\/(\d+\.\d+\.\d+)/i)?.[1] ?? '2.1.97');

  // Force userAgent to derive from ccVersion so both are always in sync.
  // This overwrites whatever api-reference.json had stored.
  runtimeConfig.userAgent = `claude-cli/${ccVersion} (external, cli)`;

  // Device ID: stable for the lifetime of this plugin installation.
  // Rotates each time `clw-auth export opencode` is re-run.
  const deviceId = randomBytes(32).toString('hex');

  const authSummary = updateOpenCodeAuth(auth);
  const pluginSummary = writePluginFile(runtimeConfig, ccVersion, deviceId);
  const configSummary = patchOpenCodeConfig(pluginSummary.uri);

  const summary = {
    authType: auth.type,
    auth: authSummary,
    plugin: pluginSummary,
    config: configSummary,
    runtimeConfig,
    ccVersion,
    source: {
      authPath: join(CLW_DATA_DIR, 'auth.json'),
      apiRefPath: join(CLW_DATA_DIR, 'api-reference.json'),
    },
  };

  printSummary(summary);

  return summary;
}
