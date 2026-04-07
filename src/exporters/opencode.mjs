import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadAuth, loadApiRef } from '../store.mjs';

const CLW_DATA_DIR = join(homedir(), '.local', 'share', 'clw-auth');
const OPENCODE_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');
const OPENCODE_CONFIG_JSONC_PATH = join(homedir(), '.config', 'opencode', 'opencode.jsonc');
const OPENCODE_PLUGIN_PATH = join(homedir(), '.config', 'opencode', 'plugins', 'clw-auth-anthropic.mjs');
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';
const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  schemaVersion: 1,
  betaHeaders: ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'],
  userAgent: 'claude-cli/2.1.92 (external, cli)',
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

function buildPluginSource(defaultRuntimeConfig) {
  const serializedDefaultConfig = JSON.stringify(defaultRuntimeConfig, null, 2);

  return [
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
    "import { randomBytes, createHash } from 'node:crypto';",
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
    'function sanitizeSystemText(value) {',
    "  return typeof value === 'string'",
    "    ? value.replace(/OpenCode/g, 'Claude Code').replace(/opencode/gi, 'Claude')",
    '    : value;',
    '}',
    '',
    'function prefixToolName(name) {',
    "  if (typeof name !== 'string' || !name) {",
    '    return name;',
    '  }',
    '',
    '  return name.startsWith(TOOL_PREFIX) ? name : TOOL_PREFIX + name;',
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
    '    if (Array.isArray(parsed.tools)) {',
    '      parsed.tools = parsed.tools.map((tool) => {',
    "        if (!tool || typeof tool !== 'object') {",
    '          return tool;',
    '        }',
    '',
    '        return {',
    '          ...tool,',
    '          name: prefixToolName(tool.name),',
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
    '                name: prefixToolName(block.name),',
    '              };',
    '            }',
    '',
    '            return block;',
    '          }),',
    '        };',
    '      });',
    '    }',
    '',
    '    return JSON.stringify(parsed);',
    '  } catch {',
    '    return rawBody;',
    '  }',
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
    '  let requestUrl = null;',
    '',
    '  try {',
    "    if (typeof input === 'string' || input instanceof URL) {",
    '      requestUrl = new URL(input.toString());',
    '    } else if (input instanceof Request) {',
    '      requestUrl = new URL(input.url);',
    '    }',
    '  } catch {',
    '    requestUrl = null;',
    '  }',
    '',
    '  if (!requestUrl || requestUrl.pathname !== \"/v1/messages\" || requestUrl.searchParams.has(\"beta\")) {',
    '    return input;',
    '  }',
    '',
    "  requestUrl.searchParams.set('beta', 'true');",
    '',
    '  return input instanceof Request',
    '    ? new Request(requestUrl.toString(), input)',
    '    : requestUrl;',
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
    "      text = text.replace(/\\\"name\\\"\\s*:\\s*\\\"mcp_([^\\\"]+)\\\"/g, '\"name\": \"$1\"');",
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
    '              if (!inflightRefresh) {',
    '                inflightRefresh = refreshOauthCredential(client, currentAuth)',
    '                  .finally(() => {',
    '                    inflightRefresh = null;',
    '                  });',
    '              }',
    '',
    '              await inflightRefresh;',
    '              currentAuth = loadSharedAuth();',
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
    '            const body = rewriteRequestBody(requestInit.body);',
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

function writePluginFile(defaultRuntimeConfig) {
  const pluginSource = buildPluginSource(defaultRuntimeConfig);
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
}

const OAUTH_REQUIRED_BETAS = Object.freeze(['oauth-2025-04-20']);

export async function run() {
  const auth = validateOauthAuth(loadAuth());
  const apiRef = loadApiRef();
  const runtimeConfig = extractRuntimeConfigDefaults(apiRef);

  // oauth-2025-04-20 is required for every OAuth bearer token request.
  // Anthropic returns 401 without it regardless of token validity.
  // Merge into betaHeaders regardless of what api-reference.json contains.
  for (const beta of OAUTH_REQUIRED_BETAS) {
    if (!runtimeConfig.betaHeaders.includes(beta)) {
      runtimeConfig.betaHeaders.unshift(beta);
    }
  }
  const authSummary = updateOpenCodeAuth(auth);
  const pluginSummary = writePluginFile(runtimeConfig);
  const configSummary = patchOpenCodeConfig(pluginSummary.uri);

  const summary = {
    authType: auth.type,
    auth: authSummary,
    plugin: pluginSummary,
    config: configSummary,
    runtimeConfig,
    source: {
      authPath: join(CLW_DATA_DIR, 'auth.json'),
      apiRefPath: join(CLW_DATA_DIR, 'api-reference.json'),
    },
  };

  printSummary(summary);

  return summary;
}
