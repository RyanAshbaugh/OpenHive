/**
 * Per-tool state patterns and action rules for the orchestrator.
 *
 * Each tool (Claude, Codex, Gemini) has unique TUI indicators for different
 * states. This module maps those indicators to WorkerState values and defines
 * Tier 1 programmatic action rules.
 */

import { TOOL_CONTROLS } from '../agents/tool-control.js';
import { logger } from '../utils/logger.js';
import type {
  StatePattern,
  ActionRule,
  ToolOrchestrationProfile,
  ActionContext,
} from './types.js';

// ─── Claude Patterns ─────────────────────────────────────────────────────────

const claudeStatePatterns: StatePattern[] = [
  // Higher priority: check specific states before generic ones
  {
    name: 'claude:rate_limited',
    pattern: /rate limited|rate limit exceeded|too many requests|overloaded/i,
    state: 'rate_limited',
    priority: 10,
  },
  {
    name: 'claude:waiting_approval',
    pattern: /Do you want to|Allow|Approve|tool use|permission|execute.*\?/i,
    state: 'waiting_approval',
    priority: 9,
  },
  {
    name: 'claude:waiting_input',
    pattern: /\?\s*$/m,
    state: 'waiting_input',
    priority: 8,
  },
  {
    name: 'claude:error',
    pattern: /Error:|error occurred|failed to|ENOENT|EACCES|EPERM/i,
    state: 'error',
    priority: 7,
  },
  {
    name: 'claude:working_timer',
    pattern: /\d+s\s*│|(\d+m\s+)?\d+s\s*\||\$\d+\.\d+/,
    state: 'working',
    priority: 5,
  },
  {
    name: 'claude:working_streaming',
    pattern: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Thinking|Reading|Writing|Searching|Running/,
    state: 'working',
    priority: 4,
  },
  {
    name: 'claude:idle',
    pattern: /❯|>\s*$/m,
    state: 'idle',
    priority: 1,
  },
];

const claudeActivityPatterns: RegExp[] = [
  /\d+s\s*│/,            // Timer ticking (e.g., "12s │")
  /\$\d+\.\d+/,          // Cost display (e.g., "$0.12")
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,     // Spinner
  /Reading|Writing|Searching|Running|Thinking/,
];

// ─── Codex Patterns ──────────────────────────────────────────────────────────

const codexStatePatterns: StatePattern[] = [
  {
    name: 'codex:rate_limited',
    pattern: /rate limited|rate limit exceeded|too many requests|429/i,
    state: 'rate_limited',
    priority: 10,
  },
  {
    name: 'codex:waiting_approval',
    pattern: /\[y\/n\]|approve|allow|confirm/i,
    state: 'waiting_approval',
    priority: 9,
  },
  {
    name: 'codex:waiting_input',
    pattern: /\?\s*$/m,
    state: 'waiting_input',
    priority: 8,
  },
  {
    name: 'codex:error',
    pattern: /Error:|error occurred|failed to/i,
    state: 'error',
    priority: 7,
  },
  {
    name: 'codex:working',
    pattern: /Thinking|Running|Writing|applying patch|\.{3,}|streaming/i,
    state: 'working',
    priority: 5,
  },
  {
    name: 'codex:idle',
    pattern: /OpenAI Codex|\? for shortcuts|context left|[>›]\s*$/m,
    state: 'idle',
    priority: 1,
  },
];

const codexActivityPatterns: RegExp[] = [
  /Thinking|Running|Writing|applying patch/i,
  /\.{3,}/,            // Ellipsis (streaming)
];

// ─── Gemini Patterns ─────────────────────────────────────────────────────────

const geminiStatePatterns: StatePattern[] = [
  {
    name: 'gemini:rate_limited',
    pattern: /quota exceeded|rate limit|too many requests|RESOURCE_EXHAUSTED/i,
    state: 'rate_limited',
    priority: 10,
  },
  {
    name: 'gemini:waiting_approval',
    pattern: /approve|allow|confirm|execute.*\?|tool.*approval/i,
    state: 'waiting_approval',
    priority: 9,
  },
  {
    name: 'gemini:waiting_input',
    pattern: /\?\s*$/m,
    state: 'waiting_input',
    priority: 8,
  },
  {
    name: 'gemini:error',
    pattern: /Error:|error occurred|failed to/i,
    state: 'error',
    priority: 7,
  },
  {
    name: 'gemini:working',
    pattern: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|generating|streaming/i,
    state: 'working',
    priority: 5,
  },
  {
    name: 'gemini:idle',
    pattern: /Type your message|>\s/,
    state: 'idle',
    priority: 1,
  },
];

const geminiActivityPatterns: RegExp[] = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,  // Spinner
  /generating/i,
];

// ─── Tier 1 Action Rules ────────────────────────────────────────────────────

/**
 * Shared action rules that apply to all tools.
 * Tool-specific rules can override by using higher priority.
 */
