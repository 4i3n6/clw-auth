#!/usr/bin/env node
/**
 * Instala o bundle do claude-oauth nas localizações padrão (~/.local/bin ou ~/bin)
 * e configura o opencode.json para usar os plugins locais.
 *
 * Equivalente a: node src/install.mjs
 * mas com log mais claro e validação de pré-requisitos.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = join(PROJECT_DIR, "bundle");
const HELPER_PATH = join(PROJECT_DIR, "src", "opencode-anthropic-auth");

function check(label, condition, hint) {
  if (!condition) {
    console.error(`[ERRO] ${label}`);
    if (hint) console.error(`       ${hint}`);
    process.exit(1);
  }
  console.log(`[OK]   ${label}`);
}

console.log("claude-oauth - instalador do bundle\n");

check(
  "Node.js >= 18",
  Number.parseInt(process.versions.node.split(".")[0], 10) >= 18,
  `Versao atual: ${process.versions.node}`,
);

check(
  "Helper principal encontrado",
  existsSync(HELPER_PATH),
  `Esperado em: ${HELPER_PATH}`,
);

check(
  "Bundle dir encontrado",
  existsSync(BUNDLE_DIR),
  `Esperado em: ${BUNDLE_DIR}`,
);

console.log("\nExecutando bootstrap...\n");

const result = spawnSync(process.execPath, [HELPER_PATH, "bootstrap", BUNDLE_DIR], {
  stdio: "inherit",
  env: {
    ...process.env,
    OPENCODE_AUTH_BUNDLE_DIR: BUNDLE_DIR,
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
