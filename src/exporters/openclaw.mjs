import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { loadConfig } from '../config.mjs';
import {
  loadAuth,
  writeJsonAtomic,
} from '../store.mjs';

const AUTH_PROFILES_SCHEMA_VERSION = 1;
const OPENCLAW_DIR         = join(homedir(), '.openclaw');
const OPENCLAW_AGENTS_DIR  = join(OPENCLAW_DIR, 'agents');
const OPENCLAW_CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');

// Models added to ~/.openclaw/openclaw.json → agents.defaults.model.fallbacks.
// This is what makes 'openclaw models list' recognise and display Claude models.
const CLAUDE_FALLBACK_MODELS = Object.freeze([
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5',
]);

const OPENCLAW_STAINLESS_PACKAGE_VERSION = '0.81.0';

export const DESCRIPTION = 'Sync clw-auth credentials into OpenClaw auth profiles.';

const OPENCLAW_PROFILE_NAME = 'anthropic:default';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapRuntimeOs() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

function mapRuntimeArch() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  return process.arch;
}

function loadJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};

  try {
    const raw = readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getAuthProfilesPath(agentId) {
  return join(OPENCLAW_AGENTS_DIR, agentId, 'agent', 'auth-profiles.json');
}

function listAgents() {
  if (!existsSync(OPENCLAW_AGENTS_DIR)) return [];

  return readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function agentHasAnthropicProfile(agentId) {
  const store = loadJsonSafe(getAuthProfilesPath(agentId));
  return isPlainObject(store.profiles) && OPENCLAW_PROFILE_NAME in store.profiles;
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  return new Promise((resolve) => {
    rl.on('SIGINT', () => {
      rl.close();
      console.log('\nCancelled.');
      process.exit(0);
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function selectAgents(agents) {
  if (agents.length === 0) {
    throw new Error(
      `No OpenClaw agents found at ${OPENCLAW_AGENTS_DIR}.\n` +
      'Create an agent in OpenClaw first, then re-run this command.',
    );
  }

  if (agents.length === 1) {
    console.log(`Found 1 OpenClaw agent: ${agents[0]}`);
    return agents;
  }

  console.log(`Found ${agents.length} OpenClaw agents:\n`);

  for (const [i, agentId] of agents.entries()) {
    const already = agentHasAnthropicProfile(agentId) ? ' (Anthropic already configured)' : '';
    console.log(`  ${i + 1}.  ${agentId}${already}`);
  }

  console.log(`  ${agents.length + 1}.  All agents`);
  console.log('');

  while (true) {
    const raw = await prompt(`Select agent [1-${agents.length + 1}]: `);
    const n   = Number.parseInt(raw, 10);

    if (n === agents.length + 1) return agents;
    if (Number.isFinite(n) && n >= 1 && n <= agents.length) return [agents[n - 1]];

    console.log(`  Invalid selection — enter a number between 1 and ${agents.length + 1}.`);
  }
}

export function validateConfiguredAuth(auth) {
  if (!isPlainObject(auth)) {
    throw new Error('clw-auth auth.json is not configured.');
  }

  if (auth.type !== 'oauth' && auth.type !== 'api') {
    throw new Error('clw-auth auth.json must contain either OAuth or API credentials.');
  }

  return auth;
}

export function buildOauthProfile(auth) {
  const expires = Number(auth.expires);

  if (typeof auth.access !== 'string' || !auth.access) {
    throw new Error('clw-auth auth.json is missing the OAuth access token.');
  }

  if (typeof auth.refresh !== 'string' || !auth.refresh) {
    throw new Error('clw-auth auth.json is missing the OAuth refresh token.');
  }

  if (!Number.isFinite(expires) || expires <= 0) {
    throw new Error('clw-auth auth.json is missing a valid OAuth expiry timestamp.');
  }

  return {
    type: 'oauth',
    provider: 'anthropic',
    access: auth.access,
    refresh: auth.refresh,
    expires,
  };
}

export function buildApiProfile(auth) {
  if (typeof auth.key !== 'string' || !auth.key) {
    throw new Error('clw-auth auth.json is missing the Anthropic API key. Run: clw-auth api <key>');
  }

  return {
    type: 'api_key',
    provider: 'anthropic',
    key: auth.key,
  };
}

export function buildAnthropicRequestHeaders(runtimeConfig, sessionId = randomUUID()) {
  return {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': runtimeConfig.betaHeaders.join(','),
    'user-agent': runtimeConfig.userAgent,
    'x-app': 'cli',
    'x-claude-code-session-id': sessionId,
    'x-stainless-arch': mapRuntimeArch(),
    'x-stainless-lang': 'js',
    'x-stainless-os': mapRuntimeOs(),
    'x-stainless-package-version': OPENCLAW_STAINLESS_PACKAGE_VERSION,
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'anthropic-dangerous-direct-browser-access': 'true',
    'accept-encoding': 'identity',
  };
}

export function applyAnthropicProviderOverrides(openClawConfig, runtimeConfig, sessionId = randomUUID()) {
  const cfg = isPlainObject(openClawConfig) ? { ...openClawConfig } : {};

  if (!isPlainObject(cfg.models)) cfg.models = {};
  if (!isPlainObject(cfg.models.providers)) cfg.models.providers = {};

  const currentAnthropic = isPlainObject(cfg.models.providers.anthropic)
    ? cfg.models.providers.anthropic
    : {};

  const currentRequest = isPlainObject(currentAnthropic.request)
    ? currentAnthropic.request
    : {};

  const nextHeaders = {
    ...(isPlainObject(currentAnthropic.headers) ? currentAnthropic.headers : {}),
    'anthropic-version': '2023-06-01',
    'anthropic-beta': runtimeConfig.betaHeaders.join(','),
    'user-agent': runtimeConfig.userAgent,
  };

  const nextRequestHeaders = {
    ...(isPlainObject(currentRequest.headers) ? currentRequest.headers : {}),
    ...buildAnthropicRequestHeaders(runtimeConfig, sessionId),
  };

  cfg.models.providers = {
    ...cfg.models.providers,
    anthropic: {
      ...currentAnthropic,
      headers: nextHeaders,
      request: {
        ...currentRequest,
        headers: nextRequestHeaders,
      },
    },
  };

  return cfg;
}

function buildProfile(auth) {
  return auth.type === 'oauth' ? buildOauthProfile(auth) : buildApiProfile(auth);
}

function exportToAgent(agentId, profile) {
  const authProfilesPath = getAuthProfilesPath(agentId);
  const currentStore = loadJsonSafe(authProfilesPath);

  if (!isPlainObject(currentStore)) {
    throw new Error(`OpenClaw auth profiles file must contain a JSON object: ${authProfilesPath}`);
  }

  const currentProfiles = isPlainObject(currentStore.profiles) ? currentStore.profiles : {};

  const nextStore = {
    version: typeof currentStore.version === 'number' ? currentStore.version : AUTH_PROFILES_SCHEMA_VERSION,
    ...currentStore,
    profiles: {
      ...currentProfiles,
      [OPENCLAW_PROFILE_NAME]: profile,
    },
  };

  writeJsonAtomic(authProfilesPath, nextStore, 0o600);

  return authProfilesPath;
}

/**
 * Adds Claude models to agents.defaults.model.fallbacks in ~/.openclaw/openclaw.json
 * so that 'openclaw models list' recognises and displays them.
 * Idempotent — skips models that are already present.
 */
function updateOpenClawConfig() {
  const runtimeConfig = loadConfig();
  let cfg = loadJsonSafe(OPENCLAW_CONFIG_PATH);

  if (!isPlainObject(cfg.agents))                cfg.agents = {};
  if (!isPlainObject(cfg.agents.defaults))        cfg.agents.defaults = {};
  if (!isPlainObject(cfg.agents.defaults.model))  cfg.agents.defaults.model = {};

  const model = cfg.agents.defaults.model;
  if (!Array.isArray(model.fallbacks)) model.fallbacks = [];

  const added = [];
  for (const m of CLAUDE_FALLBACK_MODELS) {
    if (!model.fallbacks.includes(m)) {
      model.fallbacks.push(m);
      added.push(m);
    }
  }

  const sessionId = randomUUID();
  cfg = applyAnthropicProviderOverrides(cfg, runtimeConfig, sessionId);

  writeJsonAtomic(OPENCLAW_CONFIG_PATH, cfg, 0o644);

  return {
    added,
    configPath: OPENCLAW_CONFIG_PATH,
    sessionId,
    runtimeHeaders: buildAnthropicRequestHeaders(runtimeConfig, sessionId),
  };
}

/**
 * Syncs clw-auth credentials into one or more OpenClaw agent profile stores
 * and updates the global OpenClaw config so models appear in 'openclaw models list'.
 *
 * @param {{ agentId?: string, allConfigured?: boolean } | undefined} options
 *   allConfigured: if true, silently exports to every agent that already has
 *   an anthropic:default profile — no prompt, no output. Used by the cron auto-sync.
 */
export async function run(options = {}) {
  const auth    = validateConfiguredAuth(loadAuth());
  const profile = buildProfile(auth);

  let selectedAgents;
  const silent = options.allConfigured === true;

  if (silent) {
    selectedAgents = listAgents().filter(agentHasAnthropicProfile);
    if (selectedAgents.length === 0) return [];
  } else if (typeof options.agentId === 'string' && options.agentId.trim()) {
    selectedAgents = [options.agentId.trim()];
  } else {
    const agents = listAgents();
    selectedAgents = await selectAgents(agents);
  }

  const results = [];

  for (const agentId of selectedAgents) {
    try {
      const path = exportToAgent(agentId, profile);
      if (!silent) {
        console.log(`\n✔  ${agentId}`);
        console.log(`   ${path}`);
      }
      results.push({ agentId, path, ok: true });
    } catch (error) {
      if (!silent) {
        console.error(`\n✖  ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      results.push({ agentId, ok: false });
    }
  }

  if (!silent) {
    const succeeded = results.filter((r) => r.ok).length;
    const failed    = results.length - succeeded;

    console.log(`\nExported to ${succeeded} agent${succeeded !== 1 ? 's' : ''}.${failed > 0 ? ` ${failed} failed.` : ''}`);
    console.log(`Profile: ${OPENCLAW_PROFILE_NAME}  |  Auth type: ${profile.type}`);

    const configUpdate = updateOpenClawConfig();

    if (configUpdate.added.length > 0) {
      console.log(`\n✔  Added to openclaw.json fallbacks: ${configUpdate.added.join(', ')}`);
    } else {
      console.log(`\n✔  openclaw.json fallbacks already up to date.`);
    }

    console.log(`✔  OpenClaw Anthropic runtime headers synced`);
    console.log(`   User-Agent: ${configUpdate.runtimeHeaders['user-agent']}`);
    console.log(`   Beta headers: ${configUpdate.runtimeHeaders['anthropic-beta']}`);
    console.log(`   Session header: ${configUpdate.runtimeHeaders['x-claude-code-session-id']}`);
    console.log(`   Run: openclaw gateway restart`);
  } else {
    updateOpenClawConfig();
  }

  return results;
}
