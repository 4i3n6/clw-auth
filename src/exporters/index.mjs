import { run as runOpencode } from './opencode.mjs';
import { DESCRIPTION as openclawDescription, run as runOpenclaw } from './openclaw.mjs';

const opencodeExporter = Object.freeze({
  name: 'opencode',
  description: 'Sync clw-auth credentials and Anthropic plugin into OpenCode.',
  run: runOpencode,
});

const openclawExporter = Object.freeze({
  name: 'openclaw',
  description: openclawDescription,
  run: runOpenclaw,
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
