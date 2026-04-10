import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfiguredAuth,
  buildOauthProfile,
  buildApiProfile,
  buildAnthropicRequestHeaders,
  applyAnthropicProviderOverrides,
} from '../src/exporters/openclaw.mjs';

describe('validateConfiguredAuth', () => {
  it('passes valid oauth auth through unchanged', () => {
    const auth = { type: 'oauth', access: 'acc', refresh: 'ref', expires: 9999 };
    assert.equal(validateConfiguredAuth(auth), auth);
  });

  it('passes valid api auth through unchanged', () => {
    const auth = { type: 'api', key: 'sk-ant-123' };
    assert.equal(validateConfiguredAuth(auth), auth);
  });

  it('throws when auth is null', () => {
    assert.throws(() => validateConfiguredAuth(null), /not configured/);
  });

  it('throws when auth is a non-object', () => {
    assert.throws(() => validateConfiguredAuth('string'), /not configured/);
  });

  it('throws when type is unknown', () => {
    assert.throws(() => validateConfiguredAuth({ type: 'unknown' }), /OAuth or API/);
  });

  it('throws when type is missing', () => {
    assert.throws(() => validateConfiguredAuth({}), /OAuth or API/);
  });
});

describe('buildOauthProfile', () => {
  const validAuth = { type: 'oauth', access: 'acc-token', refresh: 'ref-token', expires: 9_999_999_999 };

  it('returns correct OpenClaw oauth profile shape', () => {
    const result = buildOauthProfile(validAuth);
    assert.deepEqual(result, {
      type: 'oauth',
      provider: 'anthropic',
      access: 'acc-token',
      refresh: 'ref-token',
      expires: 9_999_999_999,
    });
  });

  it('throws when access token is missing', () => {
    assert.throws(() => buildOauthProfile({ ...validAuth, access: '' }), /access token/);
  });

  it('throws when refresh token is missing', () => {
    assert.throws(() => buildOauthProfile({ ...validAuth, refresh: '' }), /refresh token/);
  });

  it('throws when expires is zero', () => {
    assert.throws(() => buildOauthProfile({ ...validAuth, expires: 0 }), /expiry/);
  });

  it('throws when expires is not a number', () => {
    assert.throws(() => buildOauthProfile({ ...validAuth, expires: 'bad' }), /expiry/);
  });

  it('casts string expires to number', () => {
    const result = buildOauthProfile({ ...validAuth, expires: '9999999999' });
    assert.equal(typeof result.expires, 'number');
  });
});

describe('buildApiProfile', () => {
  it('returns correct OpenClaw api_key profile shape', () => {
    const result = buildApiProfile({ type: 'api', key: 'sk-ant-api03-test' });
    assert.deepEqual(result, {
      type: 'api_key',
      provider: 'anthropic',
      key: 'sk-ant-api03-test',
    });
  });

  it('throws when key is missing', () => {
    assert.throws(() => buildApiProfile({ type: 'api' }), /API key/);
  });

  it('throws when key is empty string', () => {
    assert.throws(() => buildApiProfile({ type: 'api', key: '' }), /API key/);
  });

  it('throws when key is not a string', () => {
    assert.throws(() => buildApiProfile({ type: 'api', key: 123 }), /API key/);
  });
});

describe('buildAnthropicRequestHeaders', () => {
  const runtimeConfig = {
    betaHeaders: ['oauth-2025-04-20', 'claude-code-20250219'],
    userAgent: 'claude-cli/2.1.98 (external, cli)',
  };

  it('builds the Claude Code-like Anthropic header set', () => {
    const headers = buildAnthropicRequestHeaders(runtimeConfig, 'session-123');

    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
    assert.equal(headers['user-agent'], 'claude-cli/2.1.98 (external, cli)');
    assert.equal(headers['x-app'], 'cli');
    assert.equal(headers['x-claude-code-session-id'], 'session-123');
    assert.equal(headers['x-stainless-lang'], 'js');
    assert.equal(headers['x-stainless-runtime'], 'node');
    assert.equal(headers['x-stainless-retry-count'], '0');
    assert.equal(headers['x-stainless-timeout'], '600');
    assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(headers['accept-encoding'], 'identity');
  });
});

describe('applyAnthropicProviderOverrides', () => {
  const runtimeConfig = {
    betaHeaders: ['oauth-2025-04-20', 'claude-code-20250219'],
    userAgent: 'claude-cli/2.1.98 (external, cli)',
  };

  it('creates provider headers and request headers without losing existing provider config', () => {
    const current = {
      models: {
        providers: {
          anthropic: {
            baseUrl: 'https://api.anthropic.com',
            api: 'anthropic-messages',
            models: [{ id: 'claude-haiku-4-5' }],
            headers: { 'x-existing': 'keep-me' },
            request: { headers: { 'x-request-existing': 'keep-too' } },
          },
          qwen: { baseUrl: 'https://example.com' },
        },
      },
    };

    const next = applyAnthropicProviderOverrides(current, runtimeConfig, 'session-123');

    assert.equal(next.models.providers.qwen.baseUrl, 'https://example.com');
    assert.equal(next.models.providers.anthropic.baseUrl, 'https://api.anthropic.com');
    assert.equal(next.models.providers.anthropic.api, 'anthropic-messages');
    assert.deepEqual(next.models.providers.anthropic.models, [{ id: 'claude-haiku-4-5' }]);
    assert.equal(next.models.providers.anthropic.headers['x-existing'], 'keep-me');
    assert.equal(next.models.providers.anthropic.headers['anthropic-version'], '2023-06-01');
    assert.equal(next.models.providers.anthropic.headers['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
    assert.equal(next.models.providers.anthropic.request.headers['x-request-existing'], 'keep-too');
    assert.equal(next.models.providers.anthropic.request.headers['x-app'], 'cli');
    assert.equal(next.models.providers.anthropic.request.headers['x-claude-code-session-id'], 'session-123');
  });
});
