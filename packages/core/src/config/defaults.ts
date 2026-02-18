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
    {
      provider: 'anthropic',
      maxConcurrent: 5,
      cooldownMs: 1000,
      // 5h rolling + weekly rolling — limits vary by plan, tracked but no hard cap
    },
    {
      provider: 'openai',
      maxConcurrent: 5,
      cooldownMs: 1000,
      // 5h rolling + weekly rolling — limits vary by plan, tracked but no hard cap
    },
    {
      provider: 'google',
      maxConcurrent: 5,
      cooldownMs: 1000,
      windows: [
        { id: 'rpm', limit: 60 },    // Free tier: 60 RPM
        { id: 'daily', limit: 1000 }, // Free tier: 1,000 RPD
      ],
    },
    {
      provider: 'cursor',
      maxConcurrent: 2,
      cooldownMs: 1000,
      // No known rate limits for programmatic usage
    },
  ],
  worktreeDir: '.openhive-worktrees',
  taskStorageDir: '',  // resolved at runtime to ~/.openhive/tasks
  logLevel: 'info',
  jsonOutput: false,
};
