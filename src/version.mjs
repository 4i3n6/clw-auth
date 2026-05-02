import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Pure assembly of the version snapshot. Tests construct `gitInfo`,
 * `runtime`, and `paths` directly so no IO is performed.
 */
export function buildVersionInfo({
  packageVersion = PACKAGE_VERSION,
  gitInfo,
  runtime,
  paths,
} = {}) {
  return {
    name: 'clw-auth',
    version: packageVersion,
    git: gitInfo ?? collectGitInfo(),
    runtime: runtime ?? collectRuntimeInfo(),
    paths: paths ?? collectPaths(),
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

  return lines;
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
