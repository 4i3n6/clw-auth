import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareTags, parseUpdateArgs } from '../src/update.mjs';

describe('compareTags', () => {
  it('treats v-prefixed and bare tags as equal', () => {
    assert.equal(compareTags('v1.2.3', '1.2.3'), 0);
    assert.equal(compareTags('1.2.3', 'v1.2.3'), 0);
  });

  it('returns -1 when the left tag is older', () => {
    assert.equal(compareTags('v1.0.0', 'v1.0.1'), -1);
    assert.equal(compareTags('v0.9.5', 'v0.9.6'), -1);
  });

  it('returns 1 when the left tag is newer', () => {
    assert.equal(compareTags('v1.0.1', 'v1.0.0'), 1);
    assert.equal(compareTags('v0.10.0', 'v0.9.99'), 1);
  });

  it('compares numerically (not lexically) so v1.10.0 > v1.2.0', () => {
    assert.equal(compareTags('v1.10.0', 'v1.2.0'), 1);
    assert.equal(compareTags('v1.2.0', 'v1.10.0'), -1);
  });

  it('treats missing minor/patch components as zero', () => {
    assert.equal(compareTags('v1', 'v1.0.0'), 0);
    assert.equal(compareTags('v1.0', 'v1.0.0'), 0);
    assert.equal(compareTags('v2', 'v1.99.99'), 1);
  });
});

describe('parseUpdateArgs', () => {
  it('returns defaults for an empty argv tail', () => {
    assert.deepEqual(parseUpdateArgs([]), { check: false, yes: false, help: false });
  });

  it('recognizes --check and its short form -n', () => {
    assert.equal(parseUpdateArgs(['--check']).check, true);
    assert.equal(parseUpdateArgs(['-n']).check, true);
  });

  it('recognizes --yes and its short form -y', () => {
    assert.equal(parseUpdateArgs(['--yes']).yes, true);
    assert.equal(parseUpdateArgs(['-y']).yes, true);
  });

  it('recognizes --help and its short form -h', () => {
    assert.equal(parseUpdateArgs(['--help']).help, true);
    assert.equal(parseUpdateArgs(['-h']).help, true);
  });

  it('throws on unknown options', () => {
    assert.throws(() => parseUpdateArgs(['--force']), /Unknown option for update: --force/);
    assert.throws(() => parseUpdateArgs(['v0.9.6']), /Unknown option for update: v0\.9\.6/);
  });

  it('rejects --check and --yes together (mutually exclusive)', () => {
    assert.throws(
      () => parseUpdateArgs(['--check', '--yes']),
      /--check and --yes cannot be used together/,
    );
  });
});
