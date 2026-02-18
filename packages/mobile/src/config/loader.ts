import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSON5 from 'json5';
import type { MobileConfig } from './schema.js';
import { defaults } from './defaults.js';

const CONFIG_ENV = 'OPENHIVE_MOBILE_CONFIG';
const DEFAULT_PATH = '.openhive/mobile.json5';

/**
 * Deep-merge `source` into `target`, returning a new object.
 * Only plain objects are recursed — arrays and primitives are overwritten.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}

/**
 * Load and return the fully-resolved mobile config.
 *
 * Resolution order:
 *   1. Built-in defaults
 *   2. Config file (JSON5) merged on top
 *
 * @param projectDir  Absolute path to the project root.
 *                    Defaults to `process.cwd()`.
 */
export function loadConfig(projectDir?: string): MobileConfig {
  const root = projectDir ?? process.cwd();
  const configPath = resolve(root, process.env[CONFIG_ENV] ?? DEFAULT_PATH);

  let fileConfig: Partial<MobileConfig> = {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    fileConfig = JSON5.parse(raw) as Partial<MobileConfig>;
  } catch {
    // Missing config file is fine — defaults are used.
  }

  return deepMerge(
    defaults as unknown as Record<string, unknown>,
    fileConfig as unknown as Record<string, unknown>,
  ) as unknown as MobileConfig;
}
