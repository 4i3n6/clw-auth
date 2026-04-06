#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(BUNDLE_DIR, "opencode-anthropic-auth");

const result = spawnSync(process.execPath, [HELPER_PATH, "bootstrap", BUNDLE_DIR], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
