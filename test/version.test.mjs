import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildVersionInfo, formatExporterLine, formatVersionLines } from '../src/version.mjs';

const FIXED_RUNTIME = { node: 'v20.10.0', platform: 'darwin', arch: 'arm64' };
const FIXED_PATHS = { installDir: '/opt/clw-auth', dataDir: '/home/u/.local/share/clw-auth' };

describe('buildVersionInfo', () => {
  it('uses provided overrides without performing any IO', () => {
    const info = buildVersionInfo({
      packageVersion: '9.9.9',
      gitInfo: { managed: true, commit: 'abc1234', tag: 'v9.9.9', dirty: false, builtAt: '2026-04-13T14:30:00Z' },
      runtime: FIXED_RUNTIME,
      paths: FIXED_PATHS,
    });

    assert.equal(info.name, 'clw-auth');
    assert.equal(info.version, '9.9.9');
    assert.equal(info.git.commit, 'abc1234');
    assert.equal(info.git.tag, 'v9.9.9');
    assert.equal(info.git.dirty, false);
    assert.equal(info.runtime.node, 'v20.10.0');
    assert.equal(info.paths.installDir, '/opt/clw-auth');
    assert.equal(info.paths.dataDir, '/home/u/.local/share/clw-auth');
  });
});

describe('formatVersionLines', () => {
  it('renders commit, tag, build timestamp, runtime, and paths when fully populated', () => {
    const info = {
      name: 'clw-auth',
      version: '0.9.6',
      git: { managed: true, commit: 'b1c2d3e', tag: 'v0.9.6', dirty: false, builtAt: '2026-04-13T14:30:00Z' },
      runtime: FIXED_RUNTIME,
      paths: FIXED_PATHS,
    };

    assert.deepEqual(formatVersionLines(info), [
      'clw-auth 0.9.6',
      '  commit:    b1c2d3e (tag v0.9.6)',
      '  built:     2026-04-13T14:30:00Z',
      '  node:      v20.10.0',
      '  platform:  darwin/arm64',
      '  install:   /opt/clw-auth',
      '  data:      /home/u/.local/share/clw-auth',
    ]);
  });

  it('appends [dirty] when the working tree has uncommitted changes', () => {
    const info = {
      name: 'clw-auth',
      version: '0.9.6',
      git: { managed: true, commit: 'b1c2d3e', tag: 'v0.9.6', dirty: true, builtAt: '2026-04-13T14:30:00Z' },
      runtime: FIXED_RUNTIME,
      paths: FIXED_PATHS,
    };

    const lines = formatVersionLines(info);

    assert.equal(lines[1], '  commit:    b1c2d3e (tag v0.9.6) [dirty]');
  });

  it('omits the tag suffix when HEAD is not on a tag', () => {
    const info = {
      name: 'clw-auth',
      version: '0.9.6-dev',
      git: { managed: true, commit: 'b1c2d3e', tag: null, dirty: false, builtAt: '2026-04-13T14:30:00Z' },
      runtime: FIXED_RUNTIME,
      paths: FIXED_PATHS,
    };

    const lines = formatVersionLines(info);

    assert.equal(lines[1], '  commit:    b1c2d3e');
  });

  it('reports a non-git installation when no git metadata is available', () => {
    const info = {
      name: 'clw-auth',
      version: '0.9.6',
      git: { managed: false, commit: null, tag: null, dirty: null, builtAt: null },
      runtime: FIXED_RUNTIME,
      paths: FIXED_PATHS,
    };

    const lines = formatVersionLines(info);

    assert.equal(lines[1], '  commit:    (not a git installation)');
    // No 'built:' line either.
    assert.equal(lines.find((line) => line.startsWith('  built:')), undefined);
  });

  it('appends an exporters section when exporters are present', () => {
    const info = {
      name: 'clw-auth',
      version: '0.9.7',
      git: { managed: true, commit: 'abc1234', tag: 'v0.9.7', dirty: false, builtAt: '2026-05-02T10:00:00Z' },
      runtime: FIXED_RUNTIME,
      paths: FIXED_PATHS,
      exporters: [
        { name: 'opencode', status: 'up-to-date', installedClwVersion: '0.9.7' },
        { name: 'openclaw', status: 'configured', configuredAgents: ['default'] },
      ],
    };

    const lines = formatVersionLines(info);

    assert.ok(lines.some((l) => l.trim() === 'exporters:'));
    assert.ok(lines.some((l) => l.includes('opencode') && l.includes('up-to-date')));
    assert.ok(lines.some((l) => l.includes('openclaw') && l.includes('configured')));
  });
});

describe('formatExporterLine', () => {
  it('renders up-to-date with installed version', () => {
    const line = formatExporterLine({ name: 'opencode', status: 'up-to-date', installedClwVersion: '0.9.7' });
    assert.ok(line.startsWith('opencode  '));
    assert.ok(line.includes('[up-to-date]'));
    assert.ok(line.includes('v0.9.7'));
  });

  it('renders outdated with arrow detail', () => {
    const line = formatExporterLine({ name: 'opencode', status: 'outdated', installedClwVersion: '0.9.6', currentClwVersion: '0.9.7' });
    assert.ok(line.includes('[outdated]'));
    assert.ok(line.includes('v0.9.6 → v0.9.7'));
  });

  it('renders ahead with diagnostic detail', () => {
    const line = formatExporterLine({ name: 'opencode', status: 'ahead', installedClwVersion: '0.9.8', currentClwVersion: '0.9.7' });
    assert.ok(line.includes('[ahead]'));
    assert.ok(line.includes('v0.9.8 ahead of clw-auth v0.9.7'));
  });

  it('renders unknown with reinstall hint', () => {
    const line = formatExporterLine({ name: 'opencode', status: 'unknown' });
    assert.ok(line.includes('[unknown]'));
    assert.ok(line.includes('no plugin-meta header'));
  });

  it('renders configured with agent count', () => {
    const line = formatExporterLine({ name: 'openclaw', status: 'configured', configuredAgents: ['default', 'secondary'] });
    assert.ok(line.includes('[configured]'));
    assert.ok(line.includes('(2 agents)'));
  });

  it('renders error with the error message', () => {
    const line = formatExporterLine({ name: 'opencode', status: 'error', error: 'permission denied' });
    assert.ok(line.includes('[error]'));
    assert.ok(line.includes('permission denied'));
  });

  it('renders not-installed plainly', () => {
    const line = formatExporterLine({ name: 'openclaw', status: 'not-installed' });
    assert.ok(line.includes('[not-installed]'));
  });

  it('degrades gracefully for null/undefined input', () => {
    assert.ok(formatExporterLine(null).includes('(unknown)'));
    assert.ok(formatExporterLine(undefined).includes('(unknown)'));
  });
});
