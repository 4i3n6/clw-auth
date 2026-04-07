import { homedir } from 'node:os';
import { join } from 'node:path';

import { existsSync, readFileSync } from 'node:fs';

import {
  loadAuth,
  writeJsonAtomic,
} from '../store.mjs';

const AUTH_PROFILES_SCHEMA_VERSION = 1;

function loadJsonSafe(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export const DESCRIPTION = 'Sync clw-auth credentials into OpenClaw auth profiles.';

const DEFAULT_AGENT_ID = 'default';
const OPENCLAW_PROFILE_NAME = 'anthropic:default';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveAgentId(options = {}) {
  if (!isPlainObject(options)) {
    throw new Error('OpenClaw exporter options must be a JSON object when provided.');
  }

  const agentId = typeof options.agentId === 'undefined' ? DEFAULT_AGENT_ID : options.agentId;

  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new Error('OpenClaw exporter agentId must be a non-empty string.');
  }

  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.includes('/') || normalizedAgentId.includes('\\')) {
    throw new Error('OpenClaw exporter agentId must not contain path separators.');
  }

  if (normalizedAgentId === '.' || normalizedAgentId === '..') {
    throw new Error('OpenClaw exporter agentId must not be a relative path segment.');
  }

  return normalizedAgentId;
}

function getAuthProfilesPath(agentId) {
  return join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');
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
  if (auth.type === 'oauth') {
    return buildOauthProfile(auth);
  }

  return buildApiProfile(auth);
}

/**
 * Syncs clw-auth credentials into the selected OpenClaw agent profile store.
 *
 * @param {{ agentId?: string } | undefined} options
 * @returns {Promise<{ agentId: string, path: string, profileName: string, authType: string }>}
 */
export async function run(options = {}) {
  const agentId = resolveAgentId(options);
  const authProfilesPath = getAuthProfilesPath(agentId);
  const auth = validateConfiguredAuth(loadAuth());
  const profile = buildProfile(auth);
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

  console.log('OpenClaw auth profile synced.');
  console.log(`- path: ${authProfilesPath}`);
  console.log(`- profile: ${OPENCLAW_PROFILE_NAME}`);
  console.log(`- agentId: ${agentId}`);
  console.log(`- auth type: ${profile.type}`);

  return {
    agentId,
    path: authProfilesPath,
    profileName: OPENCLAW_PROFILE_NAME,
    authType: profile.type,
  };
}
