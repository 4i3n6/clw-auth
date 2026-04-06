#!/usr/bin/env node
/**
 * Instala a entrada de cron para manutenção automática do OAuth a cada 6 horas.
 * Evita duplicatas: só adiciona se a entrada ainda não existir.
 *
 * Uso: node scripts/setup-cron.mjs
 */

import { spawnSync, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOME = homedir();
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = join(PROJECT_DIR, "bundle");
const HELPER = join(HOME, ".local", "bin", "opencode-anthropic-auth");
const LOG_PATH = join(HOME, ".local", "state", "opencode", "anthropic-auth-cron.log");

const CRON_LINE = `0 */6 * * * ${HELPER} cron-run ${BUNDLE_DIR} >> ${LOG_PATH} 2>&1`;

function getCurrentCrontab() {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    return "";
  }
}

const current = getCurrentCrontab();

if (current.includes("opencode-anthropic-auth")) {
  console.log("Entrada de cron ja existente. Nenhuma alteracao realizada.");
  console.log(`\nEntrada detectada:\n${current.split("\n").find((l) => l.includes("opencode-anthropic-auth"))}`);
  process.exit(0);
}

const next = (current.trimEnd() + "\n" + CRON_LINE + "\n").trimStart();

const result = spawnSync("crontab", ["-"], {
  input: next,
  stdio: ["pipe", "inherit", "inherit"],
});

if (result.status !== 0) {
  console.error("Falha ao instalar cron.");
  process.exit(1);
}

console.log("Cron instalado com sucesso.");
console.log(`\nEntrada adicionada:\n${CRON_LINE}`);
console.log(`\nLogs serao gravados em:\n${LOG_PATH}`);
