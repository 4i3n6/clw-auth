#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT          = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH      = resolve(ROOT, 'package.json');
const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md');

const BODY_REQUIRED_TYPES = new Set(['feat', 'fix']);
const MIN_BODY_LENGTH = 20;

export { parseCommit, detectBumpType, checkQuality, formatEntry, groupCommits, buildEntry };

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Commit parsing — reads subject and body separately per commit
// ---------------------------------------------------------------------------

const COMMIT_SEP = '---CLW-COMMIT-END---';

function readCommits(logRange) {
  const raw = git(['log', logRange, `--format=%H%n%s%n%b%n${COMMIT_SEP}`, '--no-merges']);

  return raw
    .split(COMMIT_SEP)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const hash    = lines[0].trim();
      const subject = lines[1]?.trim() ?? '';
      const body    = lines.slice(2).join('\n').trim();
      return { hash, subject, body };
    })
    .filter((c) => c.hash && c.subject);
}

function parseCommit({ hash, subject, body }) {
  const match = subject.match(/^([a-z]+)(\(([^)]+)\))?(!)?: (.+)$/);
  if (!match) {
    return { hash, type: null, scope: null, breaking: false, description: subject, body };
  }

  const [, type, , scope, bang, description] = match;
  const breaking = bang === '!' || /BREAKING[- ]CHANGE/i.test(body);

  return { hash, type, scope: scope ?? null, breaking, description, body };
}

// ---------------------------------------------------------------------------
// Quality enforcement
// ---------------------------------------------------------------------------

function checkQuality(commits) {
  return commits.filter((c) => {
    if (!c.type) return false;
    if (c.breaking) return !c.body || c.body.length < MIN_BODY_LENGTH;
    return BODY_REQUIRED_TYPES.has(c.type) && (!c.body || c.body.length < MIN_BODY_LENGTH);
  });
}

