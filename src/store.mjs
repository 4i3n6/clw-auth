import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.local', 'share', 'clw-auth');

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function normalizeAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return {};
  }

  const normalized = {};

  if (typeof auth.type === 'string' && auth.type.trim()) {
    normalized.type = auth.type.trim();
  }

  if (typeof auth.access === 'string' && auth.access) {
    normalized.access = auth.access;
  }

  if (typeof auth.refresh === 'string' && auth.refresh) {
    normalized.refresh = auth.refresh;
  }

  if (typeof auth.expires === 'number' || typeof auth.expires === 'string') {
    normalized.expires = auth.expires;
  }

  // API key — stored verbatim; never logged (debug callers must redact this field).
  if (typeof auth.key === 'string' && auth.key) {
    normalized.key = auth.key;
  }

  return normalized;
}

function getAuthBackupPath() {
  return join(getDataDir(), 'auth.json.bak');
}

function ensureAuthBackup() {
  const authPath = getAuthPath();
  const backupPath = getAuthBackupPath();

  if (existsSync(authPath) && !existsSync(backupPath)) {
    ensureParent(backupPath);
    copyFileSync(authPath, backupPath);
    chmodSync(backupPath, 0o600);
  }
}

export function getDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  return `${DATA_DIR}${sep}`;
}

export function getAuthPath() {
  return join(getDataDir(), 'auth.json');
}

export function getApiRefPath() {
  return join(getDataDir(), 'api-reference.json');
}

export function getConfigPath() {
  return join(getDataDir(), 'config.json');
}

export function getCronLockPath() {
  return join(getDataDir(), 'cron.lock');
}

export function getCronLogPath() {
  return join(getDataDir(), 'cron.log');
}

export function getDebugLogPath() {
  return join(getDataDir(), 'debug.log');
}

export function loadJson(filePath) {
  ensureParent(filePath);

  if (!existsSync(filePath)) {
    return {};
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  ensureParent(filePath);

  const temporaryPath = join(dirname(filePath), `.tmp-${process.pid}-${Date.now()}`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  writeFileSync(temporaryPath, payload, { mode });
  chmodSync(temporaryPath, mode);

  try {
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, mode);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }

    throw error;
  }
}

export function loadAuth() {
  return normalizeAuth(loadJson(getAuthPath()));
}

export function saveAuth(auth) {
  ensureAuthBackup();
  writeJsonAtomic(getAuthPath(), normalizeAuth(auth), 0o600);
}

export function loadApiRef() {
  return loadJson(getApiRefPath());
}

export function saveApiRef(ref) {
  writeJsonAtomic(getApiRefPath(), ref, 0o644);
}

export function debugLog(event, details = {}) {
  const logPath = getDebugLogPath();
  const entry = {
    ts: new Date().toISOString(),
    event: typeof event === 'string' ? event : String(event),
    details,
  };

  ensureParent(logPath);
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  chmodSync(logPath, 0o600);
}
