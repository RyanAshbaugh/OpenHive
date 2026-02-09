export type InteractionMode = 'pipe' | 'interactive';

export interface AgentConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  mode?: InteractionMode;
  maxConcurrent?: number;
}

export interface ProviderPoolConfig {
  provider: string;
  maxConcurrent: number;
  cooldownMs: number;
  dailyLimit?: number;
  weeklyLimit?: number;
}

export interface OpenHiveConfig {
  agents: Record<string, AgentConfig>;
  pools: ProviderPoolConfig[];
  worktreeDir: string;
  taskStorageDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  defaultAgent?: string;
  jsonOutput: boolean;
}