function failQuality(failing) {
  const lines = [
    '',
    'Quality check failed — these commits need a body before releasing:\n',
  ];

  for (const c of failing) {
    const reason = c.breaking
      ? 'breaking changes require a body description'
      : `${c.type} commits require a body description`;
    lines.push(`  ${c.hash.slice(0, 7)}  ${c.type}${c.scope ? `(${c.scope})` : ''}${c.breaking ? '!' : ''}: ${c.description}`);
    lines.push(`           ↑ ${reason} (>= ${MIN_BODY_LENGTH} chars)\n`);
  }

  lines.push('How to fix:');
  lines.push('  git commit --amend          amend the last commit');
  lines.push('  git rebase -i <hash>^       edit an older commit body');
  lines.push('');

  throw new Error(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseVersion(tag) {
  const m = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Cannot parse version: ${tag}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bump(version, type) {
  const pre = version.major === 0;
  if (type === 'major') return pre
    ? { major: 0, minor: version.minor + 1, patch: 0 }
    : { major: version.major + 1, minor: 0, patch: 0 };
  if (type === 'minor') return { major: version.major, minor: version.minor + 1, patch: 0 };
  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

function detectBumpType(commits) {
  let hasBreaking = false;
  let hasFeat = false;

  for (const c of commits) {
    if (c.breaking) hasBreaking = true;
    if (c.type === 'feat') hasFeat = true;
  }

  if (hasBreaking) return 'major';
  if (hasFeat) return 'minor';
  return 'patch';
}

// ---------------------------------------------------------------------------
// Changelog formatting
// ---------------------------------------------------------------------------

function formatEntry(commit) {
  const title = `**${commit.description}**`;

  if (!commit.body) return `- ${title}`;

  const bodyText = commit.body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

  return `- ${title} — ${bodyText}`;
}

function groupCommits(commits) {
  const groups = { breaking: [], feat: [], fix: [], chore: [] };

  for (const c of commits) {
    const entry = formatEntry(c);
    if (c.breaking)                                             { groups.breaking.push(entry); continue; }
    if (c.type === 'feat')                                      { groups.feat.push(entry); continue; }
    if (c.type === 'fix')                                       { groups.fix.push(entry); continue; }
    if (c.type && c.type !== 'feat' && c.type !== 'fix')       { groups.chore.push(entry); continue; }
  }

  return groups;
}

function buildEntry(version, groups) {
  const date  = new Date().toISOString().slice(0, 10);
  const lines = [`## [${version}] - ${date}`, ''];

  const sections = [
    ['### Breaking Changes', groups.breaking],
    ['### Added',            groups.feat],
    ['### Fixed',            groups.fix],
    ['### Changed',          groups.chore],
  ];

  for (const [heading, items] of sections) {
    if (items.length === 0) continue;
    lines.push(heading, '');
    for (const item of items) lines.push(item);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File updates
// ---------------------------------------------------------------------------

function updatePackageVersion(newVersion) {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

function updateChangelog(newVersion, prevVersion, entry, repoUrl) {
  const raw      = readFileSync(CHANGELOG_PATH, 'utf8');
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
// Main
// ---------------------------------------------------------------------------

function runTests() {
  const { resolve: res } = { resolve: (p) => new URL(p, import.meta.url).pathname };
  const testFiles = [
    res('../test/store.test.mjs'),
    res('../test/auth.test.mjs'),
    res('../test/cron.test.mjs'),
    res('../test/ensure-fresh.test.mjs'),
    res('../test/openclaw.test.mjs'),
    res('../test/release.test.mjs'),
    res('../test/version.test.mjs'),
  ];

  process.stdout.write('Running tests...\n');

  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CLW_DATA_DIR: '/tmp/clw-auth-test' },
  });

  if (result.status !== 0) {
    throw new Error('Tests failed. Fix failing tests before releasing.');
  }

  process.stdout.write('All tests passed.\n\n');
}

async function main() {
  const force = process.argv.includes('--force');

  const status = git(['status', '--porcelain']);
  if (status) throw new Error('Working tree is not clean. Commit or stash changes first.');

  runTests();

  const pkg     = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const repoUrl = git(['remote', 'get-url', 'origin'])
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/[^@]+@/, 'https://');

  const lastTag = (() => {
    try { return git(['describe', '--tags', '--abbrev=0']); } catch { return null; }
  })();

  const logRange = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const raw      = readCommits(logRange);

  if (raw.length === 0) {
    process.stdout.write('No commits since last release. Nothing to release.\n');
    return;
  }

  const commits  = raw.map(parseCommit);
  const failing  = checkQuality(commits);

  if (failing.length > 0 && !force) failQuality(failing);
  if (failing.length > 0 && force) {
    process.stdout.write(`Warning: skipping quality check for ${failing.length} commit(s) (--force).\n\n`);
  }

  const currentVersion = parseVersion(lastTag ?? `v${pkg.version}`);
  const bumpType       = detectBumpType(commits);
  const nextVersion    = formatVersion(bump(currentVersion, bumpType));
  const groups         = groupCommits(commits);
  const entry          = buildEntry(nextVersion, groups);

  process.stdout.write(`\nLast release:  ${lastTag ?? '(none)'}\n`);
  process.stdout.write(`Commits:       ${commits.length}\n`);
  process.stdout.write(`Bump type:     ${bumpType}\n`);
  process.stdout.write(`Next version:  v${nextVersion}\n`);
  process.stdout.write('\n--- CHANGELOG preview ---\n\n');
  process.stdout.write(entry);
  process.stdout.write('\n---\n\nProceed? [y/N] ');

  const answer = await new Promise((res) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => res(d.trim().toLowerCase()));
  });

  if (answer !== 'y') { process.stdout.write('Aborted.\n'); process.exit(0); }

  updatePackageVersion(nextVersion);
  updateChangelog(nextVersion, formatVersion(currentVersion), entry, repoUrl);

  git(['add', 'package.json', 'CHANGELOG.md']);
  git(['commit', '-m', `chore(release): v${nextVersion}`]);
  git(['tag', '-a', `v${nextVersion}`, '-m', `Release v${nextVersion}`]);
  git(['push', 'origin', 'HEAD']);
  git(['push', 'origin', `v${nextVersion}`]);

  process.stdout.write(`\nReleased v${nextVersion} and pushed tag.\n`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`\nError: ${error.message}\n`);
    process.exit(1);
  });
}
