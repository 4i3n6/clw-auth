import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectExporters } from './exporters/index.mjs';
import { getAuthPath } from './store.mjs';

const INSTALL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version;

function gitOutput(args, cwd) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read git metadata about the install dir. All fields are best-effort:
 * any git failure falls back to `null` for that specific field so the
 * version output stays useful even on partially-broken installations
 * (e.g. tarball install with no .git, or detached repo with no tags).
 */
export function collectGitInfo(installDir = INSTALL_DIR) {
  const gitDir = resolve(installDir, '.git');

  if (!existsSync(gitDir)) {
    return {
      managed: false,
      commit: null,
      tag: null,
      dirty: null,
      builtAt: null,
    };
  }

  const status = gitOutput('status --porcelain', installDir);

  return {
    managed: true,
    commit: gitOutput('rev-parse --short HEAD', installDir),
    tag: gitOutput('describe --tags --exact-match HEAD', installDir),
    dirty: status === null ? null : status.length > 0,
    builtAt: gitOutput('show -s --format=%cI HEAD', installDir),
  };
}

export function collectRuntimeInfo() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export function collectPaths(installDir = INSTALL_DIR) {
  return {
    installDir,
    // dirname() strips the trailing path separator that getDataDir() appends.
    dataDir: dirname(getAuthPath()),
  };
}

/**
 * Best-effort exporter freshness collection. Returns the array directly
 * from the registry's inspectExporters() so the JSON shape stays stable.
 * If introspection itself throws (extremely unlikely — each exporter's
 * inspect() catches its own errors), we degrade to an empty array so the
 * version output stays useful.
 */
export function collectExporters() {
  try {
    return inspectExporters();
  } catch {
    return [];
  }
}

/**
 * Pure assembly of the version snapshot. Tests construct `gitInfo`,
 * `runtime`, `paths`, and `exporters` directly so no IO is performed.
 */
export function buildVersionInfo({
  packageVersion = PACKAGE_VERSION,
  gitInfo,
  runtime,
  paths,
  exporters,
} = {}) {
  return {
    name: 'clw-auth',
    version: packageVersion,
    git: gitInfo ?? collectGitInfo(),
    runtime: runtime ?? collectRuntimeInfo(),
    paths: paths ?? collectPaths(),
    exporters: exporters ?? collectExporters(),
  };
}

/**
 * Render the version snapshot as aligned human-readable lines.
 * Exposed separately from printVersionInfo() so tests can assert
 * formatting without touching stdout.
 */
export function formatVersionLines(info) {
  const lines = [];
  lines.push(`${info.name} ${info.version}`);

  const commitParts = [];

  if (info.git?.commit) {
    commitParts.push(info.git.commit);
  }

  if (info.git?.tag) {
    commitParts.push(`(tag ${info.git.tag})`);
  }

  if (info.git?.dirty) {
    commitParts.push('[dirty]');
  }

  if (commitParts.length > 0) {
    lines.push(`  commit:    ${commitParts.join(' ')}`);
  } else if (info.git?.managed === false) {
    lines.push('  commit:    (not a git installation)');
  }

  if (info.git?.builtAt) {
    lines.push(`  built:     ${info.git.builtAt}`);
  }

  lines.push(`  node:      ${info.runtime.node}`);
  lines.push(`  platform:  ${info.runtime.platform}/${info.runtime.arch}`);
  lines.push(`  install:   ${info.paths.installDir}`);
  lines.push(`  data:      ${info.paths.dataDir}`);

  if (Array.isArray(info.exporters) && info.exporters.length > 0) {
    lines.push('');
    lines.push('  exporters:');
    for (const exporter of info.exporters) {
      lines.push(`    ${formatExporterLine(exporter)}`);
    }
  }

  return lines;
}

/**
 * Render a single exporter line for the version output. Pure — accepts the
 * exporter's inspect() result and returns a one-line string. Status is
 * rendered as a tag in brackets so machine parsing stays trivial.
 */
export function formatExporterLine(exporter) {
  const name = (exporter && exporter.name) || '(unknown)';
  const status = (exporter && exporter.status) || 'unknown';
  let detail = '';

  if (exporter) {
    if (status === 'up-to-date' && exporter.installedClwVersion) {
      detail = ` v${exporter.installedClwVersion}`;
    } else if (status === 'outdated') {
      detail = ` v${exporter.installedClwVersion} → v${exporter.currentClwVersion} (run: clw-auth update)`;
    } else if (status === 'ahead') {
      detail = ` v${exporter.installedClwVersion} ahead of clw-auth v${exporter.currentClwVersion}`;
    } else if (status === 'unknown') {
      detail = ' (no plugin-meta header — reinstall to refresh)';
    } else if (status === 'configured' && Array.isArray(exporter.configuredAgents)) {
      detail = ` (${exporter.configuredAgents.length} agent${exporter.configuredAgents.length === 1 ? '' : 's'})`;
    } else if (status === 'error' && exporter.error) {
      detail = ` ${exporter.error}`;
    }
  }

  // Pad name so the [status] column aligns. 10 chars covers the longest
  // current exporter name ('opencode' = 8) plus a small margin.
  const paddedName = name.padEnd(10, ' ');
  return `${paddedName}[${status}]${detail}`;
}

export function printVersionInfo({ json = false } = {}) {
  const info = buildVersionInfo();

  if (json) {
    console.log(JSON.stringify(info, null, 2));
    return info;
  }

  for (const line of formatVersionLines(info)) {
    console.log(line);
  }

  return info;
}
