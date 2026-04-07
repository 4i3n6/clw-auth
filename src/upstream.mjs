import { loadConfig } from './config.mjs';

const FETCH_TIMEOUT_MS = 15_000;
const MONITOR_USER_AGENT = 'clw-auth/1.0';
const DEFAULT_USER_AGENT = 'claude-cli/%VERSION% (external, cli)';
const GA_HINT_PATTERN = /(generally available|no longer required)/i;

export const UPSTREAM_SOURCES = Object.freeze([
  'https://platform.claude.com/docs/en/api/beta-headers',
  'https://platform.claude.com/docs/en/release-notes/overview',
  'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md',
]);

const SOURCE_URLS = Object.freeze({
  betaHeaders: UPSTREAM_SOURCES[0],
  apiReleaseNotes: UPSTREAM_SOURCES[1],
  claudeCodeReleaseNotes: UPSTREAM_SOURCES[2],
});

export async function fetchText(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': MONITOR_USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out fetching ${url} after ${FETCH_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function stripHtml(text) {
  const normalizedText = typeof text === 'string' ? text : String(text ?? '');

  return normalizedText
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLatestClaudeCliVersion(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const patterns = [
    /##\s+(\d+\.\d+\.\d+)\b/g,
    /(?:^|\s)(\d+\.\d+\.\d+)\s*-\s+/gm,
    /claude-cli\/(\d+\.\d+\.\d+)/gi,
  ];

  let latestVersion = null;

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const version = match[1] ?? null;
      if (!version) {
        continue;
      }

      if (!latestVersion || compareVersions(version, latestVersion) > 0) {
        latestVersion = version;
      }
    }
  }

  return latestVersion;
}

export function extractUserAgentVersion(userAgent) {
  if (typeof userAgent !== 'string') {
    return null;
  }

  const match = userAgent.match(/claude-cli\/(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

export function compareVersions(left, right) {
  const leftParts = String(left)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const rightParts = String(right)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

export function analyzeBetaHeaders(config, betaHeadersText, apiReleaseNotesText) {
  const betaHeaders = Array.isArray(config?.betaHeaders)
    ? config.betaHeaders
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];

  return betaHeaders.map((header) => {
    const featureName = header.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const exactPattern = new RegExp(`(^|[^\\w-])${escapeRegExp(header)}(?=$|[^\\w-])`, 'i');
    const featurePattern = new RegExp(`(^|[^\\w-])${escapeRegExp(featureName)}(?=$|[^\\w-])`, 'i');
    const inBetaDocs = exactPattern.test(betaHeadersText);
    const inApiNotes = exactPattern.test(apiReleaseNotesText);
    const featureMention = featurePattern.test(apiReleaseNotesText);
    const betaSnippet = getSnippet(betaHeadersText, header);
    const apiSnippet = getSnippet(apiReleaseNotesText, header)
      ?? (featureName !== header ? getSnippet(apiReleaseNotesText, featureName) : null);
    const gaHint = Boolean(apiSnippet && GA_HINT_PATTERN.test(apiSnippet));

    return {
      header,
      inBetaDocs,
      inApiNotes,
      featureMention,
      gaHint,
      betaSnippet,
      apiSnippet,
    };
  });
}

export async function collectUpstreamData() {
  const config = loadConfig();
  const [betaHeadersHtml, apiReleaseNotesHtml, claudeCodeHtml] = await Promise.all([
    fetchText(SOURCE_URLS.betaHeaders),
    fetchText(SOURCE_URLS.apiReleaseNotes),
    fetchText(SOURCE_URLS.claudeCodeReleaseNotes),
  ]);

  const betaHeadersText = stripHtml(betaHeadersHtml);
  const apiReleaseNotesText = stripHtml(apiReleaseNotesHtml);
  const claudeCodeText = stripHtml(claudeCodeHtml);

  return {
    config,
    latestClaudeVersion: extractLatestClaudeCliVersion(claudeCodeText),
    betaHeaderResults: analyzeBetaHeaders(config, betaHeadersText, apiReleaseNotesText),
  };
}

export function buildUpdatedUserAgent(currentUserAgent, latestVersion) {
  if (!latestVersion) {
    return typeof currentUserAgent === 'string' ? currentUserAgent : '';
  }

  if (typeof currentUserAgent === 'string' && /claude-cli\/\d+\.\d+\.\d+/i.test(currentUserAgent)) {
    return currentUserAgent.replace(/claude-cli\/\d+\.\d+\.\d+/i, `claude-cli/${latestVersion}`);
  }

  return DEFAULT_USER_AGENT.replace('%VERSION%', latestVersion);
}

export async function printUpstreamCheck() {
  const upstream = await collectUpstreamData();

  printUserAgentAnalysis(upstream.config, upstream.latestClaudeVersion);
  console.log('');
  printBetaHeaderAnalysis(upstream.betaHeaderResults);
}

export function printSources() {
  console.log('Monitored upstream sources:');
  for (const source of UPSTREAM_SOURCES) {
    console.log(`- ${source}`);
  }
}

function printUserAgentAnalysis(config, latestClaudeVersion) {
  const currentVersion = extractUserAgentVersion(config?.userAgent);

  console.log('User-Agent drift:');
  console.log(`- configured: ${config?.userAgent ?? '(missing)'}`);
  console.log(`- latest Claude Code release seen: ${latestClaudeVersion ?? 'not detected'}`);

  if (!currentVersion || !latestClaudeVersion) {
    console.log('- status: manual review needed (could not compare versions)');
    return;
  }

  const comparison = compareVersions(currentVersion, latestClaudeVersion);

  if (comparison < 0) {
    console.log(`- status: stale (local ${currentVersion} < upstream ${latestClaudeVersion})`);
    console.log(`- suggested update: ${buildUpdatedUserAgent(config.userAgent, latestClaudeVersion)}`);
    return;
  }

  if (comparison === 0) {
    console.log('- status: aligned with latest detected Claude Code version');
    return;
  }

  console.log(`- status: ahead of detected upstream version (local ${currentVersion})`);
}

function printBetaHeaderAnalysis(results) {
  console.log('Beta header drift:');

  if (!Array.isArray(results) || results.length === 0) {
    console.log('- no beta headers configured');
    return;
  }

  for (const result of results) {
    const status = result.inBetaDocs
      ? 'documented'
      : result.inApiNotes || result.featureMention
        ? 'mentioned outside beta doc'
        : 'not found';

    console.log(`- ${result.header}: ${status}`);

    if (result.gaHint) {
      console.log('  note: release notes suggest the beta may be generally available or no longer required');
    }

    if (result.betaSnippet) {
      console.log(`  beta-docs: ${result.betaSnippet}`);
    }

    if (result.apiSnippet) {
      console.log(`  api-notes: ${result.apiSnippet}`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSnippet(text, term, radius = 140) {
  if (typeof text !== 'string' || typeof term !== 'string' || !term) {
    return null;
  }

  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const lowerText = normalizedText.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const index = lowerText.indexOf(lowerTerm);

  if (index === -1) {
    return null;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(normalizedText.length, index + term.length + radius);

  return normalizedText.slice(start, end).trim();
}
