import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAuth, oauthRefresh } from './auth.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import {
  debugLog,
  getCronLockPath,
  getCronLogPath,
  getDebugLogPath,
  getEnsureFreshLockPath,
} from './store.mjs';

const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const NODE_PATH = process.execPath;

const CRON_SCHEDULE = '0 */6 * * *';
const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CRON_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const CRON_STALE_THRESHOLD_MS = CRON_INTERVAL_MS + (60 * 60 * 1000);

// On-demand refresh window: the smallest safety margin we want before a
// caller hits the network with a stale token. Independent from the much
// larger cron-side window so cron still bulk-refreshes proactively while
// ensure-fresh stays cheap on the hot path.
const ENSURE_FRESH_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const ENSURE_FRESH_LOCK_TTL_MS = 30 * 1000;
const ENSURE_FRESH_WAIT_TIMEOUT_MS = 30 * 1000;
const ENSURE_FRESH_WAIT_INTERVAL_MS = 250;

// Cron-side refresh window: must cover at least one full cron interval so
// tokens never expire between scheduled ticks.
const CRON_REFRESH_WINDOW_MS = CRON_INTERVAL_MS;
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

/**
 * Decide what ensure-fresh should do for the given auth payload.
 * Pure function — no IO, no clock injection beyond `now` parameter for tests.
 *
 * Returned `action`:
 *   - `'fresh'`           OAuth token is valid beyond the safety window.
 *   - `'refresh'`         OAuth token expires within the safety window.
 *   - `'skip-api-key'`    Auth uses an API key (never expires).
 *   - `'skip-not-configured'` No auth configured yet.
 *   - `'error'`           OAuth payload is malformed (missing expires/refresh).
 */
export function decideRefreshAction(
  auth,
  refreshWindowMs = ENSURE_FRESH_REFRESH_WINDOW_MS,
  now = Date.now(),
) {
  if (!isObject(auth) || typeof auth.type !== 'string') {
    return { action: 'skip-not-configured' };
  }

  if (auth.type === 'api') {
    return { action: 'skip-api-key' };
  }

  if (auth.type !== 'oauth') {
    return { action: 'skip-not-configured' };
  }

  const expires = Number(auth.expires);

  if (!Number.isFinite(expires)) {
    return { action: 'error', reason: 'oauth-missing-expires' };
  }

  if (typeof auth.refresh !== 'string' || !auth.refresh.trim()) {
    return { action: 'error', reason: 'oauth-missing-refresh' };
  }

  if (expires <= (now + refreshWindowMs)) {
    return { action: 'refresh', expires };
  }

  return { action: 'fresh', expires };
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Acquire a generic file lock with a TTL and a bounded wait. Used by
 * ensure-fresh so concurrent callers serialize their refresh attempts and
 * Anthropic does not invalidate refresh tokens via parallel rotations.
 *
 * Returns `{ acquired: true, mode: 'fresh'|'recovered-stale' }` on success,
 * or `{ acquired: false, mode: 'wait-timeout'|'write-failed' }` on failure.
 */
export async function acquireFileLockWithRetry(lockPath, options = {}) {
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : ENSURE_FRESH_LOCK_TTL_MS;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : ENSURE_FRESH_WAIT_TIMEOUT_MS;
  const interval = Number.isFinite(options.intervalMs) ? options.intervalMs : ENSURE_FRESH_WAIT_INTERVAL_MS;
  const deadline = Date.now() + Math.max(timeout, 0);

  while (true) {
    try {
      writeFileSync(lockPath, `${Date.now()}`, { flag: 'wx', mode: 0o600 });
      return { acquired: true, mode: 'fresh' };
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') {
        return { acquired: false, mode: 'write-failed', error: getErrorMessage(error) };
      }
    }

    let staleCleared = false;
    try {
      const raw = readFileSync(lockPath, 'utf8').trim();
      const ts = Number.parseInt(raw, 10);

      if (Number.isFinite(ts) && ts < (Date.now() - ttl)) {
        try {
          unlinkSync(lockPath);
          staleCleared = true;
        } catch (unlinkError) {
          if (getErrorCode(unlinkError) !== 'ENOENT') {
            return { acquired: false, mode: 'write-failed', error: getErrorMessage(unlinkError) };
          }
          staleCleared = true;
        }
      }
    } catch {
      // Lock disappeared between exists check and read — fall through and retry write.
    }

    if (staleCleared) {
      try {
        writeFileSync(lockPath, `${Date.now()}`, { flag: 'wx', mode: 0o600 });
        return { acquired: true, mode: 'recovered-stale' };
      } catch (retryError) {
        if (getErrorCode(retryError) !== 'EEXIST') {
          return { acquired: false, mode: 'write-failed', error: getErrorMessage(retryError) };
        }
      }
    }

    if (Date.now() >= deadline) {
      return { acquired: false, mode: 'wait-timeout' };
    }

    await sleep(interval);
  }
}

const releaseFileLock = (lockPath) => {
  if (!existsSync(lockPath)) {
    return;
  }

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      debugLog('ensure-fresh-lock-release-failed', {
        error: getErrorMessage(error),
        lockPath,
      });
    }
  }
};

