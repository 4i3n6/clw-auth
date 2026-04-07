import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommit, detectBumpType, checkQuality, formatEntry, groupCommits } from '../scripts/release.mjs';

const LONG_BODY = 'This is a sufficiently long body that explains why the change was made.';

describe('parseCommit', () => {
  it('parses a feat commit', () => {
    const c = parseCommit({ hash: 'abc1234', subject: 'feat(cli): add new command', body: LONG_BODY });
    assert.equal(c.type, 'feat');
    assert.equal(c.scope, 'cli');
    assert.equal(c.breaking, false);
    assert.equal(c.description, 'add new command');
    assert.equal(c.body, LONG_BODY);
  });

  it('parses a fix commit without scope', () => {
    const c = parseCommit({ hash: 'abc1234', subject: 'fix: correct null check', body: LONG_BODY });
    assert.equal(c.type, 'fix');
    assert.equal(c.scope, null);
  });

  it('detects breaking change from bang operator', () => {
    const c = parseCommit({ hash: 'abc1234', subject: 'feat!: breaking feature', body: LONG_BODY });
    assert.equal(c.breaking, true);
    assert.equal(c.type, 'feat');
  });

  it('detects breaking change from BREAKING CHANGE in body', () => {
    const c = parseCommit({ hash: 'abc1234', subject: 'feat: something', body: 'BREAKING CHANGE: removes old API' });
    assert.equal(c.breaking, true);
  });

  it('handles non-conventional commit subject', () => {
    const c = parseCommit({ hash: 'abc1234', subject: 'random commit message', body: '' });
    assert.equal(c.type, null);
    assert.equal(c.breaking, false);
    assert.equal(c.description, 'random commit message');
  });

  it('parses chore commit', () => {
    const c = parseCommit({ hash: 'abc1234', subject: 'chore(deps): update lockfile', body: '' });
    assert.equal(c.type, 'chore');
    assert.equal(c.scope, 'deps');
  });
});

describe('detectBumpType', () => {
  it('returns patch for only fix commits', () => {
    const commits = [
      parseCommit({ hash: 'a', subject: 'fix: null check', body: LONG_BODY }),
      parseCommit({ hash: 'b', subject: 'chore: lint', body: '' }),
    ];
    assert.equal(detectBumpType(commits), 'patch');
  });

  it('returns minor when any feat is present', () => {
    const commits = [
      parseCommit({ hash: 'a', subject: 'feat: new feature', body: LONG_BODY }),
      parseCommit({ hash: 'b', subject: 'fix: something', body: LONG_BODY }),
    ];
    assert.equal(detectBumpType(commits), 'minor');
  });

  it('returns major when any breaking change is present', () => {
    const commits = [
      parseCommit({ hash: 'a', subject: 'fix: something', body: LONG_BODY }),
      parseCommit({ hash: 'b', subject: 'feat!: breaking', body: LONG_BODY }),
    ];
    assert.equal(detectBumpType(commits), 'major');
  });

  it('major takes precedence over minor', () => {
    const commits = [
      parseCommit({ hash: 'a', subject: 'feat: new thing', body: LONG_BODY }),
      parseCommit({ hash: 'b', subject: 'feat!: breaking', body: LONG_BODY }),
    ];
    assert.equal(detectBumpType(commits), 'major');
  });

  it('returns patch for only chore commits', () => {
    const commits = [
      parseCommit({ hash: 'a', subject: 'chore: update readme', body: '' }),
    ];
    assert.equal(detectBumpType(commits), 'patch');
  });
});

describe('checkQuality', () => {
  it('passes when feat has a long enough body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'feat: thing', body: LONG_BODY })];
    assert.equal(checkQuality(commits).length, 0);
  });

  it('fails when feat has no body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'feat: thing', body: '' })];
    assert.equal(checkQuality(commits).length, 1);
  });

  it('fails when feat body is too short', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'feat: thing', body: 'short' })];
    assert.equal(checkQuality(commits).length, 1);
  });

  it('passes when fix has a long enough body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'fix: thing', body: LONG_BODY })];
    assert.equal(checkQuality(commits).length, 0);
  });

  it('fails when fix has no body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'fix: thing', body: '' })];
    assert.equal(checkQuality(commits).length, 1);
  });

  it('passes for chore without body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'chore: thing', body: '' })];
    assert.equal(checkQuality(commits).length, 0);
  });

  it('passes for docs without body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'docs: update readme', body: '' })];
    assert.equal(checkQuality(commits).length, 0);
  });

  it('fails for breaking change without body', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'feat!: breaking', body: '' })];
    assert.equal(checkQuality(commits).length, 1);
  });

  it('returns multiple failures', () => {
    const commits = [
      parseCommit({ hash: 'a', subject: 'feat: no body', body: '' }),
      parseCommit({ hash: 'b', subject: 'fix: no body', body: '' }),
      parseCommit({ hash: 'c', subject: 'chore: ok without body', body: '' }),
    ];
    assert.equal(checkQuality(commits).length, 2);
  });
});

describe('formatEntry', () => {
  it('formats entry with body as rich bullet', () => {
    const c = parseCommit({ hash: 'a', subject: 'feat: add wizard', body: 'Adds an interactive setup wizard for first-time users.' });
    const result = formatEntry(c);
    assert.ok(result.startsWith('- **add wizard**'));
    assert.ok(result.includes('interactive setup wizard'));
  });

  it('formats entry without body as simple bold bullet', () => {
    const c = parseCommit({ hash: 'a', subject: 'chore: update readme', body: '' });
    assert.equal(formatEntry(c), '- **update readme**');
  });

  it('collapses multiline body into single line', () => {
    const c = parseCommit({ hash: 'a', subject: 'fix: null check', body: 'Fixes a null check\nthat caused a crash\nin edge cases.' });
    const result = formatEntry(c);
    assert.ok(!result.includes('\n'));
    assert.ok(result.includes('null check'));
  });
});

describe('groupCommits', () => {
  it('routes feat to Added group', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'feat: new thing', body: LONG_BODY })];
    const groups = groupCommits(commits);
    assert.equal(groups.feat.length, 1);
    assert.equal(groups.fix.length, 0);
  });

  it('routes fix to Fixed group', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'fix: null ptr', body: LONG_BODY })];
    const groups = groupCommits(commits);
    assert.equal(groups.fix.length, 1);
  });

  it('routes breaking to Breaking Changes group', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'feat!: rename binary', body: LONG_BODY })];
    const groups = groupCommits(commits);
    assert.equal(groups.breaking.length, 1);
    assert.equal(groups.feat.length, 0);
  });

  it('routes chore to Changed group', () => {
    const commits = [parseCommit({ hash: 'a', subject: 'chore: update deps', body: '' })];
    const groups = groupCommits(commits);
    assert.equal(groups.chore.length, 1);
  });
});
