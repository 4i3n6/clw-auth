import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import {
  loadAuth,
  writeJsonAtomic,
} from '../store.mjs';

const AUTH_PROFILES_SCHEMA_VERSION = 1;
const OPENCLAW_AGENTS_DIR = join(homedir(), '.openclaw', 'agents');

const ANTHROPIC_MODELS_PROVIDER = Object.freeze({
  baseUrl: 'https://api.anthropic.com',
  api: 'anthropic-messages',
  models: [
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
    {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ],
});

export const DESCRIPTION = 'Sync clw-auth credentials into OpenClaw auth profiles.';

const OPENCLAW_PROFILE_NAME = 'anthropic:default';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function getModelsPath(agentId) {
  return join(OPENCLAW_AGENTS_DIR, agentId, 'agent', 'models.json');
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

function buildProfile(auth) {
  return auth.type === 'oauth' ? buildOauthProfile(auth) : buildApiProfile(auth);
}

function exportToAgent(agentId, profile) {
  // 1. Write auth profile
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

  // 2. Update models.json — add/replace anthropic provider so models appear in `openclaw models list`
  const modelsPath = getModelsPath(agentId);
  const currentModels = loadJsonSafe(modelsPath);
  const currentProviders = isPlainObject(currentModels.providers) ? currentModels.providers : {};

  const nextModels = {
    ...currentModels,
    providers: {
      ...currentProviders,
      anthropic: ANTHROPIC_MODELS_PROVIDER,
    },
  };

  writeJsonAtomic(modelsPath, nextModels, 0o644);

  return authProfilesPath;
}

/**
 * Syncs clw-auth credentials into one or more OpenClaw agent profile stores.
 * When no agentId is provided in options, lists available agents and prompts
 * the user to select which to export to.
 *
 * @param {{ agentId?: string } | undefined} options
 */
export async function run(options = {}) {
  const auth    = validateConfiguredAuth(loadAuth());
  const profile = buildProfile(auth);

  let selectedAgents;

  if (typeof options.agentId === 'string' && options.agentId.trim()) {
    selectedAgents = [options.agentId.trim()];
  } else {
    const agents = listAgents();
    selectedAgents = await selectAgents(agents);
  }

  const results = [];

  for (const agentId of selectedAgents) {
    try {
      const path = exportToAgent(agentId, profile);
      console.log(`\n✔  ${agentId}`);
      console.log(`   ${path}`);
      results.push({ agentId, path, ok: true });
    } catch (error) {
      console.error(`\n✖  ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ agentId, ok: false });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed    = results.length - succeeded;

  console.log(`\nExported to ${succeeded} agent${succeeded !== 1 ? 's' : ''}.${failed > 0 ? ` ${failed} failed.` : ''}`);
  console.log(`Profile: ${OPENCLAW_PROFILE_NAME}  |  Auth type: ${profile.type}`);

  return results;
}
