import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuth } from '../src/store.mjs';

describe('normalizeAuth', () => {
  describe('oauth credentials', () => {
    it('preserves all oauth fields', () => {
      const result = normalizeAuth({ type: 'oauth', access: 'acc', refresh: 'ref', expires: 9999 });
      assert.deepEqual(result, { type: 'oauth', access: 'acc', refresh: 'ref', expires: 9999 });
    });

    it('trims the type field', () => {
      const result = normalizeAuth({ type: '  oauth  ', access: 'acc', refresh: 'ref', expires: 1 });
      assert.equal(result.type, 'oauth');
    });

    it('rejects empty access token', () => {
      const result = normalizeAuth({ type: 'oauth', access: '', refresh: 'ref', expires: 1 });
      assert.ok(!('access' in result));
    });

    it('rejects empty refresh token', () => {
      const result = normalizeAuth({ type: 'oauth', access: 'acc', refresh: '', expires: 1 });
      assert.ok(!('refresh' in result));
    });

    it('accepts numeric expires', () => {
      const result = normalizeAuth({ type: 'oauth', access: 'acc', refresh: 'ref', expires: 1234567890 });
      assert.equal(result.expires, 1234567890);
    });

    it('accepts string expires', () => {
      const result = normalizeAuth({ type: 'oauth', access: 'acc', refresh: 'ref', expires: '1234567890' });
      assert.equal(result.expires, '1234567890');
    });
  });

  describe('api key credentials', () => {
    it('preserves key field', () => {
      const result = normalizeAuth({ type: 'api', key: 'sk-ant-123' });
      assert.deepEqual(result, { type: 'api', key: 'sk-ant-123' });
    });

    it('rejects empty key', () => {
      const result = normalizeAuth({ type: 'api', key: '' });
      assert.ok(!('key' in result));
    });
  });

  describe('invalid input', () => {
    it('returns empty object for null', () => {
      assert.deepEqual(normalizeAuth(null), {});
    });

    it('returns empty object for string', () => {
      assert.deepEqual(normalizeAuth('string'), {});
    });

    it('returns empty object for array', () => {
      assert.deepEqual(normalizeAuth([]), {});
    });

    it('returns empty object for undefined', () => {
      assert.deepEqual(normalizeAuth(undefined), {});
    });
  });

  describe('unknown fields', () => {
    it('strips unknown fields', () => {
      const result = normalizeAuth({ type: 'oauth', access: 'acc', refresh: 'ref', expires: 1, extra: 'x' });
      assert.ok(!('extra' in result));
    });
  });
});
