#!/usr/bin/env node
/**
 * Installs a cron entry for automatic OAuth maintenance every 6 hours.
 * Avoids duplicates: only adds the entry if it does not already exist.
 *
 * Usage: node scripts/setup-cron.mjs
 */

import { spawnSync, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOME = homedir();
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = resolve(PROJECT_DIR, "src", "cli.mjs");
const LOG_PATH = join(HOME, ".local", "share", "clw-auth", "cron.log");

const CRON_LINE = `0 */6 * * * node "${CLI_PATH}" cron-run >> "${LOG_PATH}" 2>&1`;

function getCurrentCrontab() {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    return "";
  }
}

const current = getCurrentCrontab();

if (current.includes("clw-auth")) {
  console.log("Cron entry already exists. No changes made.");
  console.log(`\nDetected entry:\n${current.split("\n").find((l) => l.includes("clw-auth"))}`);
  process.exit(0);
}

const next = (current.trimEnd() + "\n" + CRON_LINE + "\n").trimStart();

const result = spawnSync("crontab", ["-"], {
  input: next,
  stdio: ["pipe", "inherit", "inherit"],
});

if (result.status !== 0) {
  console.error("Failed to install cron entry.");
  process.exit(1);
}

console.log("Cron entry installed successfully.");
console.log(`\nAdded entry:\n${CRON_LINE}`);
console.log(`\nLogs will be written to:\n${LOG_PATH}`);
