import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  getAuthPath,
  loadAuth,
  loadJson,
  writeJsonAtomic,
} from '../store.mjs';

export const DESCRIPTION = 'Sync claude-oauth credentials into OpenClaw auth profiles.';

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

function validateConfiguredAuth(auth) {
  if (!isPlainObject(auth)) {
    throw new Error('claude-oauth auth.json is not configured.');
  }

  if (auth.type !== 'oauth' && auth.type !== 'api') {
    throw new Error('claude-oauth auth.json must contain either OAuth or API credentials.');
  }

  return auth;
}

function buildOauthProfile(auth) {
  const expires = Number(auth.expires);

  if (typeof auth.access !== 'string' || !auth.access) {
    throw new Error('claude-oauth auth.json is missing the OAuth access token.');
  }

  if (typeof auth.refresh !== 'string' || !auth.refresh) {
    throw new Error('claude-oauth auth.json is missing the OAuth refresh token.');
  }

  if (!Number.isFinite(expires) || expires <= 0) {
    throw new Error('claude-oauth auth.json is missing a valid OAuth expiry timestamp.');
  }

  return {
    type: 'oauth',
    provider: 'anthropic',
    access: auth.access,
    refresh: auth.refresh,
    expires,
  };
}

function buildApiProfile(auth) {
  const rawAuth = loadJson(getAuthPath());
  const key = isPlainObject(rawAuth) && typeof rawAuth.key === 'string' && rawAuth.key ? rawAuth.key : auth.access;

  if (typeof key !== 'string' || !key) {
    throw new Error('claude-oauth auth.json is missing the Anthropic API key.');
  }

  return {
    type: 'api_key',
    provider: 'anthropic',
    key,
  };
}

function buildProfile(auth) {
  if (auth.type === 'oauth') {
    return buildOauthProfile(auth);
  }

  return buildApiProfile(auth);
}

/**
 * Syncs claude-oauth credentials into the selected OpenClaw agent profile store.
 *
 * @param {{ agentId?: string } | undefined} options
 * @returns {Promise<{ agentId: string, path: string, profileName: string, authType: string }>}
 */
export async function run(options = {}) {
  const agentId = resolveAgentId(options);
  const authProfilesPath = getAuthProfilesPath(agentId);
  const auth = validateConfiguredAuth(loadAuth());
  const profile = buildProfile(auth);
  const currentStore = loadJson(authProfilesPath);

  if (!isPlainObject(currentStore)) {
    throw new Error(`OpenClaw auth profiles file must contain a JSON object: ${authProfilesPath}`);
  }

  const currentProfiles = typeof currentStore.profiles === 'undefined' ? {} : currentStore.profiles;

  if (!isPlainObject(currentProfiles)) {
    throw new Error(`OpenClaw auth profiles file must contain a "profiles" object: ${authProfilesPath}`);
  }

  const nextStore = {
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
