import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { acquireFileLockWithRetry, decideRefreshAction } from '../src/cron.mjs';

const FIVE_MIN = 5 * 60 * 1000;

describe('decideRefreshAction', () => {
  it('returns skip-not-configured when auth is null or missing type', () => {
    assert.deepEqual(decideRefreshAction(null), { action: 'skip-not-configured' });
    assert.deepEqual(decideRefreshAction({}), { action: 'skip-not-configured' });
    assert.deepEqual(decideRefreshAction({ type: 'unknown' }), { action: 'skip-not-configured' });
  });

  it('returns skip-api-key when auth is API key', () => {
    assert.deepEqual(decideRefreshAction({ type: 'api', key: 'sk-xxx' }), { action: 'skip-api-key' });
  });

  it('returns error when oauth payload lacks expires', () => {
    const result = decideRefreshAction({ type: 'oauth', refresh: 'r1' });

    assert.equal(result.action, 'error');
    assert.equal(result.reason, 'oauth-missing-expires');
  });

  it('returns error when oauth payload lacks refresh token', () => {
    const result = decideRefreshAction({ type: 'oauth', expires: Date.now() + 60_000, refresh: '' });

    assert.equal(result.action, 'error');
    assert.equal(result.reason, 'oauth-missing-refresh');
  });

  it('returns refresh when token expires within the safety window', () => {
    const now = 1_700_000_000_000;
    const expires = now + 60_000; // 1 minute away
    const result = decideRefreshAction({ type: 'oauth', expires, refresh: 'r1' }, FIVE_MIN, now);

    assert.equal(result.action, 'refresh');
    assert.equal(result.expires, expires);
  });

  it('returns refresh exactly at the window boundary', () => {
    const now = 1_700_000_000_000;
    const expires = now + FIVE_MIN; // exactly at the boundary — must refresh
    const result = decideRefreshAction({ type: 'oauth', expires, refresh: 'r1' }, FIVE_MIN, now);

    assert.equal(result.action, 'refresh');
  });

  it('returns fresh when token expires beyond the safety window', () => {
    const now = 1_700_000_000_000;
    const expires = now + FIVE_MIN + 1; // just past the boundary
    const result = decideRefreshAction({ type: 'oauth', expires, refresh: 'r1' }, FIVE_MIN, now);

    assert.equal(result.action, 'fresh');
    assert.equal(result.expires, expires);
  });

  it('returns refresh when token is already expired', () => {
    const now = 1_700_000_000_000;
    const expires = now - 60_000; // expired 1 minute ago
    const result = decideRefreshAction({ type: 'oauth', expires, refresh: 'r1' }, FIVE_MIN, now);

    assert.equal(result.action, 'refresh');
  });
});

describe('acquireFileLockWithRetry', () => {
  it('acquires a fresh lock when the file does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-auth-lock-'));
    const lockPath = join(dir, 'ensure-fresh.lock');

    try {
      const result = await acquireFileLockWithRetry(lockPath, { timeoutMs: 100, intervalMs: 10 });

      assert.equal(result.acquired, true);
      assert.equal(result.mode, 'fresh');
      assert.equal(existsSync(lockPath), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns wait-timeout when an active lock holds the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-auth-lock-'));
    const lockPath = join(dir, 'ensure-fresh.lock');

    try {
      // Active lock owned by another caller right now.
      writeFileSync(lockPath, `${Date.now()}`, { flag: 'wx', mode: 0o600 });

      const result = await acquireFileLockWithRetry(lockPath, {
        ttlMs: 60_000,
        timeoutMs: 50,
        intervalMs: 10,
      });

      assert.equal(result.acquired, false);
      assert.equal(result.mode, 'wait-timeout');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a stale lock past its TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-auth-lock-'));
    const lockPath = join(dir, 'ensure-fresh.lock');

    try {
      // Stale lock written far in the past (5 minutes ago).
      writeFileSync(lockPath, `${Date.now() - (5 * 60 * 1000)}`, { flag: 'wx', mode: 0o600 });

      const result = await acquireFileLockWithRetry(lockPath, {
        ttlMs: 1_000, // any non-zero TTL — the existing entry is well past it
        timeoutMs: 100,
        intervalMs: 10,
      });

      assert.equal(result.acquired, true);
      assert.equal(result.mode, 'recovered-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
