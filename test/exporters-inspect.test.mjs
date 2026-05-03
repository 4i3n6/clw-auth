import assert from 'node:assert/strict';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  inspectInstall as inspectOpencode,
  parsePluginMeta,
} from '../src/exporters/opencode.mjs';
import {
  inspectInstall as inspectOpenclaw,
} from '../src/exporters/openclaw.mjs';
import { inspectExporters } from '../src/exporters/index.mjs';

describe('parsePluginMeta', () => {
  it('parses a valid first-line marker', () => {
    const meta = parsePluginMeta('// clw-auth-plugin-meta: {"exporter":"opencode","clwVersion":"0.9.7","generatedAt":"2026-05-02T00:00:00.000Z"}\nconst x = 1;');
    assert.equal(meta.exporter, 'opencode');
    assert.equal(meta.clwVersion, '0.9.7');
    assert.equal(meta.generatedAt, '2026-05-02T00:00:00.000Z');
  });

  it('returns null for an empty string', () => {
    assert.equal(parsePluginMeta(''), null);
    assert.equal(parsePluginMeta(null), null);
    assert.equal(parsePluginMeta(undefined), null);
  });

  it('returns null when the marker is missing', () => {
    assert.equal(parsePluginMeta('const x = 1;'), null);
  });

  it('returns null when the marker is not on the first line', () => {
    assert.equal(parsePluginMeta('\n// clw-auth-plugin-meta: {}'), null);
  });

  it('returns null for malformed JSON after the marker', () => {
    assert.equal(parsePluginMeta('// clw-auth-plugin-meta: {broken'), null);
  });

  it('returns null for a non-object JSON literal', () => {
    assert.equal(parsePluginMeta('// clw-auth-plugin-meta: 42'), null);
    assert.equal(parsePluginMeta('// clw-auth-plugin-meta: "string"'), null);
  });
});

describe('inspectInstall (opencode)', () => {
  it('reports not-installed when the plugin file is missing', () => {
    const result = inspectOpencode({ path: '/nonexistent/path/plugin.mjs', currentVersion: '0.9.7' });
    assert.equal(result.name, 'opencode');
    assert.equal(result.status, 'not-installed');
    assert.equal(result.installed, false);
    assert.equal(result.installedClwVersion, null);
    assert.equal(result.currentClwVersion, '0.9.7');
  });

  it('reports unknown when the file exists but has no marker', () => {
    const tmpFile = join(tmpdir(), `clw-test-opencode-${Date.now()}.mjs`);
    writeFileSync(tmpFile, 'console.log("hello");\n');
    try {
      const result = inspectOpencode({ path: tmpFile, currentVersion: '0.9.7' });
      assert.equal(result.status, 'unknown');
      assert.equal(result.installed, true);
      assert.equal(result.installedClwVersion, null);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('reports up-to-date when the marker version matches currentVersion', () => {
    const tmpFile = join(tmpdir(), `clw-test-opencode-${Date.now()}.mjs`);
    writeFileSync(tmpFile, '// clw-auth-plugin-meta: {"clwVersion":"0.9.7"}\nconst x = 1;');
    try {
      const result = inspectOpencode({ path: tmpFile, currentVersion: '0.9.7' });
      assert.equal(result.status, 'up-to-date');
      assert.equal(result.installedClwVersion, '0.9.7');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('reports outdated when the marker version is older', () => {
    const tmpFile = join(tmpdir(), `clw-test-opencode-${Date.now()}.mjs`);
    writeFileSync(tmpFile, '// clw-auth-plugin-meta: {"clwVersion":"0.9.6"}\nconst x = 1;');
    try {
      const result = inspectOpencode({ path: tmpFile, currentVersion: '0.9.7' });
      assert.equal(result.status, 'outdated');
      assert.equal(result.installedClwVersion, '0.9.6');
      assert.equal(result.currentClwVersion, '0.9.7');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('reports ahead when the marker version is newer (operator downgrade)', () => {
    const tmpFile = join(tmpdir(), `clw-test-opencode-${Date.now()}.mjs`);
    writeFileSync(tmpFile, '// clw-auth-plugin-meta: {"clwVersion":"0.9.8"}\nconst x = 1;');
    try {
      const result = inspectOpencode({ path: tmpFile, currentVersion: '0.9.7' });
      assert.equal(result.status, 'ahead');
      assert.equal(result.installedClwVersion, '0.9.8');
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe('inspectInstall (openclaw)', () => {
  it('reports not-configured when the agents directory is missing', () => {
    const result = inspectOpenclaw({ agentsDir: '/nonexistent/agents' });
    assert.equal(result.name, 'openclaw');
    assert.equal(result.status, 'not-configured');
    assert.equal(result.installed, false);
    assert.deepEqual(result.configuredAgents, []);
  });

  it('reports configured with the list of agents that have the anthropic:default profile', () => {
    const tmpDir = join(tmpdir(), `clw-test-openclaw-${Date.now()}`);
    const agentDir = join(tmpDir, 'default', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'auth-profiles.json'),
      JSON.stringify({ profiles: { 'anthropic:default': { provider: 'anthropic' } } }),
    );
    try {
      const result = inspectOpenclaw({ agentsDir: tmpDir });
      assert.equal(result.status, 'configured');
      assert.equal(result.installed, true);
      assert.deepEqual(result.configuredAgents, ['default']);
      assert.ok(result.paths[0].endsWith('auth-profiles.json'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('ignores agents that do not have the anthropic:default profile', () => {
    const tmpDir = join(tmpdir(), `clw-test-openclaw-${Date.now()}`);
    const agentDir = join(tmpDir, 'other', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'auth-profiles.json'),
      JSON.stringify({ profiles: { 'openai:default': {} } }),
    );
    try {
      const result = inspectOpenclaw({ agentsDir: tmpDir });
      assert.equal(result.status, 'not-configured');
      assert.equal(result.installed, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('inspectExporters', () => {
  it('returns an array with an entry for every registered exporter', () => {
    const results = inspectExporters();
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 2, 'expected at least opencode + openclaw');
    const names = results.map((r) => r.name).sort();
    assert.ok(names.includes('opencode'));
    assert.ok(names.includes('openclaw'));
  });

  it('every entry has at least name and status', () => {
    const results = inspectExporters();
    for (const entry of results) {
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0, 'missing name');
      assert.ok(typeof entry.status === 'string' && entry.status.length > 0, 'missing status');
    }
  });
});
