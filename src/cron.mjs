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
const NODE_PATH = process.execPath;

const CRON_SCHEDULE = '0 */6 * * *';
const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CRON_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const CRON_STALE_THRESHOLD_MS = CRON_INTERVAL_MS + (60 * 60 * 1000);
const CRON_LOG_ERROR_PATTERNS = [
  /\/bin\/sh: .*command not found/i,
  /^error:/i,
  /oauth token request failed/i,
  /failed to /i,
  /permission denied/i,
  /exception/i,
  /traceback/i,
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const getErrorCode = (error) => (isObject(error) && typeof error.code === 'string' ? error.code : '');

const getErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const getTimestampMs = (entry) => {
  const timestamp = typeof entry?.ts === 'string' ? Date.parse(entry.ts) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
};

const loadUpstreamModule = () => import(new URL('./upstream.mjs', import.meta.url).href);

const loadApiReferenceModule = () => import(new URL('./api-reference.mjs', import.meta.url).href);

export function buildCronLine(cliPath = CLI_PATH, logPath = getCronLogPath(), nodePath = NODE_PATH) {
  return `${CRON_SCHEDULE} "${nodePath}" "${cliPath}" cron-run >> "${logPath}" 2>&1`;
}

export function getLatestCronRunRecord(logContents) {
  if (typeof logContents !== 'string' || !logContents.trim()) {
    return null;
  }

  let latestEntry = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const line of logContents.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const entry = parseJsonLine(line);

    if (!entry || (entry.event !== 'cron-run-completed' && entry.event !== 'cron-run-failed')) {
      continue;
    }

    const timestamp = getTimestampMs(entry);

    if (!Number.isFinite(timestamp) || timestamp < latestTimestamp) {
      continue;
    }

    latestEntry = entry;
    latestTimestamp = timestamp;
  }

  return latestEntry;
}

export function getRecentCronLogIssue(logContents) {
  if (typeof logContents !== 'string' || !logContents.trim()) {
    return null;
  }

  const lines = logContents.split('\n').filter(Boolean);
  const lastSuccessIndex = lines.lastIndexOf('Cron maintenance summary:');
  const relevantLines = lastSuccessIndex >= 0 ? lines.slice(lastSuccessIndex) : lines;

  for (const line of [...relevantLines].reverse()) {
    if (CRON_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.trim();
    }
  }

  return null;
}

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

  if (typeof upstreamConfig.ccVersion === 'string' && /^\d+\.\d+\.\d+$/.test(upstreamConfig.ccVersion.trim())) {
    nextConfig.ccVersion = upstreamConfig.ccVersion.trim();
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

    if (EXPORTERS.has('opencode')) {
      await runExporter('opencode');
      actions.push('opencode credentials synced after token rotation');
      debugLog('cron-exporter-synced', { exporter: 'opencode' });
    }

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
      detectLocalCcVersion,
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

    // Detect CC version from local `claude --version` to keep the billing fingerprint accurate.
    // This runs on every cron tick so any Claude Code update is automatically picked up.
    const localCcVersion = detectLocalCcVersion();
    const storedCcVersion = persistedConfig.ccVersion;

    if (localCcVersion) {
      if (!storedCcVersion || compareVersions(localCcVersion, storedCcVersion) !== 0) {
        upstream.config = saveConfig({ ...upstream.config, ccVersion: localCcVersion });
        actions.push(`cc-version updated: ${storedCcVersion ?? 'none'} → ${localCcVersion}`);
        debugLog('cron-cc-version-updated', {
          previous: storedCcVersion ?? null,
          current: localCcVersion,
        });
      } else {
        actions.push(`cc-version up to date: ${localCcVersion}`);
      }
    } else {
      actions.push('cc-version detection skipped (claude not found in PATH)');
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
  const cronLine = buildCronLine(CLI_PATH, logPath);

  let current = '';
  try {
    current = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch { /* no existing crontab */ }

  const existingEntry = current.split('\n').find((l) => l.includes('clw-auth') && !l.trim().startsWith('#'));

  if (existingEntry?.trim() === cronLine) {
    console.log('Cron entry already installed. No changes made.');
    console.log(`Entry: ${existingEntry.trim()}`);
    return;
  }

  const retainedLines = current
    .split('\n')
    .filter((line) => !(line.includes('clw-auth') && !line.trim().startsWith('#')));
  const next = `${retainedLines.join('\n').trimEnd()}\n${cronLine}\n`.trimStart();
  const result = spawnSync('crontab', ['-'], { input: next, stdio: ['pipe', 'inherit', 'inherit'] });

  if (result.status !== 0) {
    throw new Error('Failed to install cron entry. Check crontab access.');
  }

  console.log(existingEntry ? 'Cron entry updated.' : 'Cron entry installed.');
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
  let latestRun = null;

  if (existsSync(debugLogPath)) {
    latestRun = getLatestCronRunRecord(readFileSync(debugLogPath, 'utf8'));

    if (latestRun?.event === 'cron-run-completed') {
      console.log(`Last run:  ${latestRun.ts} (ok)`);
      if (Array.isArray(latestRun.details?.actions)) {
        for (const action of latestRun.details.actions) {
          console.log(`           - ${action}`);
        }
      }
    } else if (latestRun?.event === 'cron-run-failed') {
      console.log(`Last run:  ${latestRun.ts} (failed)`);
      if (latestRun.details?.error) {
        console.log(`           Error: ${latestRun.details.error}`);
      }
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

  const healthNotes = [];

  if (cronEntry && !cronEntry.includes(`"${NODE_PATH}"`)) {
    healthNotes.push(`installed cron entry is not pinned to the current Node executable (${NODE_PATH})`);
  }

  const latestRunTimestamp = getTimestampMs(latestRun);
  if (Number.isFinite(latestRunTimestamp) && latestRunTimestamp < (Date.now() - CRON_STALE_THRESHOLD_MS)) {
    healthNotes.push('last recorded cron run is older than 7 hours');
  }

  if (existsSync(logPath)) {
    const recentIssue = getRecentCronLogIssue(readFileSync(logPath, 'utf8'));
    if (recentIssue) {
      healthNotes.push(`recent cron log issue: ${recentIssue}`);
    }
  }

  if (existsSync(logPath)) {
    const { size } = statSync(logPath);
    console.log(`Log size:  ${(size / 1024).toFixed(1)} KB`);
  } else {
    console.log('Log size:  not created yet');
  }

  if (healthNotes.length > 0) {
    console.log('');
    console.log('Health:    degraded');
    for (const note of healthNotes) {
      console.log(`           - ${note}`);
    }
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
