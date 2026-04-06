import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import { getAuth, oauthRefresh, shouldRefreshOauth } from './auth.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { debugLog, getCronLockPath } from './store.mjs';

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