function buildActionRules(autoApprove: boolean): ActionRule[] {
  return [
    {
      name: 'auto_approve',
      states: ['waiting_approval'],
      condition: () => autoApprove,
      action: { type: 'approve' },
      priority: 10,
    },
    {
      name: 'escalate_approval',
      states: ['waiting_approval'],
      condition: () => !autoApprove,
      action: (ctx: ActionContext) => ({
        type: 'escalate_llm' as const,
        prompt: `The agent is requesting approval for a tool action. Last output:\n${lastLines(ctx.snapshot.paneOutput, 20)}\n\nTask: ${ctx.assignment?.task.prompt ?? 'unknown'}\n\nShould this be approved? Respond with APPROVE or provide alternative guidance.`,
      }),
      priority: 9,
    },
    {
      name: 'dismiss_startup_dialog',
      states: ['starting'],
      action: { type: 'dismiss' },
      priority: 8,
    },
    {
      name: 'wait_rate_limit',
      states: ['rate_limited'],
      action: { type: 'wait', durationMs: 60_000 },
      priority: 8,
    },
    {
      name: 'escalate_input',
      states: ['waiting_input'],
      action: (ctx: ActionContext) => ({
        type: 'escalate_llm' as const,
        prompt: `The agent is asking a question. Last output:\n${lastLines(ctx.snapshot.paneOutput, 30)}\n\nTask: ${ctx.assignment?.task.prompt ?? 'unknown'}\n\nWhat should we respond?`,
      }),
      priority: 7,
    },
    {
      name: 'escalate_stuck',
      states: ['stuck'],
      action: (ctx: ActionContext) => ({
        type: 'escalate_llm' as const,
        prompt: `The agent appears stuck (no output change for extended period). Last output:\n${lastLines(ctx.snapshot.paneOutput, 40)}\n\nTask: ${ctx.assignment?.task.prompt ?? 'unknown'}\n\nWhat should we do? Options: send guidance text, RESTART, or FAILED.`,
      }),
      priority: 6,
    },
    {
      name: 'escalate_error',
      states: ['error'],
      action: (ctx: ActionContext) => ({
        type: 'escalate_llm' as const,
        prompt: `The agent encountered an error. Last output:\n${lastLines(ctx.snapshot.paneOutput, 40)}\n\nTask: ${ctx.assignment?.task.prompt ?? 'unknown'}\n\nHow should we recover?`,
      }),
      priority: 6,
    },
    {
      name: 'noop_working',
      states: ['working'],
      action: { type: 'noop' },
      priority: 1,
    },
    {
      name: 'mark_complete_idle',
      states: ['idle'],
      condition: (ctx: ActionContext) => {
        // Only mark complete if:
        // 1. Worker has an assigned task
        // 2. The idle state has settled (5s delay to prevent false positives)
        if (!ctx.assignment) {
          logger.debug('mark_complete_idle: no assignment');
          return false;
        }
        if (!ctx.assignment.idleDetectedAt) {
          logger.debug('mark_complete_idle: no idleDetectedAt');
          return false;
        }
        const settledMs = ctx.snapshot.timestamp - ctx.assignment.idleDetectedAt;
        logger.debug(`mark_complete_idle: settledMs=${settledMs} (need >= 5000)`);
        return settledMs >= 5000;
      },
      action: { type: 'mark_complete' },
      priority: 1,
    },
    {
      name: 'noop_idle',
      states: ['idle'],
      action: { type: 'noop' },
      priority: 0,
    },
    {
      name: 'restart_dead',
      states: ['dead'],
      action: { type: 'restart' },
      priority: 10,
    },
  ];
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

// ─── Profile Construction ────────────────────────────────────────────────────

export function buildProfile(tool: string, autoApprove = true): ToolOrchestrationProfile {
  const toolControl = TOOL_CONTROLS[tool];
  if (!toolControl) {
    throw new Error(`No tool control definition for: ${tool}`);
  }

  const profiles: Record<string, {
    statePatterns: StatePattern[];
    activityPatterns: RegExp[];
  }> = {
    claude: { statePatterns: claudeStatePatterns, activityPatterns: claudeActivityPatterns },
    codex: { statePatterns: codexStatePatterns, activityPatterns: codexActivityPatterns },
    gemini: { statePatterns: geminiStatePatterns, activityPatterns: geminiActivityPatterns },
  };

  const profile = profiles[tool];
  if (!profile) {
    throw new Error(`No orchestration profile for tool: ${tool}. Supported: ${Object.keys(profiles).join(', ')}`);
  }

  return {
    toolControl,
    statePatterns: profile.statePatterns,
    actionRules: buildActionRules(autoApprove),
    stuckTimeoutMs: 120_000,
    activityPatterns: profile.activityPatterns,
    completionPattern: toolControl.readyPattern,
  };
}

/** Get the list of tools that have orchestration profiles */
export function supportedTools(): string[] {
  return ['claude', 'codex', 'gemini'];
}
