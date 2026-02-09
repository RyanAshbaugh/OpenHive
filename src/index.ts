// Core types
export type { AgentAdapter, AgentCapabilities, AgentRunOptions, AgentRunResult } from './agents/adapter.js';
export type { AgentStatus } from './agents/registry.js';
export type { Task, TaskStatus } from './tasks/task.js';
export type { ProviderPool } from './pool/provider.js';
export type { DayBucket, ProviderUsage, UsageStoreData } from './pool/usage-store.js';
export type { Project, ProjectStatus } from './projects/project.js';
export type { OpenHiveConfig, AgentConfig, ProviderPoolConfig } from './config/schema.js';

// Classes
export { AgentRegistry } from './agents/registry.js';
export { TaskQueue } from './tasks/queue.js';
export { TaskStorage } from './tasks/storage.js';
export { PoolTracker } from './pool/tracker.js';
export { PoolUsageStore } from './pool/usage-store.js';
export { Scheduler } from './scheduler/scheduler.js';
export { Dispatcher } from './scheduler/dispatcher.js';
export { ProjectManager } from './projects/manager.js';

// Adapters
export { ClaudeAdapter } from './agents/adapters/claude.js';
export { CodexAdapter } from './agents/adapters/codex.js';
export { GeminiAdapter } from './agents/adapters/gemini.js';
export { CursorAdapter } from './agents/adapters/cursor.js';

// Config
export { loadConfig, resetConfigCache, getGlobalConfigDir } from './config/config.js';
export { DEFAULT_CONFIG } from './config/defaults.js';

// Utils
export { generateId, generateShortId } from './utils/id.js';
export { logger, setLogLevel } from './utils/logger.js';

// Tasks
export { createTask } from './tasks/task.js';

// Git
export { createWorktree, listWorktrees, getWorktreeDiff, removeWorktree } from './git/worktree.js';
export { mergeWorktree } from './git/merge.js';
