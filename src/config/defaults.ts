import type { OpenHiveConfig } from './schema.js';

export const DEFAULT_CONFIG: OpenHiveConfig = {
  agents: {
    claude: {
      enabled: true,
      command: 'claude',
      args: ['-p'],
      mode: 'pipe',
      maxConcurrent: 2,
    },
    codex: {
      enabled: true,
      command: 'codex',
      args: [],
      mode: 'pipe',
      maxConcurrent: 1,
    },
    gemini: {
      enabled: true,
      command: 'gemini',
      args: [],
      mode: 'pipe',
      maxConcurrent: 1,
    },
    cursor: {
      enabled: true,
      command: 'agent',
      args: ['--agent'],
      mode: 'pipe',
      maxConcurrent: 1,
    },
  },
  pools: [
    { provider: 'anthropic', maxConcurrent: 5, cooldownMs: 1000 },
    { provider: 'openai', maxConcurrent: 5, cooldownMs: 1000 },
    { provider: 'google', maxConcurrent: 5, cooldownMs: 1000 },
    { provider: 'cursor', maxConcurrent: 2, cooldownMs: 1000 },
  ],
  worktreeDir: '.openhive-worktrees',
  taskStorageDir: '',  // resolved at runtime to ~/.openhive/tasks
  logLevel: 'info',
  jsonOutput: false,
};
