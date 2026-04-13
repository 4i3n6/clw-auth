import { createHash, randomBytes } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';

import { loadAuth, saveAuth, debugLog } from './store.mjs';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPE = 'org:create_api_key user:profile user:inference';
const TOKEN_ENDPOINTS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const FETCH_TIMEOUT_MS = 15000;
// The maintenance cron runs every 6 hours. The refresh window must cover at
// least one full cron interval, otherwise a token can expire between ticks and
// never be refreshed in time.
const OAUTH_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

const isObject = (value) => value !== null && typeof value === 'object';

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const base64url = (value) => Buffer.from(value)
  .toString('base64')
  .replace(/\+/gu, '-')
  .replace(/\//gu, '_')
  .replace(/=+$/u, '');

const sha256 = (value) => createHash('sha256').update(value).digest();

const createError = (message, details = {}) => Object.assign(new Error(message), details);

const buildOauthSummary = (action, auth) => ({
  ok: true,
  action,
  type: 'oauth',
  expires: auth.expires,
  expiresAt: new Date(auth.expires).toISOString(),
  hasAccess: Boolean(auth.access),
  hasRefresh: Boolean(auth.refresh),
});

const buildApiSummary = () => ({
  ok: true,
  action: 'api-key-saved',
  type: 'api',
  hasKey: true,
});

const printResult = (result) => {
  console.log(JSON.stringify(result, null, 2));
};

export const splitCodeAndState = (value) => {
  const separatorIndex = value.indexOf('#');

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error('Expected OAuth callback input in code#state format.');
  }

  const code = value.slice(0, separatorIndex);
  const state = value.slice(separatorIndex + 1);

  if (!code || !state) {
    throw new Error('OAuth callback input is missing code or state.');
  }

  return { code, state };
};

const parseHashValue = (hashValue) => {
  if (!hashValue) {
    return { code: '', state: '' };
  }

  if (hashValue.includes('=')) {
    const hashParams = new URLSearchParams(hashValue);

    return {
      code: hashParams.get('code') ?? '',
      state: hashParams.get('state') ?? '',
    };
  }

  return {
    code: '',
    state: hashValue,
  };
};

const normalizeCallbackUrl = (input) => {
  let parsedUrl;

  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error('Expected OAuth callback input in code#state format or as a full callback URL.');
  }

  const hashPayload = parseHashValue(parsedUrl.hash.replace(/^#/u, ''));
  const code = parsedUrl.searchParams.get('code') ?? hashPayload.code;
  const state = parsedUrl.searchParams.get('state') ?? hashPayload.state;

  if (!code || !state) {
    throw new Error('OAuth callback URL is missing code or state.');
  }

  return `${code}#${state}`;
};

const parseTokenResponse = async (response) => {
  const rawBody = await response.text();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
};

const extractErrorMessage = (payload) => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (!isObject(payload)) {
    return '';
  }

  if (typeof payload.error_description === 'string' && payload.error_description) {
    return payload.error_description;
  }

  if (typeof payload.message === 'string' && payload.message) {
    return payload.message;
  }

  if (typeof payload.error === 'string' && payload.error) {
    return payload.error;
  }

  if (isObject(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }

  return '';
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) {
    return null;
  }

  const seconds = Number(retryAfterHeader);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(retryAfterHeader);

  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(retryAt - Date.now(), 0);
};

