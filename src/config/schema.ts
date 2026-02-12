export type InteractionMode = 'pipe' | 'interactive';

export interface AgentConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  mode?: InteractionMode;
  maxConcurrent?: number;
}

export interface PoolWindowConfig {
  /** Window identifier matching RateLimitWindow.id from limits.ts (e.g. '5h', 'weekly', 'rpm', 'daily') */
  id: string;
  /** Override the default limit for this window. undefined = use default from limits.ts */
  limit?: number;
}

export interface ProviderPoolConfig {
  provider: string;
  maxConcurrent: number;
  cooldownMs: number;
  /** Provider-specific rate limit windows. If omitted, defaults from limits.ts are used. */
  windows?: PoolWindowConfig[];
  /** @deprecated Use windows instead */
  dailyLimit?: number;
  /** @deprecated Use windows instead */
  weeklyLimit?: number;
}

export interface OrchestratorSchemaConfig {
  /** Enable orchestrator mode (default false) */
  enabled?: boolean;
  /** Maximum concurrent workers (default 3) */
  maxWorkers?: number;
  /** Main loop tick interval in ms (default 2000) */
  tickIntervalMs?: number;
  /** Auto-approve tool use actions (default true) */
  autoApprove?: boolean;
  /** Time with no output change before marking stuck, in ms (default 120000) */
  stuckTimeoutMs?: number;
  /** Tool to use for LLM escalation calls (default 'claude') */
  llmEscalationTool?: string;
  /** Number of pane output lines to include in LLM context (default 40) */
  llmContextLines?: number;
  /** Max tasks per worker before recycling (default 0 = unlimited) */
  maxTasksPerWorker?: number;
}

export interface OpenHiveConfig {
  agents: Record<string, AgentConfig>;
  pools: ProviderPoolConfig[];
  worktreeDir: string;
  taskStorageDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  defaultAgent?: string;
  jsonOutput: boolean;
  orchestrator?: OrchestratorSchemaConfig;
}
