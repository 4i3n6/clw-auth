#!/usr/bin/env node

import { createRequire } from 'node:module';

const BIN_NAME = 'clw-auth';
const PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version;

const loadAuthModule = () => import('./auth.mjs');
const loadConfigModule = () => import('./config.mjs');
const loadApiReferenceModule = () => import('./api-reference.mjs');
const loadUpstreamModule = () => import('./upstream.mjs');
const loadCronModule = () => import('./cron.mjs');
const loadExportersModule = () => import('./exporters/index.mjs');
const loadStoreModule = () => import('./store.mjs');
const loadUpdateModule = () => import('./update.mjs');
const loadVersionModule = () => import('./version.mjs');

const COMMAND_GROUPS = [
  {
    title: 'Setup',
    commands: [
      {
        usage: 'tui',
        summary: 'Interactive wizard: authenticate and export to OpenCode or OpenClaw.',
      },
      {
        usage: 'update [--check|--yes]',
        summary: 'Update to the latest release. --check probes only; --yes skips confirmation.',
      },
    ],
  },
  {
    title: 'Core',
    commands: [
      {
        usage: 'oauth-url',
        summary: 'Generate the Claude OAuth URL.',
      },
      {
        usage: 'oauth-exchange <input>',
        summary: 'Exchange code#state or callback URL and update api-reference.json.',
      },
      {
        usage: 'oauth-refresh | refresh',
        summary: 'Refresh stored OAuth credentials and update api-reference.json.',
      },
      {
        usage: 'status',
        summary: 'Show current Anthropic auth status.',
      },
      {
        usage: 'doctor',
        summary: 'Show status, api reference, config, and sources.',
      },
      {
        usage: 'api <key>',
        summary: 'Store an Anthropic API key and update api-reference.json.',
      },
    ],
  },
  {
    title: 'API reference',
    commands: [
      {
        usage: 'api-ref',
        summary: 'Print the persisted api-reference.json payload.',
      },
      {
        usage: 'api-ref-update',
        summary: 'Regenerate api-reference.json.',
      },
    ],
  },
  {
    title: 'Config',
    commands: [
      {
        usage: 'config',
        summary: 'Print runtime config.',
      },
      {
        usage: 'set-betas <csv>',
        summary: 'Set anthropic-beta headers using CSV or "none".',
      },
      {
        usage: 'set-user-agent <ua>',
        summary: 'Set the runtime User-Agent string.',
      },
      {
        usage: 'set-cc-version <version>',
        summary: 'Override the Claude Code version used in the billing fingerprint.',
      },
      {
        usage: 'config-reset',
        summary: 'Reset runtime config to defaults.',
      },
    ],
  },
  {
    title: 'Upstream',
    commands: [
      {
        usage: 'upstream-check',
        summary: 'Compare local config with monitored upstream sources.',
      },
      {
        usage: 'sources',
        summary: 'Print monitored upstream source URLs.',
      },
    ],
  },
  {
    title: 'Export',
    commands: [
      {
        usage: 'export',
        summary: 'List available exporters.',
      },
      {
        usage: 'export <system>',
        summary: 'Run a registered exporter.',
      },
    ],
  },
  {
    title: 'Maintenance',
    commands: [
      {
        usage: 'ensure-fresh',
        summary: 'Refresh OAuth on demand if it expires within 5 minutes (no-op otherwise).',
      },
      {
        usage: 'cron-install',
        summary: 'Install cron job for automatic OAuth token renewal.',
      },
      {
        usage: 'cron-status',
        summary: 'Show cron installation state and last run summary.',
      },
      {
        usage: 'cron-logs [n]',
        summary: 'Print last N lines of the cron execution log (default: 50).',
      },
      {
        usage: 'cron-run',
        summary: 'Run scheduled maintenance tasks manually.',
      },
    ],
  },
  {
    title: 'Troubleshooting',
    commands: [
      {
        usage: 'chattest',
        summary: 'Open the connectivity TUI for Anthropic chat streaming tests.',
      },
    ],
  },
  {
    title: 'Help',
    commands: [
      {
        usage: 'version [--json]',
        summary: 'Print version, git commit, runtime, and install/data paths.',
      },
      {
        usage: 'help [command]',
        summary: 'Show grouped help or help for a specific command.',
      },
    ],
  },
];

