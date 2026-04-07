import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL    = 'https://github.com/4i3n6/clw-auth';

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

function latestTag() {
  return gitSafe(['tag', '--sort=-v:refname'])
    ?.split('\n')
    .map((t) => t.trim())
    .find((t) => /^v\d/.test(t)) ?? null;
}

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function runUpdate() {
  if (!existsSync(resolve(INSTALL_DIR, '.git'))) {
    console.log(`Installation at ${INSTALL_DIR} is not a git repository.`);
    console.log('Re-run the installer to get a git-managed installation:');
    console.log(`  curl -fsSL ${REPO_URL}/raw/master/scripts/install.sh | sh`);
    return;
  }

  console.log('Checking for updates...\n');

  const currentTag = gitSafe(['describe', '--tags', '--abbrev=0']) ?? 'unknown';

  try {
    git(['fetch', '--tags', '--quiet']);
  } catch {
    console.error('Could not reach remote. Check your internet connection.');
    return;
  }

  const newest = latestTag();

  if (!newest) {
    console.log('No release tags found on remote.');
    return;
  }

  console.log(`Current:  ${currentTag}`);
  console.log(`Latest:   ${newest}`);

  if (currentTag === newest) {
    console.log('\nAlready on the latest version.');
    return;
  }

  const proceed = await confirm(`\nUpdate ${currentTag} → ${newest}?`);

  if (!proceed) {
    console.log('Aborted.');
    return;
  }

  try {
    git(['reset', '--hard', '--quiet']);
    git(['checkout', '--force', '--quiet', newest]);
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Try manually: git -C "${INSTALL_DIR}" reset --hard && git -C "${INSTALL_DIR}" checkout ${newest}`);
    return;
  }

  console.log(`\nUpdated to ${newest}.`);
  console.log('The new version is active on the next clw-auth invocation — no shell reload required.');
}
