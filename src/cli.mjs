#!/usr/bin/env node

const BIN_NAME = 'claude-oauth';

const loadAuthModule = () => import('./auth.mjs');
const loadConfigModule = () => import('./config.mjs');
const loadApiReferenceModule = () => import('./api-reference.mjs');
const loadUpstreamModule = () => import('./upstream.mjs');
const loadCronModule = () => import('./cron.mjs');
const loadExportersModule = () => import('./exporters/index.mjs');
const loadStoreModule = () => import('./store.mjs');

const COMMAND_GROUPS = [
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
        usage: 'cron-run',
        summary: 'Run scheduled maintenance tasks.',
      },
    ],
  },
  {
    title: 'Help',
    commands: [
      {
        usage: 'help [command]',
        summary: 'Show grouped help or help for a specific command.',
      },
    ],
  },
];

const COMMAND_HELP = new Map([
  [
    'oauth-url',
    {
      usage: 'oauth-url',
      description: 'Generate the browser login URL for Claude OAuth.',
      examples: ['claude-oauth oauth-url'],
    },
  ],
  [
    'oauth-exchange',
    {
      usage: 'oauth-exchange <code#state|callback-url>',
      description: 'Exchange the browser callback payload for OAuth credentials and regenerate api-reference.json.',
      examples: [
        'claude-oauth oauth-exchange "code#state"',
        'claude-oauth oauth-exchange "https://platform.claude.com/oauth/code/callback?code=...#state=..."',
      ],
    },
  ],
  [
    'oauth-refresh',
    {
      usage: 'oauth-refresh',
      description: 'Refresh stored OAuth credentials immediately and regenerate api-reference.json.',
      aliases: ['refresh'],
      examples: ['claude-oauth oauth-refresh', 'claude-oauth refresh'],
    },
  ],
  [
    'status',
    {
      usage: 'status',
      description: 'Print the current Anthropic auth mode, token presence, and expiry details.',
      examples: ['claude-oauth status'],
    },
  ],
  [
    'doctor',
    {
      usage: 'doctor',
      description: 'Run status, api-ref, config, and sources in one grouped report.',
      examples: ['claude-oauth doctor'],
    },
  ],
  [
    'api',
    {
      usage: 'api <anthropic-api-key>',
      description: 'Store an Anthropic API key and regenerate api-reference.json.',
      examples: ['claude-oauth api "$ANTHROPIC_API_KEY"'],
    },
  ],
  [
    'api-ref',
    {
      usage: 'api-ref',
      description: 'Print the persisted api-reference.json payload.',
      examples: ['claude-oauth api-ref'],
    },
  ],
  [
    'api-ref-update',
    {
      usage: 'api-ref-update',
      description: 'Regenerate api-reference.json from the current auth and config state.',
      examples: ['claude-oauth api-ref-update'],
    },
  ],
  [
    'config',
    {
      usage: 'config',
      description: 'Print the persisted runtime config.',
      examples: ['claude-oauth config'],
    },
  ],
  [
    'set-betas',
    {
      usage: 'set-betas <csv|none>',
      description: 'Update anthropic-beta headers in runtime config.',
      examples: [
        'claude-oauth set-betas "interleaved-thinking-2025-05-14"',
        'claude-oauth set-betas none',
      ],
    },
  ],
  [
    'set-user-agent',
    {
      usage: 'set-user-agent <ua|default>',
      description: 'Update the runtime User-Agent string or restore the default value.',
      examples: [
        'claude-oauth set-user-agent "claude-cli/2.1.81 (external, cli)"',
        'claude-oauth set-user-agent default',
      ],
    },
  ],
  [
    'config-reset',
    {
      usage: 'config-reset',
      description: 'Reset runtime config to built-in defaults.',
      examples: ['claude-oauth config-reset'],
    },
  ],
  [
    'upstream-check',
    {
      usage: 'upstream-check',
      description: 'Fetch monitored upstream sources and compare them with local runtime config.',
      examples: ['claude-oauth upstream-check'],
    },
  ],
  [
    'sources',
    {
      usage: 'sources',
      description: 'Print the upstream URLs monitored by this project.',
      examples: ['claude-oauth sources'],
    },
  ],
  [
    'export',
    {
      usage: 'export [system]',
      description: 'Without an argument, list exporters. With a system name, run that exporter.',
      examples: ['claude-oauth export', 'claude-oauth export system-name'],
    },
  ],
  [
    'cron-run',
    {
      usage: 'cron-run',
      description: 'Run maintenance tasks, including conditional OAuth refresh and api-reference regeneration.',
      examples: ['claude-oauth cron-run'],
    },
  ],
  [
    'help',
    {
      usage: 'help [command]',
      description: 'Show grouped help or help for a specific command.',
      examples: ['claude-oauth help', 'claude-oauth help status'],
    },
  ],
]);

const COMMAND_ALIASES = new Map([
  ['refresh', 'oauth-refresh'],
]);

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

      await runExporter(args[0]);
      return;
    }
    case 'cron-run': {
      const { runCron } = await loadCronModule();
      await runCron();
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