const COMMAND_HELP = new Map([
  [
    '--version',
    {
      usage: '--version',
      description: 'Print the installed version (short form). For richer metadata use `clw-auth version`.',
      examples: ['clw-auth --version'],
    },
  ],
  [
    'version',
    {
      usage: 'version [--json]',
      description: 'Print version metadata: package version, git commit and tag (when the install is git-managed), commit timestamp, Node.js version, platform/architecture, install directory, and data directory. Use --json to emit a stable machine-readable object suitable for shell scripts and CI.',
      examples: ['clw-auth version', 'clw-auth version --json'],
    },
  ],
  [
    'tui',
    {
      usage: 'tui',
      description: 'Launch the interactive TUI setup wizard. Guides through tool selection (OpenCode / OpenClaw / Both), authentication (OAuth or API key), and credential export. Alias: auth-setup.',
      examples: ['clw-auth tui'],
    },
  ],
  [
    'update',
    {
      usage: 'update [--check|-n] [--yes|-y]',
      description: 'Fetch the latest release tag from GitHub and update the installation in place. Requires a git-managed installation (default when installed via install.sh). No shell reload required after update. Use --check for a read-only probe (exit code 10 means an update is available, 0 means up to date, 2 means error). Use --yes to skip the confirmation prompt — required when stdin is not a TTY. When multiple releases are pending, prints the full update path (e.g. v0.9.1 → v0.9.2 → v0.9.3) so the operator sees what is being applied.',
      examples: [
        'clw-auth update',
        'clw-auth update --check',
        'clw-auth update --yes',
      ],
    },
  ],
  [
    'oauth-url',
    {
      usage: 'oauth-url',
      description: 'Generate the browser login URL for Claude OAuth.',
      examples: ['clw-auth oauth-url'],
    },
  ],
  [
    'oauth-exchange',
    {
      usage: 'oauth-exchange <code#state|callback-url>',
      description: 'Exchange the browser callback payload for OAuth credentials and regenerate api-reference.json.',
      examples: [
        'clw-auth oauth-exchange "code#state"',
        'clw-auth oauth-exchange "https://platform.claude.com/oauth/code/callback?code=...#state=..."',
      ],
    },
  ],
  [
    'oauth-refresh',
    {
      usage: 'oauth-refresh',
      description: 'Refresh stored OAuth credentials immediately and regenerate api-reference.json.',
      aliases: ['refresh'],
      examples: ['clw-auth oauth-refresh', 'clw-auth refresh'],
    },
  ],
  [
    'status',
    {
      usage: 'status',
      description: 'Print the current Anthropic auth mode, token presence, and expiry details.',
      examples: ['clw-auth status'],
    },
  ],
  [
    'doctor',
    {
      usage: 'doctor',
      description: 'Run status, api-ref, config, and sources in one grouped report.',
      examples: ['clw-auth doctor'],
    },
  ],
  [
    'api',
    {
      usage: 'api <anthropic-api-key>',
      description: 'Store an Anthropic API key and regenerate api-reference.json.',
      examples: ['clw-auth api "$ANTHROPIC_API_KEY"'],
    },
  ],
  [
    'api-ref',
    {
      usage: 'api-ref',
      description: 'Print the persisted api-reference.json payload.',
      examples: ['clw-auth api-ref'],
    },
  ],
  [
    'api-ref-update',
    {
      usage: 'api-ref-update',
      description: 'Regenerate api-reference.json from the current auth and config state.',
      examples: ['clw-auth api-ref-update'],
    },
  ],
  [
    'config',
    {
      usage: 'config',
      description: 'Print the persisted runtime config.',
      examples: ['clw-auth config'],
    },
  ],
  [
    'set-betas',
    {
      usage: 'set-betas <csv|none>',
      description: 'Update anthropic-beta headers in runtime config.',
      examples: [
        'clw-auth set-betas "interleaved-thinking-2025-05-14"',
        'clw-auth set-betas none',
      ],
    },
  ],
  [
    'set-user-agent',
    {
      usage: 'set-user-agent <ua|default>',
      description: 'Update the runtime User-Agent string or restore the default value.',
      examples: [
        'clw-auth set-user-agent "claude-cli/2.1.81 (external, cli)"',
        'clw-auth set-user-agent default',
      ],
    },
  ],
  [
    'set-cc-version',
    {
      usage: 'set-cc-version <version>',
      description: 'Manually set the Claude Code version used to compute the billing fingerprint injected into every request. Auto-updated by cron via `claude --version`. Use this when the cron cannot run (e.g. claude not in PATH in cron context).',
      examples: [
        'clw-auth set-cc-version 2.1.98',
        '# Or let cron detect it automatically:',
        'clw-auth cron-run',
      ],
    },
  ],
  [
    'config-reset',
    {
      usage: 'config-reset',
      description: 'Reset runtime config to built-in defaults.',
      examples: ['clw-auth config-reset'],
    },
  ],
  [
    'upstream-check',
    {
      usage: 'upstream-check',
      description: 'Fetch monitored upstream sources and compare them with local runtime config.',
      examples: ['clw-auth upstream-check'],
    },
  ],
  [
    'sources',
    {
      usage: 'sources',
      description: 'Print the upstream URLs monitored by this project.',
      examples: ['clw-auth sources'],
    },
  ],
  [
    'export',
    {
      usage: 'export [system]',
      description: 'Without an argument, list exporters. With a system name, run that exporter.',
      examples: [
        'clw-auth export',
        'clw-auth export openclaw',
        'clw-auth export openclaw --agent default',
        'clw-auth export openclaw --all-configured',
      ],
    },
  ],
  [
    'ensure-fresh',
    {
      usage: 'ensure-fresh',
      description: 'On-demand OAuth refresh. No-op if the token is fresh (more than 5 minutes from expiry) or auth uses an API key. When refresh is needed, acquires a short-lived file lock so concurrent callers serialize, refreshes the token, and regenerates api-reference.json plus configured exporters. Designed to be called immediately before any outbound request — e.g. `clw-auth ensure-fresh && curl ...`. Exits non-zero on failure.',
      examples: [
        'clw-auth ensure-fresh',
        'clw-auth ensure-fresh && curl -sSf "$ENDPOINT" -H "Authorization: $AUTH"',
      ],
    },
  ],
  [
    'cron-install',
    {
      usage: 'cron-install',
      description: 'Install a cron entry that runs OAuth maintenance every 6 hours. Idempotent — safe to run multiple times.',
      examples: ['clw-auth cron-install'],
    },
  ],
  [
    'cron-status',
    {
      usage: 'cron-status',
      description: 'Show whether the cron job is installed, the last run result from the debug log, and the log file path and size.',
      examples: ['clw-auth cron-status'],
    },
  ],
  [
    'cron-logs',
    {
      usage: 'cron-logs [n]',
      description: 'Print the last N lines of the cron execution log (default: 50). The log captures stdout and stderr of every cron-run execution.',
      examples: ['clw-auth cron-logs', 'clw-auth cron-logs 100'],
    },
  ],
  [
    'cron-run',
    {
      usage: 'cron-run',
      description: 'Run maintenance tasks manually: conditional OAuth refresh, upstream data collection, user-agent update, api-reference regeneration.',
      examples: ['clw-auth cron-run'],
    },
  ],
  [
    'chattest',
    {
      usage: 'chattest',
      description: 'Open the alternate-screen chat TUI for live Anthropic API connectivity troubleshooting, header inspection, and streaming validation.',
      examples: ['clw-auth chattest'],
    },
  ],
  [
    'help',
    {
      usage: 'help [command]',
      description: 'Show grouped help or help for a specific command.',
      examples: ['clw-auth help', 'clw-auth help status'],
    },
  ],
]);

