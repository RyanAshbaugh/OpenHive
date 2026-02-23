/**
 * Core types for the tmux session-based orchestrator.
 *
 * The orchestrator is a deterministic state machine that manages persistent
 * tmux sessions for AI coding agents. It reads worker screens, detects states
 * via pattern matching, and makes programmatic decisions (Tier 1) or escalates
 * to a headless LLM call (Tier 2) when rules don't match.
 */

import type { ToolControl } from '../agents/tool-control.js';
import type { Task } from '../tasks/task.js';

// ─── Worker States ───────────────────────────────────────────────────────────

export type WorkerState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting_approval'
  | 'waiting_input'
  | 'rate_limited'
  | 'error'
  | 'stuck'
  | 'dead';

// ─── Orchestrator Actions ────────────────────────────────────────────────────

export type OrchestratorAction =
  | { type: 'send_keys'; keys: string[] }
  | { type: 'send_text'; text: string }
  | { type: 'approve' }
  | { type: 'dismiss' }
  | { type: 'wait'; durationMs: number }
  | { type: 'restart' }
  | { type: 'escalate_llm'; prompt: string }
  | { type: 'mark_complete' }
  | { type: 'mark_failed'; reason: string }
  | { type: 'noop' };

// ─── State Detection ─────────────────────────────────────────────────────────

export interface StatePattern {
  /** Human-readable name for debugging */
  name: string;
  /** Regex to match against captured pane output */
  pattern: RegExp;
  /** Worker state this pattern indicates */
  state: WorkerState;
  /** Higher priority patterns are checked first (default 0) */
  priority: number;
  /** Number of trailing lines to check (default 30). Use smaller values for
   *  prompts that only appear at the very bottom of the screen. */
  windowSize?: number;
}

export interface StateSnapshot {
  /** Detected worker state */
  state: WorkerState;
  /** The pattern that matched, if any */
  matchedPattern?: string;
  /** Raw captured pane output (ANSI-stripped) */
  paneOutput: string;
  /** Timestamp of this snapshot */
  timestamp: number;
}

// ─── Action Rules (Tier 1) ───────────────────────────────────────────────────

export interface ActionRule {
  /** Human-readable name for debugging */
  name: string;
  /** Worker state(s) this rule applies to */
  states: WorkerState[];
  /** Additional condition beyond state match */
  condition?: (ctx: ActionContext) => boolean;
  /** Action to take */
  action: OrchestratorAction | ((ctx: ActionContext) => OrchestratorAction);
  /** Higher priority rules are checked first (default 0) */
  priority: number;
}

export interface ActionContext {
  snapshot: StateSnapshot;
  worker: WorkerInfo;
  assignment?: TaskAssignment;
}

// ─── Tool Orchestration Profile ──────────────────────────────────────────────

export interface ToolOrchestrationProfile {
  /** Existing tool control patterns (readyPattern, exitSequence, etc.) */
  toolControl: ToolControl;
  /** Patterns for detecting worker state from pane output */
  statePatterns: StatePattern[];
  /** Tier 1 programmatic action rules */
  actionRules: ActionRule[];
  /** Time (ms) with no output change before marking as stuck */
  stuckTimeoutMs: number;
  /** Patterns that prove the agent is actively working (timer, cost, streaming) */
  activityPatterns: RegExp[];
  /** Pattern indicating the agent returned to its idle prompt */
  completionPattern: RegExp;
}

// ─── Task Assignment ─────────────────────────────────────────────────────────

export interface TaskAssignment {
  task: Task;
  assignedAt: number;
  /** Timestamp when idle state was first detected after sending prompt */
  idleDetectedAt?: number;
  /** True once the worker has entered a non-idle state (working, waiting_approval, etc.) since assignment */
  hasWorked?: boolean;
}

// ─── Worker Info ─────────────────────────────────────────────────────────────

export interface WorkerInfo {
  /** Unique worker identifier */
  id: string;
  /** Tool name (claude, codex, gemini) */
  tool: string;
  /** tmux session:window target */
  tmuxTarget: string;
  /** Current state */
  state: WorkerState;
  /** Current task assignment */
  assignment?: TaskAssignment;
  /** Total tasks completed in this session */
  tasksCompleted: number;
  /** Pipe-pane log file path */
  pipeFile: string;
  /** Last known pipe file size (for change detection) */
  lastPipeSize: number;
  /** Timestamp of last state check */
  lastCheckAt: number;
  /** Timestamp of last detected output change */
  lastOutputChangeAt: number;
  /** Created timestamp */
  createdAt: number;
}

