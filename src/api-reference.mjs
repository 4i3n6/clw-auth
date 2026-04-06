import {
  getAuthPath,
  loadApiRef,
  loadAuth,
  loadJson,
  saveApiRef,
} from './store.mjs';
import { loadConfig } from './config.mjs';

const ANTHROPIC_API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const CONTENT_TYPE = 'application/json';

const AUTH_NOT_CONFIGURED_NOTE = 'Authentication is not configured. Save OAuth credentials or an API key to populate authorization.';
const API_KEY_UNAVAILABLE_NOTE = 'API key authentication is configured, but the persisted key is unavailable.';
const OAUTH_TOKEN_UNAVAILABLE_NOTE = 'OAuth authentication is configured, but the persisted access token is unavailable.';
const OAUTH_EXPIRY_UNAVAILABLE_NOTE = 'OAuth authentication is configured, but the token expiry is unavailable.';

/**
 * Checks whether a value is a plain object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks whether a value is a non-empty string.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Safely loads normalized auth data.
 *
 * @returns {Record<string, unknown>}
 */
function safeLoadAuth() {
  try {
    const auth = loadAuth();

    return isRecord(auth) ? auth : {};
  } catch {
    return {};
  }
}

/**
 * Safely loads the raw auth payload from disk.
 *
 * @returns {Record<string, unknown>}
 */
function safeLoadRawAuth() {
  try {
    const auth = loadJson(getAuthPath());

    return isRecord(auth) ? auth : {};
  } catch {
    return {};
  }
}

/**
 * Appends a human-readable note to the reference.
 *
 * @param {Record<string, unknown>} reference
 * @param {string} message
 */
function appendNote(reference, message) {
  if (!message) {
    return;
  }

  const currentNote = isNonEmptyString(reference.note) ? reference.note.trim() : '';
  reference.note = currentNote ? `${currentNote} ${message}` : message;
}

/**
 * Builds the headers consumers must send with Anthropic API calls.
 *
 * @returns {Record<string, string>}
 */
function buildHeaders() {
  const config = loadConfig();
  const betaHeaders = Array.isArray(config.betaHeaders)
    ? config.betaHeaders
      .filter((value) => isNonEmptyString(value))
      .map((value) => value.trim())
    : [];

  /** @type {Record<string, string>} */
  const headers = {
    'anthropic-version': ANTHROPIC_API_VERSION,
    'content-type': CONTENT_TYPE,
  };

  if (betaHeaders.length > 0) {
    headers['anthropic-beta'] = betaHeaders.join(',');
  }

  if (isNonEmptyString(config.userAgent)) {
    headers['user-agent'] = config.userAgent.trim();
  }

  return headers;
}

/**
 * Resolves the current auth state for reference generation.
 *
 * @returns {{ type: 'api', key: string } | { type: 'oauth', accessToken: string, expires: number | null } | { type: 'none' }}
 */
function resolveAuthState() {
  const auth = safeLoadAuth();
  const rawAuth = safeLoadRawAuth();
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
    };
  }

  if (storedType === 'oauth' || isNonEmptyString(auth.access) || isNonEmptyString(rawAuth.access)) {
    const accessToken = isNonEmptyString(auth.access)
      ? auth.access.trim()
      : isNonEmptyString(rawAuth.access)
        ? rawAuth.access.trim()
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
      expires,
    };
  }

  return { type: 'none' };
}

/**
 * Builds and persists the Anthropic API reference file.
 *
 * @returns {Record<string, unknown>}
 */
export function generateApiReference() {
  const reference = {
    endpoint: ANTHROPIC_API_ENDPOINT,
    authorization: '',
    headers: buildHeaders(),
    auth_type: 'none',
    last_updated: new Date().toISOString(),
  };
  const authState = resolveAuthState();

  if (authState.type === 'api') {
    reference.auth_type = 'api';
    reference.authorization = authState.key ? `x-api-key: ${authState.key}` : '';

    if (!authState.key) {
      appendNote(reference, API_KEY_UNAVAILABLE_NOTE);
    }
  } else if (authState.type === 'oauth') {
    reference.auth_type = 'oauth';
    reference.authorization = authState.accessToken ? `Bearer ${authState.accessToken}` : '';

    if (!authState.accessToken) {
      appendNote(reference, OAUTH_TOKEN_UNAVAILABLE_NOTE);
    }

    if (Number.isFinite(authState.expires)) {
      reference.token_expires = new Date(authState.expires).toISOString();
      reference.token_expired = authState.expires <= Date.now();
    } else {
      reference.token_expired = true;
      appendNote(reference, OAUTH_EXPIRY_UNAVAILABLE_NOTE);
    }
  } else {
    appendNote(reference, AUTH_NOT_CONFIGURED_NOTE);
  }

  saveApiRef(reference);

  return reference;
}

/**
 * Loads the current persisted Anthropic API reference.
 *
 * @returns {Record<string, unknown>}
 */
export function loadApiReference() {
  return loadApiRef();
}

/**
 * Prints the current persisted Anthropic API reference in a readable format.
 *
 * @returns {Record<string, unknown>}
 */
export function printApiReference() {
  const reference = loadApiReference();

  if (!isRecord(reference) || Object.keys(reference).length === 0) {
    console.log('api-reference.json is empty. Run generateApiReference() to create it.');
    return reference;
  }

  console.log('api-reference.json');
  console.log(JSON.stringify(reference, null, 2));

  return reference;
}
