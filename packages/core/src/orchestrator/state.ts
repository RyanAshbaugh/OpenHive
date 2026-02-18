/**
 * StateDetector — monitors worker output and detects worker state.
 *
 * Uses capture-pane snapshots and pattern matching against tool-specific
 * state patterns to determine what a worker is currently doing.
 */

import { capturePane, stripAnsi } from './tmux.js';
import type {
  StateSnapshot,
  StatePattern,
  ToolOrchestrationProfile,
  WorkerState,
} from './types.js';

export class StateDetector {
  constructor(private profile: ToolOrchestrationProfile) {}

  /**
   * Capture the current pane output and detect the worker's state.
   * Patterns are checked in priority order (highest first).
   */
  async detect(tmuxTarget: string): Promise<StateSnapshot> {
    const raw = await capturePane(tmuxTarget);
    const paneOutput = stripAnsi(raw);
    return this.detectFromOutput(paneOutput);
  }

  /**
   * Detect state from already-captured pane output.
   * Useful for testing and when output is already available.
   */
  detectFromOutput(paneOutput: string): StateSnapshot {
    const now = Date.now();

    // Sort patterns by priority (highest first)
    const sorted = [...this.profile.statePatterns].sort(
      (a, b) => b.priority - a.priority,
    );

    // Test the last portion of pane output — the most recent state is at the bottom
    // Default window is 30 lines; patterns can override via windowSize
    const defaultWindow = lastLines(paneOutput, 30);

    for (const sp of sorted) {
      const text = sp.windowSize && sp.windowSize !== 30
        ? lastLines(paneOutput, sp.windowSize)
        : defaultWindow;
      if (sp.pattern.test(text)) {
        return {
          state: sp.state,
          matchedPattern: sp.name,
          paneOutput,
          timestamp: now,
        };
      }
    }

    // No pattern matched — if there's output, assume working; if empty, starting
    const trimmed = paneOutput.trim();
    if (trimmed.length === 0) {
      return { state: 'starting', paneOutput, timestamp: now };
    }

    return { state: 'working', paneOutput, timestamp: now };
  }

  /**
   * Check if the pane output shows activity (agent is actively producing output).
   * Used to distinguish "working" from "stuck".
   */
  hasActivity(paneOutput: string): boolean {
    const recent = lastLines(paneOutput, 15);
    return this.profile.activityPatterns.some(p => p.test(recent));
  }

  /**
   * Check if the pane output matches the completion/idle pattern.
   * Used for the working → idle transition.
   */
  isComplete(paneOutput: string): boolean {
    const recent = lastLines(paneOutput, 5);
    return this.profile.completionPattern.test(recent);
  }

  /**
   * Refine a detected state using timing context.
   * Call this after detect() to apply stuck detection logic.
   */
  refineState(
    snapshot: StateSnapshot,
    lastOutputChangeAt: number,
    stuckTimeoutMs: number,
  ): StateSnapshot {
    // If working but no output change for too long → stuck
    if (snapshot.state === 'working') {
      const sinceChange = snapshot.timestamp - lastOutputChangeAt;
      if (sinceChange > stuckTimeoutMs) {
        return {
          ...snapshot,
          state: 'stuck',
          matchedPattern: `stuck:no_output_change_${Math.round(sinceChange / 1000)}s`,
        };
      }
    }
    return snapshot;
  }
}

function lastLines(text: string, n: number): string {
  // Strip trailing blank lines — TUI apps often pad with empty lines
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(Math.max(0, end - n), end).join('\n');
}