// ─── Orchestrator Config ─────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Enable orchestrator mode (default false) */
  enabled: boolean;
  /** Maximum concurrent workers (default 3) */
  maxWorkers: number;
  /** Main loop tick interval in ms (default 2000) */
  tickIntervalMs: number;
  /** Auto-approve tool use actions (default true) */
  autoApprove: boolean;
  /** Time with no output change before marking stuck (default 120000) */
  stuckTimeoutMs: number;
  /** Tool to use for LLM escalation calls (default 'claude') */
  llmEscalationTool: string;
  /** Number of pane output lines to include in LLM context (default 40) */
  llmContextLines: number;
  /** Settling delay (ms) before confirming idle after prompt (default 5000) */
  idleSettlingMs: number;
  /** Max tasks per worker before recycling (0 = unlimited, default 0) */
  maxTasksPerWorker: number;
  /** Create git worktrees for task isolation (default false) */
  useWorktrees: boolean;
  /** Directory (relative to repo root) for worktrees (default '.openhive-worktrees') */
  worktreeDir: string;
  /** Root directory of the git repo for worktree creation (default: process.cwd()) */
  repoRoot?: string;
  /** Hard wall-clock deadline per task in ms (0 = unlimited, default 0) */
  taskTimeoutMs: number;
  /** Timeout for LLM escalation calls in ms (default 60000) */
  llmEscalationTimeoutMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: false,
  maxWorkers: 3,
  tickIntervalMs: 2000,
  autoApprove: true,
  stuckTimeoutMs: 120_000,
  llmEscalationTool: 'claude',
  llmContextLines: 40,
  idleSettlingMs: 5000,
  maxTasksPerWorker: 0,
  useWorktrees: false,
  worktreeDir: '.openhive-worktrees',
  taskTimeoutMs: 0,
  llmEscalationTimeoutMs: 60_000,
};

// ─── Orchestrator Events ─────────────────────────────────────────────────────

export type OrchestratorEvent =
  | { type: 'worker_created'; workerId: string; tool: string }
  | { type: 'task_assigned'; workerId: string; taskId: string }
  | { type: 'state_changed'; workerId: string; from: WorkerState; to: WorkerState }
  | { type: 'action_taken'; workerId: string; action: OrchestratorAction }
  | { type: 'task_completed'; workerId: string; taskId: string }
  | { type: 'task_failed'; workerId: string; taskId: string; reason: string }
  | { type: 'worker_died'; workerId: string }
  | { type: 'worker_restarted'; workerId: string }
  | { type: 'llm_escalation'; workerId: string; rawResponse: string; resolvedAction: string; durationMs: number };

export type OrchestratorEventHandler = (event: OrchestratorEvent) => void;

// ─── LLM Escalation ─────────────────────────────────────────────────────────

/** Meta-commands the LLM can respond with (case-insensitive, first line). */
export type LlmMetaCommand = 'APPROVE' | 'WAIT' | 'RESTART' | 'DONE' | 'FAILED';

/**
 * Parsed response from a Tier 2 LLM escalation call.
 * Either a meta-command or literal text to send to the agent.
 */
export type LlmResponse =
  | { type: 'meta'; command: LlmMetaCommand }
  | { type: 'text'; text: string };

export interface LlmEscalationResult {
  /** The raw LLM response text */
  rawResponse: string;
  /** Parsed response */
  parsed: LlmResponse;
  /** Resolved orchestrator action */
  action: OrchestratorAction;
  /** Duration of the LLM call in ms */
  durationMs: number;
}

// ─── Orchestration Session State (written to disk for TUI) ──────────────────

export interface OrchestrationWorkerState {
  id: string;
  tool: string;
  state: WorkerState;
  taskId?: string;
  taskPrompt?: string;
  tasksCompleted: number;
  assignedAt?: number;
}

export interface OrchestrationSessionState {
  status: 'running' | 'stopped';
  workers: OrchestrationWorkerState[];
  pendingTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  updatedAt: string;
}

/** Context assembled for an LLM escalation call. */
export interface LlmContext {
  /** The assembled prompt to send to the LLM */
  prompt: string;
  /** Worker state at time of escalation */
  workerState: WorkerState;
  /** Task prompt, if assigned */
  taskPrompt?: string;
  /** Last N lines of pane output */
  paneOutputTail: string;
  /** Number of pane lines included */
  paneLines: number;
}
