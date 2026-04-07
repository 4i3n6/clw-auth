import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAuth, oauthRefresh, shouldRefreshOauth } from './auth.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { debugLog, getCronLockPath, getCronLogPath, getDebugLogPath } from './store.mjs';

const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));

const CRON_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const getErrorCode = (error) => (isObject(error) && typeof error.code === 'string' ? error.code : '');

const getErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

const loadUpstreamModule = () => import(new URL('./upstream.mjs', import.meta.url).href);

const loadApiReferenceModule = () => import(new URL('./api-reference.mjs', import.meta.url).href);

const readCronLockTimestamp = (lockPath) => {
  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const rawTimestamp = readFileSync(lockPath, 'utf8').trim();
    const timestamp = Number.parseInt(rawTimestamp, 10);

    return Number.isFinite(timestamp) ? timestamp : null;
  } catch (error) {
    debugLog('cron-lock-read-failed', {
      error: getErrorMessage(error),
      lockPath,
    });

    return null;
  }
};

const tryWriteCronLock = (lockPath) => {
  try {
    writeFileSync(lockPath, `${Date.now()}`, {
      flag: 'wx',
      mode: 0o600,
    });

    return null;
  } catch (error) {
    return error;
  }
};

const resolveRuntimeConfig = (persistedConfig, upstreamConfig) => {
  if (!isObject(upstreamConfig)) {
    return persistedConfig;
  }

  const nextConfig = {
    ...persistedConfig,
  };

  if (typeof upstreamConfig.schemaVersion === 'number') {
    nextConfig.schemaVersion = upstreamConfig.schemaVersion;
  }

  if (Array.isArray(upstreamConfig.betaHeaders)) {
    nextConfig.betaHeaders = upstreamConfig.betaHeaders
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (typeof upstreamConfig.userAgent === 'string' && upstreamConfig.userAgent.trim()) {
    nextConfig.userAgent = upstreamConfig.userAgent.trim();
  }

  return nextConfig;
};

const printSummary = (actions) => {
  console.log('Cron maintenance summary:');

  for (const action of actions) {
    console.log(`- ${action}`);
  }
};

const printBetaHeaderDrift = (betaHeaderResults) => {
  console.log('Beta header drift (report only):');

  if (!Array.isArray(betaHeaderResults) || betaHeaderResults.length === 0) {
    console.log('- no beta headers configured');
    return;
  }

  for (const result of betaHeaderResults) {
    const header = typeof result?.header === 'string' && result.header.trim()
      ? result.header.trim()
      : '(unknown)';
    const status = result?.inBetaDocs
      ? 'documented'
      : result?.inApiNotes || result?.featureMention
        ? 'mentioned outside beta doc'
        : 'not found';

    console.log(`- ${header}: ${status}`);

    if (result?.gaHint) {
      console.log('  note: release notes mention GA/transition wording; verify whether this beta is still required');
    }

    if (typeof result?.betaSnippet === 'string' && result.betaSnippet) {
      console.log(`  beta-docs: ${result.betaSnippet}`);
    } else if (typeof result?.apiSnippet === 'string' && result.apiSnippet) {
      console.log(`  api-notes: ${result.apiSnippet}`);
    }
  }
};

export function acquireCronLock() {
  const lockPath = getCronLockPath();
  const initialWriteError = tryWriteCronLock(lockPath);

  if (!initialWriteError) {
    debugLog('cron-lock-acquired', { lockPath });
    return true;
  }

  if (getErrorCode(initialWriteError) !== 'EEXIST') {
    debugLog('cron-lock-write-failed', {
      error: getErrorMessage(initialWriteError),
      lockPath,
    });
    return false;
  }

  const existingTimestamp = readCronLockTimestamp(lockPath);

  if (existingTimestamp !== null && existingTimestamp < (Date.now() - CRON_LOCK_TTL_MS)) {
    try {
      unlinkSync(lockPath);
      debugLog('cron-lock-stale-removed', {
        existingTimestamp,
        lockPath,
      });
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        debugLog('cron-lock-stale-remove-failed', {
          error: getErrorMessage(error),
          lockPath,
        });
        return false;
      }
    }

    const retryWriteError = tryWriteCronLock(lockPath);

    if (!retryWriteError) {
      debugLog('cron-lock-acquired', {
        lockPath,
        recoveredStaleLock: true,
      });
      return true;
    }

    debugLog('cron-lock-retry-failed', {
      error: getErrorMessage(retryWriteError),
      lockPath,
    });
    return false;
  }

  debugLog('cron-lock-busy', {
    existingTimestamp,
    lockPath,
  });

  return false;
}