/**
 * On-demand refresh primitive. Intended to be called immediately before any
 * outbound request that depends on `auth.json` / `api-reference.json`.
 *
 * Behaviour:
 *   - If auth uses API key or OAuth token is fresh: returns without IO.
 *   - If OAuth token is within the safety window: acquires a file lock,
 *     re-checks (another caller may have refreshed first), refreshes, and
 *     mirrors the new tokens to all configured exporters.
 *   - Refresh failures are surfaced (caller decides whether to abort the
 *     downstream request); maintenance failures (exporters/api-reference)
 *     are logged but do not throw.
 */
export async function ensureFreshAuth(options = {}) {
  const refreshWindowMs = Number.isFinite(options.refreshWindowMs)
    ? options.refreshWindowMs
    : ENSURE_FRESH_REFRESH_WINDOW_MS;

  const auth = await getAuth();
  const initialDecision = decideRefreshAction(auth, refreshWindowMs);

  if (initialDecision.action === 'skip-api-key') {
    return { status: 'skipped-api-key', refreshed: false, expires: null };
  }

  if (initialDecision.action === 'skip-not-configured') {
    return { status: 'skipped-not-configured', refreshed: false, expires: null };
  }

  if (initialDecision.action === 'error') {
    throw new Error(`ensure-fresh: ${initialDecision.reason}`);
  }

  if (initialDecision.action === 'fresh') {
    return { status: 'fresh', refreshed: false, expires: initialDecision.expires };
  }

  // action === 'refresh': acquire lock, re-check, refresh.
  const lockPath = getEnsureFreshLockPath();
  const lockResult = await acquireFileLockWithRetry(lockPath, {
    ttlMs: ENSURE_FRESH_LOCK_TTL_MS,
    timeoutMs: ENSURE_FRESH_WAIT_TIMEOUT_MS,
    intervalMs: ENSURE_FRESH_WAIT_INTERVAL_MS,
  });

  if (!lockResult.acquired) {
    debugLog('ensure-fresh-lock-unavailable', { lockPath, mode: lockResult.mode });
    throw new Error(`ensure-fresh: could not acquire lock (${lockResult.mode})`);
  }

  debugLog('ensure-fresh-lock-acquired', { lockPath, mode: lockResult.mode });

  try {
    // Re-check after acquiring the lock — a sibling process may have refreshed
    // while we were waiting. Anthropic rotates refresh tokens on every call,
    // so a redundant refresh would invalidate the just-rotated token.
    const refreshedAuth = await getAuth();
    const recheck = decideRefreshAction(refreshedAuth, refreshWindowMs);

    if (recheck.action === 'fresh') {
      debugLog('ensure-fresh-skipped-already-fresh', { expires: recheck.expires });
      return { status: 'fresh-by-other', refreshed: false, expires: recheck.expires };
    }

    if (recheck.action === 'skip-api-key') {
      return { status: 'skipped-api-key', refreshed: false, expires: null };
    }

    if (recheck.action === 'error') {
      throw new Error(`ensure-fresh: ${recheck.reason}`);
    }

    const newAuth = await oauthRefresh({ silent: true });
    debugLog('ensure-fresh-refreshed', { expires: newAuth.expires });

    const exporterActions = [];
    await syncExportersAfterRefresh(exporterActions);

    // Best-effort api-reference regeneration so consumers reading the file
    // immediately after ensure-fresh see the new authorization header.
    try {
      const { generateApiReference } = await loadApiReferenceModule();
      await Promise.resolve(generateApiReference());
      debugLog('ensure-fresh-api-reference-regenerated');
    } catch (error) {
      debugLog('ensure-fresh-api-reference-failed', { error: getErrorMessage(error) });
    }

    return {
      status: 'refreshed',
      refreshed: true,
      expires: newAuth.expires,
      exporterActions,
    };
  } finally {
    releaseFileLock(lockPath);
    debugLog('ensure-fresh-lock-released', { lockPath });
  }
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

    debugLog('cron-run-started');

    // Delegate proactive refresh to the same primitive that on-demand callers
    // use, but with the wider cron window so tokens never expire between
    // scheduled ticks. Refresh failures must not abort the maintenance sweep
    // (drift detection / api-reference regeneration is still valuable).
    try {
      const ensureResult = await ensureFreshAuth({ refreshWindowMs: CRON_REFRESH_WINDOW_MS });

      switch (ensureResult.status) {
        case 'refreshed':
          actions.push('oauth refreshed');
          debugLog('cron-oauth-refreshed');
          if (Array.isArray(ensureResult.exporterActions)) {
            for (const action of ensureResult.exporterActions) {
              actions.push(action);
            }
          }
          break;
        case 'fresh':
        case 'fresh-by-other':
          actions.push('oauth refresh not needed');
          break;
        case 'skipped-api-key':
        case 'skipped-not-configured':
          actions.push('oauth refresh skipped (not in oauth mode)');
          break;
        default:
          actions.push(`oauth refresh status: ${ensureResult.status}`);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      actions.push(`oauth refresh failed (non-fatal): ${message}`);
      debugLog('cron-oauth-refresh-failed', { error: message });
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
