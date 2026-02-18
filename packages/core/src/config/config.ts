import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import type { OpenHiveConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { logger } from '../utils/logger.js';

const GLOBAL_CONFIG_DIR = join(homedir(), '.openhive');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');
const LOCAL_CONFIG_FILE = join('.openhive', 'config.json');

async function loadJsonFile(path: string): Promise<Partial<OpenHiveConfig> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON5.parse(content);
  } catch {
    return null;
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val !== undefined && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = deepMerge(
        (result[key] ?? {}) as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

let cachedConfig: OpenHiveConfig | null = null;

export async function loadConfig(repoRoot?: string): Promise<OpenHiveConfig> {
  if (cachedConfig) return cachedConfig;

  let config: OpenHiveConfig = { ...DEFAULT_CONFIG };

  // Load global config
  const globalConfig = await loadJsonFile(GLOBAL_CONFIG_FILE);
  if (globalConfig) {
    logger.debug('Loaded global config from ' + GLOBAL_CONFIG_FILE);
    config = deepMerge(config as unknown as Record<string, unknown>, globalConfig as Record<string, unknown>) as unknown as OpenHiveConfig;
  }

  // Load local config
  const localPath = repoRoot ? join(repoRoot, LOCAL_CONFIG_FILE) : LOCAL_CONFIG_FILE;
  const localConfig = await loadJsonFile(localPath);
  if (localConfig) {
    logger.debug('Loaded local config from ' + localPath);
    config = deepMerge(config as unknown as Record<string, unknown>, localConfig as Record<string, unknown>) as unknown as OpenHiveConfig;
  }

  // Resolve default storage dir
  if (!config.taskStorageDir) {
    config.taskStorageDir = join(GLOBAL_CONFIG_DIR, 'tasks');
  }

  cachedConfig = config;
  return config;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function getGlobalConfigDir(): string {
  return GLOBAL_CONFIG_DIR;
}
