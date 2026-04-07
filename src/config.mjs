import { existsSync } from 'node:fs';

import { getConfigPath, loadJson, writeJsonAtomic } from './store.mjs';

const CONFIG_FILE_MODE = 0o600;
const DEFAULT_BETA_HEADERS = Object.freeze([
  'interleaved-thinking-2025-05-14',
]);

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  betaHeaders: DEFAULT_BETA_HEADERS,
  userAgent: 'claude-cli/2.1.92 (external, cli)',
});

/**
 * Normalizes raw runtime config into the expected shape.
 *
 * @param {unknown} rawConfig
 * @returns {{ schemaVersion: number, betaHeaders: string[], userAgent: string }}
 */
export function normalizeConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

  const schemaVersion = source.schemaVersion === DEFAULT_CONFIG.schemaVersion
    ? source.schemaVersion
    : DEFAULT_CONFIG.schemaVersion;

  const betaHeaders = Array.isArray(source.betaHeaders)
    ? source.betaHeaders
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [...DEFAULT_CONFIG.betaHeaders];

  const userAgent = typeof source.userAgent === 'string' && source.userAgent.trim()
    ? source.userAgent.trim()
    : DEFAULT_CONFIG.userAgent;

  return {
    schemaVersion,
    betaHeaders,
    userAgent,
  };
}

/**
 * Loads the persisted config and falls back to defaults when missing or invalid.
 *
 * @returns {{ schemaVersion: number, betaHeaders: string[], userAgent: string }}
 */
export function loadConfig() {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return normalizeConfig(DEFAULT_CONFIG);
  }

  try {
    return normalizeConfig(loadJson(configPath));
  } catch {
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

/**
 * Persists runtime config using an atomic write.
 *
 * @param {unknown} config
 * @returns {{ schemaVersion: number, betaHeaders: string[], userAgent: string }}
 */
export function saveConfig(config) {
  const normalizedConfig = normalizeConfig(config);
  writeJsonAtomic(getConfigPath(), normalizedConfig, CONFIG_FILE_MODE);
  return normalizedConfig;
}

/**
 * Parses beta headers from CLI input.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseBetaHeaders(input) {
  if (typeof input !== 'string') {
    throw new Error('Provide beta headers as a comma-separated string or "none".');
  }

  const trimmedInput = input.trim();

  if (!trimmedInput) {
    throw new Error('Provide beta headers as a comma-separated string or "none".');
  }

  if (trimmedInput.toLowerCase() === 'none') {
    return [];
  }

  const betaHeaders = trimmedInput
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (betaHeaders.length === 0) {
    throw new Error('No valid beta headers were provided.');
  }

  return betaHeaders;
}

/**
 * Updates persisted beta headers.
 *
 * @param {unknown} input
 */
export function setBetas(input) {
  const config = loadConfig();
  config.betaHeaders = parseBetaHeaders(input);
  saveConfig(config);
  printConfig();
}

/**
 * Updates the persisted User-Agent string.
 *
 * @param {unknown} input
 */
export function setUserAgent(input) {
  if (typeof input !== 'string') {
    throw new Error('Provide a User-Agent string or "default".');
  }

  const trimmedInput = input.trim();

  if (!trimmedInput) {
    throw new Error('User-Agent cannot be empty.');
  }

  const config = loadConfig();
  config.userAgent = trimmedInput.toLowerCase() === 'default'
    ? DEFAULT_CONFIG.userAgent
    : trimmedInput;

  saveConfig(config);
  printConfig();
}

export function resetConfig() {
  saveConfig(DEFAULT_CONFIG);
  printConfig();
}

export function printConfig() {
  const configPath = getConfigPath();
  const config = loadConfig();

  console.log(`Config path: ${configPath}`);
  console.log(`Schema version: ${config.schemaVersion}`);
  console.log(`Beta headers: ${config.betaHeaders.length > 0 ? config.betaHeaders.join(', ') : '(none)'}`);
  console.log(`User-Agent: ${config.userAgent}`);
}