const COMMAND_ALIASES = new Map([
  ['refresh',    'oauth-refresh'],
  ['auth-setup', 'tui'],
]);

const isVersionCommand = (command) => command === '--version' || command === '-v';

const printVersion = () => {
  console.log(`${BIN_NAME} ${PACKAGE_VERSION}`);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const joinInput = (values) => values.join(' ').trim();

const requireInput = (values, usage) => {
  const input = joinInput(values);

  if (!input) {
    throw new Error(`Usage: ${BIN_NAME} ${usage}`);
  }

  return input;
};

const parseOpenclawExportArgs = (values) => {
  const options = {};

  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];

    if (arg === '--agent' || arg === '-a') {
      const value = values[i + 1];

      if (!isNonEmptyString(value) || value.startsWith('-')) {
        throw new Error('Usage: clw-auth export openclaw --agent <agentId>');
      }

      options.agentId = value;
      i += 1;
      continue;
    }

    if (arg === '--all-configured') {
      options.allConfigured = true;
      continue;
    }

    if (arg === '--help') {
      throw new Error('Usage: clw-auth export openclaw [--agent <agentId> | --all-configured]');
    }

    throw new Error(`Unknown option for openclaw export: ${arg}`);
  }

  if (options.agentId && options.allConfigured) {
    throw new Error('Use either --agent or --all-configured for openclaw export, not both.');
  }

  return options;
};