const requestTokens = async (payload) => {
  let lastError = null;

  for (const endpoint of TOKEN_ENDPOINTS) {
    try {
      return await exchangeWithRetry(endpoint, payload);
    } catch (error) {
      lastError = error;
      debugLog(`OAuth token request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw lastError ?? new Error('OAuth token request failed for all configured endpoints.');
};

const exchangeWithRetry = async (endpoint, payload) => {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    debugLog(`OAuth token request attempt ${attempt + 1} for ${endpoint}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const responsePayload = await parseTokenResponse(response);

      if (response.ok) {
        if (!isObject(responsePayload)) {
          throw createError(`OAuth token endpoint returned an invalid response (${endpoint})`, { endpoint });
        }

        return responsePayload;
      }

      const errorMessage = extractErrorMessage(responsePayload) || response.statusText || 'Request failed';
      const requestError = createError(
        `OAuth token request failed with status ${response.status}: ${errorMessage} (${endpoint})`,
        {
          endpoint,
          status: response.status,
        },
      );

      if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs = retryAfterMs ?? RETRY_DELAYS_MS[attempt];

        debugLog(`OAuth token request rate limited for ${endpoint}; retrying in ${delayMs}ms`);
        await delay(delayMs);
        continue;
      }

      throw requestError;
    } catch (error) {
      if (error instanceof Error && 'status' in error) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw createError(`OAuth token request timed out after ${FETCH_TIMEOUT_MS}ms (${endpoint})`, { endpoint });
      }

      throw createError(
        `OAuth token request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        { endpoint },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw createError(`OAuth token request exceeded retry budget (${endpoint})`, { endpoint });
};

export const buildOauthUrl = () => {
  const verifier = base64url(randomBytes(64));
  const codeChallenge = base64url(sha256(verifier));
  const url = new URL(AUTHORIZE_URL);

  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', verifier);

  return url.toString();
};

export const normalizePastedInput = (input) => {
  if (typeof input !== 'string') {
    throw new TypeError('OAuth callback input must be a string.');
  }

  const normalizedInput = input.trim().replace(/\s+/gu, '');

  if (!normalizedInput) {
    throw new Error('OAuth callback input cannot be empty.');
  }

  if (normalizedInput.includes('://')) {
    return normalizeCallbackUrl(normalizedInput);
  }

  const { code, state } = splitCodeAndState(normalizedInput);

  return `${code}#${state}`;
};

export const buildOauthCredential = (tokenResponse, currentRefresh) => {
  if (!isObject(tokenResponse)) {
    throw new TypeError('OAuth token response must be an object.');
  }

  const access = typeof tokenResponse.access_token === 'string'
    ? tokenResponse.access_token.trim()
    : '';
  const refresh = typeof tokenResponse.refresh_token === 'string' && tokenResponse.refresh_token.trim()
    ? tokenResponse.refresh_token.trim()
    : currentRefresh;
  const expiresIn = Number(tokenResponse.expires_in);

  if (!access) {
    throw new Error('OAuth token response is missing access_token.');
  }

  if (!refresh) {
    throw new Error('OAuth token response is missing refresh_token.');
  }

  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth token response is missing a valid expires_in value.');
  }

  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + (expiresIn * 1000),
  };
};

export const getAuth = async () => {
  const auth = await Promise.resolve(loadAuth());

  return isObject(auth) ? auth : null;
};

export const shouldRefreshOauth = (auth) => {
  const expires = Number(auth?.expires);

  return auth?.type === 'oauth'
    && Number.isFinite(expires)
    && expires <= (Date.now() + OAUTH_REFRESH_WINDOW_MS);
};

export const oauthExchange = async (pastedInput) => {
  const normalizedInput = normalizePastedInput(pastedInput);
  const { code, state } = splitCodeAndState(normalizedInput);
  const tokenResponse = await requestTokens({
    code,
    state,
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: state,
  });
  const auth = buildOauthCredential(tokenResponse);

  await Promise.resolve(saveAuth(auth));
  printResult(buildOauthSummary('oauth-exchanged', auth));

  return auth;
};

export const oauthRefresh = async () => {
  const currentAuth = await getAuth();

  if (!currentAuth || currentAuth.type !== 'oauth') {
    throw new Error('Current auth state is not configured for OAuth.');
  }

  if (!currentAuth.refresh) {
    throw new Error('Current OAuth auth state is missing refresh token.');
  }

  const tokenResponse = await requestTokens({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: currentAuth.refresh,
  });
  const auth = buildOauthCredential(tokenResponse, currentAuth.refresh);

  await Promise.resolve(saveAuth(auth));
  printResult(buildOauthSummary('oauth-refreshed', auth));

  return auth;
};

export const setApiKey = async (key) => {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('API key must be a non-empty string.');
  }

  const auth = {
    type: 'api',
    key: key.trim(),
  };

  await Promise.resolve(saveAuth(auth));
  printResult(buildApiSummary());

  return auth;
};
