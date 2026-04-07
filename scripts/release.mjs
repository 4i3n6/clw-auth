#!/usr/bin/env node

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = resolve(ROOT, 'package.json');
const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md');

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// Guard: clean working tree required
// ---------------------------------------------------------------------------

function assertCleanTree() {
  const status = git(['status', '--porcelain']);
  if (status) {
    throw new Error('Working tree is not clean. Commit or stash changes before releasing.');
  }
}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

function parseVersion(tag) {
  const match = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Cannot parse version from tag: ${tag}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bump(version, type) {
  if (type === 'major') return { major: version.major + 1, minor: 0, patch: 0 };
  if (type === 'minor') return { major: version.major, minor: version.minor + 1, patch: 0 };
  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

// ---------------------------------------------------------------------------
// Commit analysis — conventional commits
// ---------------------------------------------------------------------------

function detectBumpType(commits) {
  let hasBreaking = false;
  let hasFeat = false;

  for (const commit of commits) {
    if (/BREAKING.CHANGE/i.test(commit) || /^[a-z]+(\([^)]+\))?!:/.test(commit)) {
      hasBreaking = true;
    }
    if (/^feat(\([^)]+\))?[!:]/.test(commit)) {
      hasFeat = true;
    }
  }

  if (hasBreaking) return 'major';
  if (hasFeat) return 'minor';
  return 'patch';
}

function groupCommits(commits) {
  const groups = { breaking: [], feat: [], fix: [], chore: [], other: [] };

  for (const line of commits) {
    const match = line.match(/^([a-z]+)(\([^)]+\))?(!)?: (.+)$/);
    if (!match) { groups.other.push(line); continue; }

    const [, type,, bang, subject] = match;
    const isBreaking = bang === '!';
    const entry = isBreaking ? `${subject} (**BREAKING**)` : subject;

    if (isBreaking) { groups.breaking.push(entry); continue; }
    if (type === 'feat') { groups.feat.push(entry); continue; }
    if (type === 'fix') { groups.fix.push(entry); continue; }
    if (['chore', 'docs', 'refactor', 'style', 'test', 'ci', 'build'].includes(type)) {
      groups.chore.push(entry); continue;
    }
    groups.other.push(entry);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// CHANGELOG update
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function buildEntry(version, groups, repoUrl) {
  const lines = [`## [${version}] - ${today()}`, ''];

  if (groups.breaking.length > 0) {
    lines.push('### Breaking Changes', '');
    for (const item of groups.breaking) lines.push(`- ${item}`);
    lines.push('');
  }
  if (groups.feat.length > 0) {
    lines.push('### Added', '');
    for (const item of groups.feat) lines.push(`- ${item}`);
    lines.push('');
  }
  if (groups.fix.length > 0) {
    lines.push('### Fixed', '');
    for (const item of groups.fix) lines.push(`- ${item}`);
    lines.push('');
  }
  if (groups.chore.length > 0) {
    lines.push('### Changed', '');
    for (const item of groups.chore) lines.push(`- ${item}`);
    lines.push('');
  }

  return lines.join('\n');
}

function updateChangelog(newVersion, prevVersion, entry, repoUrl) {
  const raw = readFileSync(CHANGELOG_PATH, 'utf8');

  const prevTag  = `v${prevVersion}`;
  const nextTag  = `v${newVersion}`;
  const linkLine = `[${newVersion}]: ${repoUrl}/compare/${prevTag}...${nextTag}`;

  const updated = raw
    .replace('## [Unreleased]', `## [Unreleased]\n\n${entry}`)
    .replace(
      /\[Unreleased\]: .+/,
      `[Unreleased]: ${repoUrl}/compare/${nextTag}...HEAD\n${linkLine}`,
    );

  writeFileSync(CHANGELOG_PATH, updated);
}

// ---------------------------------------------------------------------------
// package.json update
// ---------------------------------------------------------------------------

function updatePackageVersion(newVersion) {
  const raw = readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.version = newVersion;
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  assertCleanTree();

  const pkg      = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const repoUrl  = git(['remote', 'get-url', 'origin'])
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^@]+@/, 'https://');

  const lastTag  = (() => {
    try { return git(['describe', '--tags', '--abbrev=0']); }
    catch { return null; }
  })();

  const logRange = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const rawLog   = git(['log', logRange, '--format=%s %b', '--no-merges']);
  const commits  = rawLog.split('\n').map((l) => l.trim()).filter(Boolean);

  if (commits.length === 0) {
    process.stdout.write('No commits since last release. Nothing to release.\n');
    return;
  }

  const currentVersion = parseVersion(lastTag ?? `v${pkg.version}`);
  const bumpType       = detectBumpType(commits);
  const nextVersion    = formatVersion(bump(currentVersion, bumpType));
  const groups         = groupCommits(commits);
  const entry          = buildEntry(nextVersion, groups, repoUrl);

  process.stdout.write(`\nLast release: ${lastTag ?? '(none)'}\n`);
  process.stdout.write(`Commits:      ${commits.length}\n`);
  process.stdout.write(`Bump type:    ${bumpType}\n`);
  process.stdout.write(`Next version: v${nextVersion}\n\n`);
  process.stdout.write('--- CHANGELOG entry preview ---\n\n');
  process.stdout.write(entry);
  process.stdout.write('\n---\n\nProceed? [y/N] ');

  const answer = await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(d.trim().toLowerCase()));
  });

  if (answer !== 'y') {
    process.stdout.write('Aborted.\n');
    process.exit(0);
  }

  updatePackageVersion(nextVersion);
  updateChangelog(nextVersion, formatVersion(currentVersion), entry, repoUrl);

  git(['add', 'package.json', 'CHANGELOG.md']);
  git(['commit', '-m', `chore(release): v${nextVersion}`]);
  git(['tag', '-a', `v${nextVersion}`, '-m', `Release v${nextVersion}`]);
  git(['push', 'origin', 'HEAD']);
  git(['push', 'origin', `v${nextVersion}`]);

  process.stdout.write(`\nReleased v${nextVersion}.\n`);
  process.stdout.write(`Tag pushed: v${nextVersion}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nError: ${error.message}\n`);
  process.exit(1);
});