const parseExportArgs = (args) => {
  const [system = '', ...rest] = args;
  if (system !== 'openclaw') {
    return { system, options: undefined };
  }

  return {
    system,
    options: parseOpenclawExportArgs(rest),
  };
};

const resolveCommandName = (command) => COMMAND_ALIASES.get(command) ?? command;

const printGeneralHelp = () => {
  const width = COMMAND_GROUPS
    .flatMap((group) => group.commands)
    .reduce((longest, command) => Math.max(longest, command.usage.length), 0);

  console.log(`${BIN_NAME}\n`);
  console.log('Usage:');
  console.log(`  ${BIN_NAME} <command> [args]`);
  console.log(`  ${BIN_NAME} help [command]`);
  console.log('');

  for (const group of COMMAND_GROUPS) {
    console.log(`${group.title}:`);

    for (const command of group.commands) {
      console.log(`  ${command.usage.padEnd(width)}  ${command.summary}`);
    }

    console.log('');
  }
};

const printCommandHelp = (command) => {
  const resolvedCommand = resolveCommandName(command);
  const help = COMMAND_HELP.get(resolvedCommand);

  if (!help) {
    printGeneralHelp();
    return;
  }

  console.log(`${BIN_NAME} ${help.usage}`);

  if (Array.isArray(help.aliases) && help.aliases.length > 0) {
    console.log(`Aliases: ${help.aliases.join(', ')}`);
  }

  console.log('');
  console.log(help.description);

  if (Array.isArray(help.examples) && help.examples.length > 0) {
    console.log('');
    console.log('Examples:');

    for (const example of help.examples) {
      console.log(`  ${example}`);
    }
  }
};

const printSection = (title) => {
  console.log(`=== ${title} ===`);
};

const safeLoadRawAuth = (loadJson, getAuthPath) => {
  try {
    const rawAuth = loadJson(getAuthPath());
    return isRecord(rawAuth) ? rawAuth : {};
  } catch {
    return {};
  }
};

const inferApiKeyPresent = (auth, rawAuth) => {
  const authType = isNonEmptyString(auth.type) ? auth.type.trim() : '';
  const rawType = isNonEmptyString(rawAuth.type) ? rawAuth.type.trim() : '';

  return Boolean(
    isNonEmptyString(rawAuth.key)
      || isNonEmptyString(auth.key)
      || (rawType === 'api' && isNonEmptyString(rawAuth.access))
      || (authType === 'api' && isNonEmptyString(auth.access))
      || rawType === 'api'
      || authType === 'api',
  );
};