export function releaseCronLock() {
  const lockPath = getCronLockPath();

  if (!existsSync(lockPath)) {
    return;
  }

  try {
    unlinkSync(lockPath);
    debugLog('cron-lock-released', { lockPath });
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      debugLog('cron-lock-release-failed', {
        error: getErrorMessage(error),
        lockPath,
      });
    }
  }
}

async function syncExportersAfterRefresh(actions) {
  try {
    const { runExporter, EXPORTERS } = await import('./exporters/index.mjs');

    // OpenClaw: sync all agents that already have an anthropic profile.
    if (EXPORTERS.has('openclaw')) {
      await runExporter('openclaw', { allConfigured: true });
      actions.push('openclaw credentials synced after token rotation');
      debugLog('cron-exporter-synced', { exporter: 'openclaw' });
    }
  } catch (error) {
    // Never let sync failures break the cron run.
    const msg = error instanceof Error ? error.message : String(error);
    actions.push(`exporter sync failed (non-fatal): ${msg}`);
    debugLog('cron-exporter-sync-failed', { error: msg });
  }
}

export async function runCron() {
  if (!acquireCronLock()) {
    console.log('Cron maintenance skipped: another instance is active');
    debugLog('cron-run-skipped', { reason: 'active-lock' });
    return;
  }

  try {
    const [{ generateApiReference }, upstreamModule] = await Promise.all([
      loadApiReferenceModule(),
      loadUpstreamModule(),
    ]);
    const {
      buildUpdatedUserAgent,
      collectUpstreamData,
      compareVersions,
      extractUserAgentVersion,
      printSources,
    } = upstreamModule;
    const actions = [];
    const auth = await getAuth();

    debugLog('cron-run-started');

    if (shouldRefreshOauth(auth)) {
      await oauthRefresh();
      actions.push('oauth refreshed');
      debugLog('cron-oauth-refreshed');

      // Anthropic rotates refresh tokens on every renewal.
      // Any exporter that stored the old refresh token (e.g. OpenClaw auth-profiles.json)
      // would become unable to refresh on its own. Sync all configured exporters
      // silently so every store has the new tokens immediately.
      await syncExportersAfterRefresh(actions);
    } else if (auth?.type === 'oauth') {
      actions.push('oauth refresh not needed');
    } else {
      actions.push('oauth refresh skipped (not in oauth mode)');
    }

    const persistedConfig = loadConfig();
    const upstream = await collectUpstreamData();

    actions.push('upstream data collected');

    upstream.config = resolveRuntimeConfig(persistedConfig, upstream?.config);

    const currentUserAgentVersion = extractUserAgentVersion(upstream.config.userAgent);
    const latestClaudeVersion = typeof upstream?.latestClaudeVersion === 'string' && upstream.latestClaudeVersion.trim()
      ? upstream.latestClaudeVersion.trim()
      : '';

    if (currentUserAgentVersion && latestClaudeVersion) {
      const versionComparison = compareVersions(currentUserAgentVersion, latestClaudeVersion);

      if (versionComparison < 0) {
        const nextUserAgent = buildUpdatedUserAgent(upstream.config.userAgent, latestClaudeVersion);

        if (nextUserAgent !== upstream.config.userAgent) {
          upstream.config = saveConfig({
            ...upstream.config,
            userAgent: nextUserAgent,
          });
          actions.push(`user-agent updated to ${upstream.config.userAgent}`);
          debugLog('cron-user-agent-updated', {
            latestClaudeVersion,
            previousUserAgent: persistedConfig.userAgent,
            userAgent: upstream.config.userAgent,
          });
        } else {
          actions.push('user-agent already aligned');
        }
      } else if (versionComparison === 0) {
        actions.push('user-agent already aligned');
      } else {
        actions.push(`user-agent ahead of detected upstream version (${currentUserAgentVersion})`);
      }
    } else if (!latestClaudeVersion) {
      actions.push('user-agent unchanged (latest upstream version not detected)');
    } else {
      actions.push('user-agent unchanged (current version could not be detected)');
    }

    const apiReferenceResult = await Promise.resolve(generateApiReference());

    actions.push(
      typeof apiReferenceResult === 'string' && apiReferenceResult.trim()
        ? `api-reference regenerated: ${apiReferenceResult.trim()}`
        : 'api-reference regenerated',
    );
    debugLog('cron-api-reference-regenerated');

    printSummary(actions);
    console.log('');
    printSources();
    console.log('');
    printBetaHeaderDrift(upstream?.betaHeaderResults);

    debugLog('cron-run-completed', { actions });
  } catch (error) {
    debugLog('cron-run-failed', { error: getErrorMessage(error) });
    throw error;
  } finally {
    releaseCronLock();
  }
}

