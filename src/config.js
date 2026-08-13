import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'camunda-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig() {
  if (existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, '{}');
}

export function requireConfig() {
  const config = loadConfig();
  if (!config || !config.baseUrl || !config.username) {
    console.error('Not logged in. Run: camunda login <engine-rest-url>');
    process.exit(1);
  }
  return config;
}
