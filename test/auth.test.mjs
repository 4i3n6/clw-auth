import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefreshOauth, splitCodeAndState } from '../src/auth.mjs';

const HOUR_MS = 60 * 60 * 1000;

describe('shouldRefreshOauth', () => {
  it('returns false for api key auth', () => {
    assert.equal(shouldRefreshOauth({ type: 'api', key: 'sk-ant-123' }), false);
  });

  it('returns false for null', () => {
    assert.equal(shouldRefreshOauth(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(shouldRefreshOauth(undefined), false);
  });

  it('returns true when token expires within the refresh window', () => {
    const expires = Date.now() + 30 * 60 * 1000;
    assert.equal(shouldRefreshOauth({ type: 'oauth', access: 'a', refresh: 'r', expires }), true);
  });

  it('returns false when token has plenty of time left', () => {
    const expires = Date.now() + 3 * HOUR_MS;
    assert.equal(shouldRefreshOauth({ type: 'oauth', access: 'a', refresh: 'r', expires }), false);
  });

  it('returns true when token is already expired', () => {
    const expires = Date.now() - 60_000;
    assert.equal(shouldRefreshOauth({ type: 'oauth', access: 'a', refresh: 'r', expires }), true);
  });

  it('returns true exactly at the 1-hour boundary', () => {
    const expires = Date.now() + HOUR_MS - 1;
    assert.equal(shouldRefreshOauth({ type: 'oauth', access: 'a', refresh: 'r', expires }), true);
  });
});

describe('splitCodeAndState', () => {
  it('splits a simple code#state string', () => {
    const result = splitCodeAndState('mycode#mystate');
    assert.deepEqual(result, { code: 'mycode', state: 'mystate' });
  });

  it('handles a state containing special characters', () => {
    const result = splitCodeAndState('code123#state-abc_xyz');
    assert.equal(result.code, 'code123');
    assert.equal(result.state, 'state-abc_xyz');
  });

  it('throws when there is no hash separator', () => {
    assert.throws(() => splitCodeAndState('no-separator-here'), /code#state/);
  });

  it('throws when code is empty', () => {
    assert.throws(() => splitCodeAndState('#onlystate'));
  });

  it('throws when state is empty', () => {
    assert.throws(() => splitCodeAndState('onlycode#'));
  });

  it('throws for empty string', () => {
    assert.throws(() => splitCodeAndState(''));
  });

  it('uses only the first # as separator — rest belongs to state', () => {
    const result = splitCodeAndState('code#state#extra');
    assert.equal(result.code, 'code');
    assert.equal(result.state, 'state#extra');
  });
});
