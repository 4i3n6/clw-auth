import {
  inspectInstall as inspectOpencode,
  run as runOpencode,
} from './opencode.mjs';
import {
  DESCRIPTION as openclawDescription,
  inspectInstall as inspectOpenclaw,
  run as runOpenclaw,
} from './openclaw.mjs';

const opencodeExporter = Object.freeze({
  name: 'opencode',
  description: 'Sync clw-auth credentials and Anthropic plugin into OpenCode.',
  run: runOpencode,
  inspect: inspectOpencode,
});

const openclawExporter = Object.freeze({
  name: 'openclaw',
  description: openclawDescription,
  run: runOpenclaw,
  inspect: inspectOpenclaw,
});

export const EXPORTERS = new Map([
  [opencodeExporter.name, opencodeExporter],
  [openclawExporter.name, openclawExporter],
]);

/**
 * Prints the available exporters and returns their descriptors.
 *
 * @returns {{ name: string, description: string, run: Function }[]}
 */
export function listExporters() {
  const exporters = [...EXPORTERS.values()];

  if (exporters.length === 0) {
    console.log('No exporters registered.');
    return exporters;
  }

  console.log('Available exporters:');

  for (const exporter of exporters) {
    console.log(`- ${exporter.name}: ${exporter.description}`);
  }

  return exporters;
}

/**
 * Runs a registered exporter by name.
 *
 * @param {string} name
 * @param {unknown} [options]
 * @returns {Promise<unknown>}
 */
export async function runExporter(name, options) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Exporter name must be a non-empty string.');
  }

  const normalizedName = name.trim();
  const exporter = EXPORTERS.get(normalizedName);

  if (!exporter) {
    const availableExporters = [...EXPORTERS.keys()].join(', ') || '(none)';
    throw new Error(`Unknown exporter "${normalizedName}". Available exporters: ${availableExporters}`);
  }

  return exporter.run(options);
}

/**
 * Inspect every registered exporter and return a uniform status array.
 *
 * Each entry has at least `{ name, status }` plus exporter-specific extras
 * (e.g. opencode adds `installedClwVersion`/`generatedAt`, openclaw adds
 * `configuredAgents`). Consumers (`clw-auth version`, `clw-auth update`)
 * iterate this array without caring which exporter produced each entry.
 *
 * Pure: each exporter's inspect() is itself pure (filesystem reads only),
 * and this aggregator just collects them. Failures in one exporter do not
 * suppress entries from the others — a bad inspect() is reported as
 * `{ status: 'error', error: <message> }` so the operator still sees the
 * other exporters.
 *
 * @returns {Array<{ name: string, status: string, [key: string]: unknown }>}
 */
export function inspectExporters() {
  const results = [];

  for (const exporter of EXPORTERS.values()) {
    try {
      results.push(exporter.inspect());
    } catch (error) {
      results.push({
        name: exporter.name,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