const resolveStatusSnapshot = async () => {
  const [{ getAuth }, { getAuthPath, loadJson }] = await Promise.all([
    loadAuthModule(),
    loadStoreModule(),
  ]);
  const authResult = await getAuth();
  const auth = isRecord(authResult) ? authResult : {};
  const rawAuth = safeLoadRawAuth(loadJson, getAuthPath);
  const authType = isNonEmptyString(auth.type) ? auth.type.trim() : '';
  const rawType = isNonEmptyString(rawAuth.type) ? rawAuth.type.trim() : '';

  if (authType === 'api' || rawType === 'api' || isNonEmptyString(rawAuth.key)) {
    return {
      type: 'api',
      hasKey: inferApiKeyPresent(auth, rawAuth),
    };
  }

  if (
    authType === 'oauth'
    || rawType === 'oauth'
    || isNonEmptyString(auth.access)
    || isNonEmptyString(rawAuth.access)
    || isNonEmptyString(auth.refresh)
    || isNonEmptyString(rawAuth.refresh)
  ) {
    const expiresCandidate = Number(auth.expires ?? rawAuth.expires);

    return {
      type: 'oauth',
      hasAccess: isNonEmptyString(auth.access) || isNonEmptyString(rawAuth.access),
      hasRefresh: isNonEmptyString(auth.refresh) || isNonEmptyString(rawAuth.refresh),
      expires: Number.isFinite(expiresCandidate) ? expiresCandidate : null,
    };
  }

  return { type: 'none' };
};

const printStatus = async () => {
  const snapshot = await resolveStatusSnapshot();

  if (snapshot.type === 'oauth') {
    const hasExpiry = Number.isFinite(snapshot.expires);

    console.log('Anthropic: oauth');
    console.log(`Access present: ${snapshot.hasAccess}`);
    console.log(`Refresh present: ${snapshot.hasRefresh}`);
    console.log(`Expires: ${hasExpiry ? new Date(snapshot.expires).toISOString() : '(missing)'}`);
    console.log(`Expired: ${hasExpiry ? snapshot.expires <= Date.now() : true}`);
    return snapshot;
  }

  if (snapshot.type === 'api') {
    console.log('Anthropic: api');
    console.log(`Key present: ${snapshot.hasKey}`);
    return snapshot;
  }

  console.log('Anthropic: not configured');
  return snapshot;
};

const updateApiReference = async () => {
  const { generateApiReference } = await loadApiReferenceModule();

  await Promise.resolve(generateApiReference());
  console.log('api-reference.json updated.');
};

const runDoctor = async () => {
  const [{ printApiReference }, { printConfig }, { printSources }] = await Promise.all([
    loadApiReferenceModule(),
    loadConfigModule(),
    loadUpstreamModule(),
  ]);

  printSection('status');
  await printStatus();
  console.log('');

  printSection('api-ref');
  await Promise.resolve(printApiReference());
  console.log('');

  printSection('config');
  await Promise.resolve(printConfig());
  console.log('');

  printSection('sources');
  await Promise.resolve(printSources());
};

