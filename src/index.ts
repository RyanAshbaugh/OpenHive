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

// Tool control + probing
export type { ToolControl, TmuxStep } from './agents/tool-control.js';
export { TOOL_CONTROLS, buildUsageProbeSteps, buildExitSteps } from './agents/tool-control.js';
export type { ProbeResult, UsageWindow } from './pool/usage-probe.js';
export { probeTool, probeAllTools, getCachedProbeResults, loadProbeCache, isProbing, forceProbe, cleanupProbeSession } from './pool/usage-probe.js';

// Utils
export { generateId, generateShortId } from './utils/id.js';
export { logger, setLogLevel } from './utils/logger.js';

// Tasks
export { createTask } from './tasks/task.js';

// Git
export { createWorktree, listWorktrees, getWorktreeDiff, removeWorktree } from './git/worktree.js';
export { mergeWorktree } from './git/merge.js';

// Specs
export type { ProjectSpec, ServeConfig, TaskSpec, VerifyConfig, ScreenshotSpec } from './specs/schema.js';
export { parseSpec, validateSpec, SpecParseError } from './specs/parser.js';
export { computeWaves, runSpec, CycleError } from './specs/runner.js';
export type { Wave, SpecRunResult, WaveResult, SpecRunOptions } from './specs/runner.js';

// Session
export type { LaunchSession, SessionWave, SessionTask } from './specs/session.js';
export { writeSession, readSession, clearSession } from './specs/session.js';

// Verification
export { runVerification } from './verify/runner.js';
export type { VerifyResult, TestResult, ScreenshotVerifyResult } from './verify/runner.js';
export { takeScreenshot } from './verify/screenshot.js';
export type { ScreenshotResult } from './verify/screenshot.js';
export { assessScreenshot, findVisionAgent } from './verify/assess.js';
export type { AssessmentResult } from './verify/assess.js';