export function installCron() {
  const logPath = getCronLogPath();
  const cronLine = `0 */6 * * * node "${CLI_PATH}" cron-run >> "${logPath}" 2>&1`;

  let current = '';
  try {
    current = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch { /* no existing crontab */ }

  const existingEntry = current.split('\n').find((l) => l.includes('clw-auth') && !l.trim().startsWith('#'));

  if (existingEntry) {
    console.log('Cron entry already installed. No changes made.');
    console.log(`Entry: ${existingEntry.trim()}`);
    return;
  }

  const next = `${current.trimEnd()}\n${cronLine}\n`.trimStart();
  const result = spawnSync('crontab', ['-'], { input: next, stdio: ['pipe', 'inherit', 'inherit'] });

  if (result.status !== 0) {
    throw new Error('Failed to install cron entry. Check crontab access.');
  }

  console.log('Cron entry installed.');
  console.log(`Entry:  ${cronLine}`);
  console.log(`Logs:   ${logPath}`);
}

export function printCronStatus() {
  let cronEntry = null;
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    cronEntry = crontab.split('\n').find((l) => l.includes('clw-auth') && !l.trim().startsWith('#')) || null;
  } catch { /* no crontab */ }

  console.log(`Installed: ${cronEntry ? 'yes' : 'no'}`);

  if (cronEntry) {
    console.log(`Entry:     ${cronEntry.trim()}`);
  } else {
    console.log('Install:   clw-auth cron-install');
  }

  console.log('');

  const debugLogPath = getDebugLogPath();

  if (existsSync(debugLogPath)) {
    const lines = readFileSync(debugLogPath, 'utf8').split('\n').filter(Boolean);

    const findLast = (event) => [...lines].reverse().find((l) => {
      try { return JSON.parse(l).event === event; } catch { return false; }
    });

    const lastOk   = findLast('cron-run-completed');
    const lastFail = findLast('cron-run-failed');

    if (lastOk) {
      try {
        const entry = JSON.parse(lastOk);
        console.log(`Last run:  ${entry.ts} (ok)`);
        if (Array.isArray(entry.details?.actions)) {
          for (const action of entry.details.actions) console.log(`           - ${action}`);
        }
      } catch { /* ignore */ }
    } else if (lastFail) {
      try {
        const entry = JSON.parse(lastFail);
        console.log(`Last run:  ${entry.ts} (failed)`);
        if (entry.details?.error) console.log(`           Error: ${entry.details.error}`);
      } catch { /* ignore */ }
    } else {
      console.log('Last run:  not found in debug log.');
    }
  } else {
    console.log('Last run:  no debug log found yet.');
  }

  console.log('');

  const lockPath = getCronLockPath();
  if (existsSync(lockPath)) {
    const ts = readCronLockTimestamp(lockPath);
    const stale = ts !== null && ts < (Date.now() - CRON_LOCK_TTL_MS);
    console.log(`Lock:      ${stale ? 'stale (cleared on next run)' : 'active — cron is running'}`);
  }

  const logPath = getCronLogPath();
  console.log(`Log:       ${logPath}`);

  if (existsSync(logPath)) {
    const { size } = statSync(logPath);
    console.log(`Log size:  ${(size / 1024).toFixed(1)} KB`);
  } else {
    console.log('Log size:  not created yet');
  }
}

export function printCronLogs(tailLines = 50) {
  const logPath = getCronLogPath();

  if (!existsSync(logPath)) {
    console.log(`No cron log at ${logPath}`);
    console.log('The log is created after the first cron run.');
    console.log('Trigger manually: clw-auth cron-run');
    return;
  }

  const all = readFileSync(logPath, 'utf8').split('\n');
  const n   = Math.min(tailLines, all.length);
  const out = all.slice(-n).join('\n').trim();

  if (!out) {
    console.log('Log file is empty.');
    return;
  }

  console.log(`=== ${logPath} (last ${n} lines) ===\n`);
  console.log(out);
}
