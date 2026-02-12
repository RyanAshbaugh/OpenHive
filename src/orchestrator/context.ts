/**
 * Context assembly for LLM escalation calls.
 *
 * When the orchestrator can't handle a situation with Tier 1 rules, it makes
 * a single headless LLM call. This module builds targeted prompts with just
 * enough context for the LLM to make a good decision.
 *
 * Context levels:
 *   - Task-level: task prompt + recent pane output (most common)
 *   - Project-level: task prompt + wave status + cross-worker state (future)
 */

import { readPipeTail } from './tmux.js';
import type {
  WorkerInfo,
  TaskAssignment,
  StateSnapshot,
  LlmContext,
  WorkerState,
} from './types.js';

/**
 * Build context for an LLM escalation call.
 *
 * Reads the last N lines from the worker's pipe file and assembles a
 * structured prompt. The LLM should respond with either:
 *   - A meta-command: APPROVE, WAIT, RESTART, DONE, FAILED
 *   - Literal text to type into the agent's input
 */
export async function buildLlmContext(
  worker: WorkerInfo,
  snapshot: StateSnapshot,
  assignment: TaskAssignment | undefined,
  contextLines: number,
): Promise<LlmContext> {
  // Read recent output from pipe file (preferred — complete history)
  // Fall back to pane output from snapshot if pipe file is empty
  let paneOutputTail = await readPipeTail(worker.pipeFile, contextLines);
  let paneLines = contextLines;

  if (!paneOutputTail.trim()) {
    // Pipe file empty or unreadable — use snapshot pane output
    const lines = snapshot.paneOutput.split('\n');
    paneOutputTail = lines.slice(-contextLines).join('\n');
    paneLines = Math.min(lines.length, contextLines);
  }

  const taskPrompt = assignment?.task.prompt;

  const prompt = assemblePrompt(
    snapshot.state,
    paneOutputTail,
    taskPrompt,
  );

  return {
    prompt,
    workerState: snapshot.state,
    taskPrompt,
    paneOutputTail,
    paneLines,
  };
}

/**
 * Assemble the final prompt string sent to the escalation LLM.
 */
function assemblePrompt(
  state: WorkerState,
  paneOutput: string,
  taskPrompt?: string,
): string {
  const sections: string[] = [];

  sections.push('You are an orchestrator supervisor for an AI coding agent running in an interactive terminal session.');
  sections.push('The agent has entered a state that requires your guidance.');
  sections.push('');

  // Situation
  sections.push(`## Situation`);
  sections.push(`Worker state: ${state}`);
  sections.push(`State explanation: ${stateExplanation(state)}`);
  sections.push('');

  // Task
  if (taskPrompt) {
    sections.push('## Current Task');
    sections.push(taskPrompt);
    sections.push('');
  }

  // Recent output
  sections.push('## Recent Agent Output (last lines of terminal)');
  sections.push('```');
  sections.push(paneOutput);
  sections.push('```');
  sections.push('');

  // Instructions
  sections.push('## Your Response');
  sections.push('Respond with EXACTLY ONE of the following:');
  sections.push('');
  sections.push('**Meta-commands** (single word on first line):');
  sections.push('- `APPROVE` — approve the tool action the agent is requesting');
  sections.push('- `WAIT` — wait and check again later (agent is making progress)');
  sections.push('- `RESTART` — restart the agent session (agent is stuck or broken)');
  sections.push('- `DONE` — mark the current task as completed');
  sections.push('- `FAILED` — mark the current task as failed');
  sections.push('');
  sections.push('**OR literal text** to type into the agent input (for answering questions, providing guidance, etc.).');
  sections.push('If providing text, just write the text directly — no quotes, no prefix.');
  sections.push('');
  sections.push(stateGuidance(state));

  return sections.join('\n');
}

function stateExplanation(state: WorkerState): string {
  switch (state) {
    case 'waiting_input':
      return 'The agent is asking a question and waiting for user input.';
    case 'waiting_approval':
      return 'The agent is requesting approval to use a tool (file write, command execution, etc.).';
    case 'stuck':
      return 'The agent has not produced any output for an extended period while supposedly working.';
    case 'error':
      return 'The agent encountered an error.';
    case 'rate_limited':
      return 'The agent hit a rate limit.';
    default:
      return `The agent is in "${state}" state.`;
  }
}

function stateGuidance(state: WorkerState): string {
  switch (state) {
    case 'waiting_input':
      return 'The agent is asking you a question. Answer it concisely based on the task requirements. If the question is irrelevant or the agent is confused, provide corrective guidance.';
    case 'waiting_approval':
      return 'Review the tool action. If it aligns with the task, respond APPROVE. If it seems dangerous or irrelevant, provide alternative guidance text.';
    case 'stuck':
      return 'The agent appears stuck. If the output suggests it might still be thinking, respond WAIT. If it looks truly stuck, try providing guidance text to unstick it. If the session is broken, respond RESTART. If the task cannot be completed, respond FAILED.';
    case 'error':
      return 'The agent hit an error. If the error is recoverable (e.g., file not found), provide guidance text. If the task cannot proceed, respond FAILED. If the session is corrupted, respond RESTART.';
    default:
      return 'Assess the situation and respond appropriately.';
  }
}

/**
 * Parse the raw LLM response into meta-commands or literal text.
 * Exported for use by ResponseEngine and testing.
 */
export function parseLlmResponse(raw: string): import('./types.js').LlmResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { type: 'meta', command: 'WAIT' };
  }

  // Check first line for meta-command
  const firstLine = trimmed.split('\n')[0].trim().toUpperCase();
  const metaCommands: import('./types.js').LlmMetaCommand[] = [
    'APPROVE', 'WAIT', 'RESTART', 'DONE', 'FAILED',
  ];

  if (metaCommands.includes(firstLine as any)) {
    return { type: 'meta', command: firstLine as import('./types.js').LlmMetaCommand };
  }

  // Not a meta-command — treat entire response as literal text
  return { type: 'text', text: trimmed };
}
