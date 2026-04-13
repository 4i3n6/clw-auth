import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCronLine, getLatestCronRunRecord, getRecentCronLogIssue } from '../src/cron.mjs';

describe('buildCronLine', () => {
  it('pins the Node executable and quotes all paths', () => {
    const cronLine = buildCronLine('/tmp/my cli.mjs', '/tmp/my cron.log', '/opt/homebrew/bin/node');

    assert.equal(
      cronLine,
      '0 */6 * * * "/opt/homebrew/bin/node" "/tmp/my cli.mjs" cron-run >> "/tmp/my cron.log" 2>&1',
    );
  });
});

describe('getLatestCronRunRecord', () => {
  it('returns the newest cron run record regardless of status', () => {
    const logContents = [
      '{"ts":"2026-04-09T23:36:52.474Z","event":"cron-run-completed","details":{"actions":["oauth refresh not needed"]}}',
      '{"ts":"2026-04-10T00:01:00.000Z","event":"cron-run-failed","details":{"error":"network timeout"}}',
    ].join('\n');

    const entry = getLatestCronRunRecord(logContents);

    assert.equal(entry?.event, 'cron-run-failed');
    assert.equal(entry?.details?.error, 'network timeout');
  });

  it('returns null when there is no cron run record', () => {
    assert.equal(getLatestCronRunRecord('{"event":"other"}'), null);
  });
});

describe('getRecentCronLogIssue', () => {
  it('returns the most recent stderr-style issue from cron output', () => {
    const logContents = [
      'Error: network request failed',
    ].join('\n');

    assert.equal(getRecentCronLogIssue(logContents), 'Error: network request failed');
  });

  it('returns null when the cron log looks healthy', () => {
    const logContents = [
      'Cron maintenance summary:',
      '- oauth refreshed',
      '- api-reference regenerated',
    ].join('\n');

    assert.equal(getRecentCronLogIssue(logContents), null);
  });

  it('ignores beta drift lines that mention not found', () => {
    const logContents = [
      'Beta header drift (report only):',
      '- fast-mode-2026-02-01: not found',
    ].join('\n');

    assert.equal(getRecentCronLogIssue(logContents), null);
  });

  it('ignores older errors when a later cron run completed successfully', () => {
    const logContents = [
      'OAuth token request failed with status 400',
      'Cron maintenance summary:',
      '- oauth refresh not needed',
      '- api-reference regenerated',
    ].join('\n');

    assert.equal(getRecentCronLogIssue(logContents), null);
  });
});
