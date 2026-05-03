import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { inspectExporters, runExporter } from './exporters/index.mjs';
import { compareVersions } from './upstream.mjs';

const INSTALL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/4i3n6/clw-auth';

const EXIT_OK = 0;
const EXIT_ERROR = 2;
const EXIT_UPDATE_AVAILABLE = 10;

function git(args) {
  const result = spawnSync('git', args, { cwd: INSTALL_DIR, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }

  return result.stdout.trim();
}

function gitSafe(args) {
  const result = spawnSync('git', args, { cwd: INSTALL_DIR, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function stripV(tag) {
  if (typeof tag !== 'string') {
    return '';
  }

  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * Compare two release tags using numeric SemVer-style components.
 * Strips a single leading 'v' on each side so 'v1.2.3' and '1.2.3'
 * compare equal. Returns -1, 0, or 1 (left vs right). Pure helper.
 */
export function compareTags(left, right) {
  return compareVersions(stripV(left), stripV(right));
}

/**
 * Parse the argv tail for the `update` command. Recognized flags:
 *   --check / -n  Read-only mode: print versions, exit non-zero (10) when
 *                 an update is available so shell pipelines can detect it.
 *   --yes / -y    Non-interactive apply: skip the confirmation prompt.
 *   --help / -h   Print usage and return (handled by runUpdate).
 *
 * Unknown flags throw with a descriptive message so users get an actionable
 * error instead of a silent no-op. --check and --yes are mutually exclusive
 * because the former is read-only.
 */
export function parseUpdateArgs(args = []) {
  const result = { check: false, yes: false, help: false };

  for (const arg of args) {
    if (arg === '--check' || arg === '-n') {
      result.check = true;
      continue;
    }

    if (arg === '--yes' || arg === '-y') {
      result.yes = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    throw new Error(`Unknown option for update: ${arg}`);
  }

  if (result.check && result.yes) {
    throw new Error('--check and --yes cannot be used together.');
  }

  return result;
}

function latestTag() {
  const tags = gitSafe(['tag', '--sort=-v:refname']);

  if (!tags) {
    return null;
  }

  return tags
    .split('\n')
    .map((t) => t.trim())
    .find((t) => /^v\d/.test(t)) ?? null;
}

function tagsBetween(currentTag, latestTagValue) {
  const tags = gitSafe(['tag', '--sort=v:refname']);

  if (!tags) {
    return [];
  }

  return tags
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d/.test(t))
    .filter((tag) => compareTags(tag, currentTag) > 0 && compareTags(tag, latestTagValue) <= 0);
}

function confirm(prompt) {
  return new Promise((resolveOnce) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolveOnce(answer.trim().toLowerCase() === 'y');
    });
  });
}

function printUsage() {
  console.log('Usage: clw-auth update [--check|-n] [--yes|-y]');
  console.log('');
  console.log('  --check, -n   Print current/latest tags and exit. Exit code 10');
  console.log('                signals that an update is available, 0 means up to');
  console.log('                date, 2 means error. No write side-effects.');
  console.log('  --yes,   -y   Skip the confirmation prompt and apply the update.');
  console.log('                Required when stdin is not a TTY (e.g. in cron).');
}

/**
 * Filter inspectExporters() output to entries that need to be reapplied
 * after a clw-auth upgrade. Pure — accepts the inspect array directly so
 * tests can assert filtering without touching the filesystem.
 *
 * The two states that warrant reapply:
 *   - `outdated`: header version is older than current clw-auth, so the
 *     plugin source may be missing recent template fixes.
 *   - `unknown`:  file present but no parseable header — almost certainly
 *     a pre-v0.9.7 install. Reapply to embed the marker so future updates
 *     can discriminate.
 *
 * `not-installed`, `up-to-date`, `configured`, `not-configured`, `ahead`,
 * and `error` are intentionally NOT reapplied: they are either irrelevant
 * (no install to update) or potentially destructive (writing over an
 * unrelated config the operator opted into).
 */
export function selectExportersToReapply(inspectResults) {
  if (!Array.isArray(inspectResults)) {
    return [];
  }

  return inspectResults.filter((entry) => entry && (entry.status === 'outdated' || entry.status === 'unknown'));
}

/**
 * Reapply each exporter and report a per-name summary. We deliberately do
 * NOT abort the loop on a single failure — one broken exporter must not
 * leave the others stale.
 */
async function reapplyExporters(targets) {
  const summary = [];

  for (const target of targets) {
    try {
      // Run the exporter silently. opencode.run() is verbose by default; we
      // pipe its stdout through a temporary capture to keep the update log
      // focused. If a user wants verbose exporter output, they can run
      // `clw-auth export <name>` directly afterwards.
      const originalLog = console.log;
      console.log = () => {};

      try {
        await runExporter(target.name);
      } finally {
        console.log = originalLog;
      }

      summary.push({ name: target.name, ok: true });
    } catch (error) {
      summary.push({
        name: target.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

export async function runUpdate(args = []) {
  let options;

  try {
    options = parseUpdateArgs(args);
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exit(EXIT_ERROR);
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (!existsSync(resolve(INSTALL_DIR, '.git'))) {
    console.log(`Installation at ${INSTALL_DIR} is not a git repository.`);
    console.log('Re-run the installer to get a git-managed installation:');
    console.log(`  curl -fsSL ${REPO_URL}/raw/master/scripts/install.sh | sh`);

    if (options.check) {
      process.exit(EXIT_ERROR);
    }

    return;
  }

  console.log('Checking for updates...\n');

  const currentTag = gitSafe(['describe', '--tags', '--abbrev=0']) ?? 'unknown';

  try {
    git(['fetch', '--tags', '--quiet']);
  } catch {
    console.error('Could not reach remote. Check your internet connection.');
    process.exit(EXIT_ERROR);
  }

  const newest = latestTag();

  if (!newest) {
    console.log('No release tags found on remote.');
    process.exit(EXIT_ERROR);
  }

  console.log(`Current:  ${currentTag}`);
  console.log(`Latest:   ${newest}`);

  const comparison = currentTag === 'unknown' ? 1 : compareTags(newest, currentTag);

  // Inspect exporter freshness once — used both for the --check exit code and
  // for the post-apply reapply step. Cheap (filesystem reads only).
  const exporterTargets = selectExportersToReapply(inspectExporters());

  if (comparison === 0) {
    if (exporterTargets.length > 0) {
      console.log(`\nclw-auth itself is up to date, but ${exporterTargets.length} exporter(s) need reapply: ${exporterTargets.map((t) => t.name).join(', ')}`);

      if (options.check) {
        console.log('\nReapply required. Run: clw-auth update --yes');
        process.exit(EXIT_UPDATE_AVAILABLE);
      }

      const reapplySummary = await reapplyExporters(exporterTargets);
      printReapplySummary(reapplySummary);
      return;
    }

    console.log('\nAlready on the latest version.');
    return;
  }

  if (comparison < 0) {
    console.log(`\nLocal install is ahead of the latest release tag (${currentTag} > ${newest}).`);
    console.log('No update applied. Use `git pull` if you intend to track master directly.');
    return;
  }

  // comparison > 0: an update is available.
  const intermediate = currentTag === 'unknown' ? [] : tagsBetween(currentTag, newest);

  if (intermediate.length > 1) {
    console.log(`\nUpdate path (${intermediate.length} releases): ${intermediate.join(' → ')}`);
  }

  if (exporterTargets.length > 0) {
    console.log(`Exporters needing reapply: ${exporterTargets.map((t) => t.name).join(', ')}`);
  }

  if (options.check) {
    console.log('\nUpdate available.');
    process.exit(EXIT_UPDATE_AVAILABLE);
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error('\nNon-interactive shell detected and --yes was not provided.');
      console.error('Re-run with: clw-auth update --yes');
      console.error('Or probe without applying: clw-auth update --check');
      process.exit(EXIT_ERROR);
    }

    const proceed = await confirm(`\nUpdate ${currentTag} → ${newest}?`);

    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  }

  try {
    git(['reset', '--hard', '--quiet', newest]);
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Try manually: git -C "${INSTALL_DIR}" reset --hard ${newest}`);
    process.exit(EXIT_ERROR);
  }

  // git reset --hard restores file modes from the index.
  // Ensure the CLI entry point stays executable regardless of stored mode.
  try {
    chmodSync(resolve(INSTALL_DIR, 'src', 'cli.mjs'), 0o755);
  } catch { /* best-effort */ }

  console.log(`\nUpdated to ${newest}.`);
  console.log('The new version is active on the next clw-auth invocation — no shell reload required.');

  // After the upgrade lands, re-inspect exporters: the new clw-auth version
  // bumps the freshness threshold so plugins generated by the previous
  // version flip from up-to-date to outdated. Reapply them so users don't
  // have to remember to run `clw-auth export opencode` manually.
  //
  // We re-inspect rather than reusing the pre-upgrade exporterTargets list
  // because the comparison threshold changed under us.
  const postUpgradeTargets = selectExportersToReapply(inspectExporters());

  if (postUpgradeTargets.length > 0) {
    console.log(`\nReapplying ${postUpgradeTargets.length} exporter(s): ${postUpgradeTargets.map((t) => t.name).join(', ')}`);
    const reapplySummary = await reapplyExporters(postUpgradeTargets);
    printReapplySummary(reapplySummary);
  }
}

function printReapplySummary(summary) {
  for (const entry of summary) {
    if (entry.ok) {
      console.log(`  ✔ ${entry.name}`);
    } else {
      console.log(`  ✖ ${entry.name}: ${entry.error}`);
    }
  }
}