const runCommand = async (command, args) => {
  const resolvedCommand = resolveCommandName(command);

  switch (resolvedCommand) {
    case 'update': {
      const { runUpdate } = await loadUpdateModule();
      await runUpdate(args);
      return;
    }
    case 'tui': {
      const { spawnSync } = await import('node:child_process');
      const { fileURLToPath: fu } = await import('node:url');
      const tuiPath = fu(new URL('../scripts/auth-tui.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [tuiPath], { stdio: 'inherit' });
      return process.exit(result.status ?? 0);
    }
    case 'chattest': {
      const { spawnSync } = await import('node:child_process');
      const { fileURLToPath: fu } = await import('node:url');
      const path = fu(new URL('../scripts/chattest.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [path], { stdio: 'inherit' });
      return process.exit(result.status ?? 0);
    }
    case 'oauth-url': {
      const { buildOauthUrl } = await loadAuthModule();
      console.log(buildOauthUrl());
      return;
    }
    case 'oauth-exchange': {
      const input = requireInput(args, 'oauth-exchange <code#state|callback-url>');
      const { oauthExchange } = await loadAuthModule();
      await oauthExchange(input);
      await updateApiReference();
      return;
    }
    case 'oauth-refresh': {
      const { oauthRefresh } = await loadAuthModule();
      await oauthRefresh();
      await updateApiReference();
      return;
    }
    case 'status': {
      await printStatus();
      return;
    }
    case 'doctor': {
      await runDoctor();
      return;
    }
    case 'api': {
      const key = requireInput(args, 'api <anthropic-api-key>');
      const { setApiKey } = await loadAuthModule();
      await setApiKey(key);
      await updateApiReference();
      return;
    }
    case 'api-ref': {
      const { printApiReference } = await loadApiReferenceModule();
      await Promise.resolve(printApiReference());
      return;
    }
    case 'api-ref-update': {
      await updateApiReference();
      return;
    }
    case 'config': {
      const { printConfig } = await loadConfigModule();
      await Promise.resolve(printConfig());
      return;
    }
    case 'set-betas': {
      const input = requireInput(args, 'set-betas <csv|none>');
      const { setBetas } = await loadConfigModule();
      await Promise.resolve(setBetas(input));
      return;
    }
    case 'set-user-agent': {
      const userAgent = requireInput(args, 'set-user-agent <ua|default>');
      const { setUserAgent } = await loadConfigModule();
      await Promise.resolve(setUserAgent(userAgent));
      return;
    }
    case 'set-cc-version': {
      const version = requireInput(args, 'set-cc-version <version>');
      const { setCcVersion } = await loadConfigModule();
      await Promise.resolve(setCcVersion(version));
      return;
    }
    case 'config-reset': {
      const { resetConfig } = await loadConfigModule();
      await Promise.resolve(resetConfig());
      return;
    }
    case 'upstream-check': {
      const { printUpstreamCheck } = await loadUpstreamModule();
      await printUpstreamCheck();
      return;
    }
    case 'sources': {
      const { printSources } = await loadUpstreamModule();
      await Promise.resolve(printSources());
      return;
    }
    case 'export': {
      const { listExporters, runExporter } = await loadExportersModule();

      if (args.length === 0) {
        await Promise.resolve(listExporters());
        return;
      }

      const { system, options } = parseExportArgs(args);
      await runExporter(system, options);
      return;
    }
    case 'ensure-fresh': {
      const { ensureFreshAuth } = await loadCronModule();
      const result = await ensureFreshAuth();

      switch (result.status) {
        case 'refreshed': {
          const expiresAt = Number.isFinite(result.expires)
            ? new Date(result.expires).toISOString()
            : '(unknown)';
          console.log(`Auth refreshed (expires ${expiresAt})`);
          break;
        }
        case 'fresh': {
          const expiresAt = Number.isFinite(result.expires)
            ? new Date(result.expires).toISOString()
            : '(unknown)';
          console.log(`Auth fresh (expires ${expiresAt})`);
          break;
        }
        case 'fresh-by-other': {
          const expiresAt = Number.isFinite(result.expires)
            ? new Date(result.expires).toISOString()
            : '(unknown)';
          console.log(`Auth fresh after concurrent refresh (expires ${expiresAt})`);
          break;
        }
        case 'skipped-api-key':
          console.log('Auth using API key (no refresh needed)');
          break;
        case 'skipped-not-configured':
          console.error('Auth not configured. Run: clw-auth oauth-url');
          process.exit(1);
          break;
        default:
          console.log(`Auth status: ${result.status}`);
      }
      return;
    }
    case 'cron-install': {
      const { installCron } = await loadCronModule();
      await Promise.resolve(installCron());
      return;
    }
    case 'cron-status': {
      const { printCronStatus } = await loadCronModule();
      await Promise.resolve(printCronStatus());
      return;
    }
    case 'cron-logs': {
      const { printCronLogs } = await loadCronModule();
      const n = args.length > 0 ? Number.parseInt(args[0], 10) : 50;
      const lines = Number.isFinite(n) && n > 0 ? n : 50;
      await Promise.resolve(printCronLogs(lines));
      return;
    }
    case 'cron-run': {
      const { runCron } = await loadCronModule();
      await runCron();
      return;
    }
    case 'version': {
      const { printVersionInfo } = await loadVersionModule();
      const json = args.includes('--json');
      printVersionInfo({ json });
      return;
    }
    case 'help': {
      if (args.length === 0) {
        printGeneralHelp();
        return;
      }

      printCommandHelp(args[0]);
      return;
    }
    default: {
      printGeneralHelp();
    }
  }
};

const main = async () => {
  const [, , rawCommand, ...args] = process.argv;

  if (isVersionCommand(rawCommand)) {
    printVersion();
    return;
  }

  if (!rawCommand) {
    printGeneralHelp();
    return;
  }

  await runCommand(rawCommand, args);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
