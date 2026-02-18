/**
 * ResponseEngine — decides what action to take for a given worker state.
 *
 * Tier 1: Programmatic rules (instant, zero tokens).
 * Tier 2: LLM escalation — makes a headless CLI call to get guidance.
 */

import { exec } from '../utils/process.js';
import { buildLlmContext, parseLlmResponse } from './context.js';
import { logger } from '../utils/logger.js';
import type {
  OrchestratorAction,
  ActionContext,
  StateSnapshot,
  WorkerInfo,
  TaskAssignment,
  ToolOrchestrationProfile,
  OrchestratorConfig,
  LlmEscalationResult,
  LlmResponse,
} from './types.js';

export class ResponseEngine {
  private config: OrchestratorConfig | undefined;

  constructor(
    private profile: ToolOrchestrationProfile,
    config?: OrchestratorConfig,
  ) {
    this.config = config;
  }

  /**
   * Decide what action to take given the current state snapshot and context.
   * Evaluates Tier 1 rules in priority order. Returns the first matching rule's action.
   */
  decide(
    snapshot: StateSnapshot,
    worker: WorkerInfo,
    assignment?: TaskAssignment,
  ): OrchestratorAction {
    const ctx: ActionContext = { snapshot, worker, assignment };

    // Sort rules by priority (highest first)
    const sorted = [...this.profile.actionRules].sort(
      (a, b) => b.priority - a.priority,
    );

    for (const rule of sorted) {
      // Check if rule applies to current state
      if (!rule.states.includes(snapshot.state)) continue;

      // Check optional condition
      if (rule.condition && !rule.condition(ctx)) continue;

      // Resolve the action
      const action = typeof rule.action === 'function'
        ? rule.action(ctx)
        : rule.action;

      logger.debug(
        `ResponseEngine: rule "${rule.name}" matched state "${snapshot.state}" → action "${action.type}"`,
      );
      return action;
    }

    // No rule matched — noop
    logger.debug(
      `ResponseEngine: no rule matched for state "${snapshot.state}", returning noop`,
    );
    return { type: 'noop' };
  }

  /**
   * Resolve an escalate_llm action by making a headless LLM call.
   *
   * Calls the configured escalation tool (default: `claude -p "prompt" --output-format text`)
   * and parses the response into a concrete OrchestratorAction.
   */
  async resolveEscalation(
    snapshot: StateSnapshot,
    worker: WorkerInfo,
    assignment?: TaskAssignment,
  ): Promise<LlmEscalationResult> {
    const contextLines = this.config?.llmContextLines ?? 40;
    const tool = this.config?.llmEscalationTool ?? 'claude';

    // Build context
    const context = await buildLlmContext(
      worker,
      snapshot,
      assignment,
      contextLines,
    );

    logger.debug(
      `ResponseEngine: LLM escalation for worker ${worker.id} (state: ${snapshot.state})`,
    );

    // Make the headless LLM call
    const start = Date.now();
    const result = await callLlm(tool, context.prompt, this.config?.llmEscalationTimeoutMs);
    const durationMs = Date.now() - start;

    // Parse the response
    const parsed = parseLlmResponse(result);
    const action = llmResponseToAction(parsed, snapshot.state);

    logger.info(
      `ResponseEngine: LLM escalation resolved in ${durationMs}ms → ${action.type}` +
      (parsed.type === 'meta' ? ` (${parsed.command})` : ` (text: ${(parsed as any).text.slice(0, 50)}...)`),
    );

    return {
      rawResponse: result,
      parsed,
      action,
      durationMs,
    };
  }
}

// ─── LLM Call ────────────────────────────────────────────────────────────────

/**
 * Make a headless LLM call via CLI subprocess.
 * Format: `<tool> -p "<prompt>" --output-format text`
 *
 * Returns the raw text output. Throws on timeout or command failure.
 */
async function callLlm(tool: string, prompt: string, escalationTimeoutMs?: number): Promise<string> {
  const args = buildLlmArgs(tool, prompt);
  const timeout = escalationTimeoutMs ?? 120_000;

  logger.debug(`LLM call: ${tool} ${args.slice(0, 2).join(' ')} ... (${prompt.length} chars)`);

  const result = await exec(tool, args, { timeout });

  if (result.exitCode !== 0) {
    const errMsg = result.stderr.trim() || `exit code ${result.exitCode}`;
    logger.warn(`LLM call failed: ${errMsg}`);
    // Return empty string — parseLlmResponse will default to WAIT
    return '';
  }

  return result.stdout.trim();
}

/**
 * Build CLI args for the escalation LLM call.
 * Each tool has slightly different flags.
 */
function buildLlmArgs(tool: string, prompt: string): string[] {
  switch (tool) {
    case 'claude':
      return ['-p', prompt, '--output-format', 'text'];
    case 'codex':
      return ['exec', '--json', prompt];
    case 'gemini':
      return ['-p', prompt, '--output-format', 'stream-json'];
    default:
      // Default to claude-style args
      return ['-p', prompt, '--output-format', 'text'];
  }
}

// ─── Response Parsing ────────────────────────────────────────────────────────

/**
 * Convert a parsed LLM response to a concrete OrchestratorAction.
 */
function llmResponseToAction(
  response: LlmResponse,
  currentState: import('./types.js').WorkerState,
): OrchestratorAction {
  if (response.type === 'meta') {
    switch (response.command) {
      case 'APPROVE':
        return { type: 'approve' };
      case 'WAIT':
        return { type: 'wait', durationMs: 30_000 };
      case 'RESTART':
        return { type: 'restart' };
      case 'DONE':
        return { type: 'mark_complete' };
      case 'FAILED':
        return { type: 'mark_failed', reason: `LLM escalation: marked as failed (state was ${currentState})` };
    }
  }

  // Literal text — send it to the agent
  return { type: 'send_text', text: response.text };
}

// Export for testing
export { callLlm as _callLlm, buildLlmArgs as _buildLlmArgs, llmResponseToAction as _llmResponseToAction };
