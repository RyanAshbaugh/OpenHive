/**
 * Per-tool tmux control patterns.
 *
 * Documents how to interact with each CLI tool's TUI via tmux send-keys:
 * starting sessions, sending commands, capturing output, and exiting.
 *
 * These patterns were empirically verified on macOS with:
 *   Claude Code 2.x, Codex CLI 0.94+, Gemini CLI 1.x
 *
 * Usage: import { TOOL_CONTROLS } from './tool-control.js'
 */

export interface ToolControl {
  /** Tool identifier matching the agent adapter name */
  tool: string;
  /** Provider identifier matching pool config */
  provider: string;
  /** Command to start the tool in interactive mode */
  startCommand: string;
  /** Args for interactive mode (no prompt, ready for commands) */
  startArgs: string[];
  /** Slash command that shows usage/quota info */
  usageCommand: string;
  /** Whether the tool has autocomplete that intercepts the first Enter */
  hasAutocomplete: boolean;
  /**
   * tmux send-keys sequence to submit a slash command.
   * Each string is a separate `tmux send-keys` argument.
   * For tools with autocomplete: send command, Enter, wait, Enter again.
   */
  submitSequence: string[];
  /** How to exit the tool cleanly */
  exitMethod: 'double-ctrl-c' | 'slash-quit' | 'ctrl-c';
  /** tmux send-keys sequence to exit */
  exitSequence: string[][];
  /** Delay (ms) between exit sequence steps */
  exitDelayMs: number;
  /** How to dismiss a dialog/overlay (e.g. usage panel) */
  dismissKey: string;
  /** Delay (ms) to wait after sending usage command before capture */
  captureDelayMs: number;
  /** How many lines of scrollback to capture (negative = from bottom) */
  captureScrollback: number;
  /** Regex that matches pane output when the tool's main UI is ready for input */
  readyPattern: RegExp;
  /** Regex that matches startup dialogs/prompts that need to be dismissed */
  startupDialogPattern?: RegExp;
  /** Notes about quirks and edge cases */
  notes: string;
}

export const TOOL_CONTROLS: Record<string, ToolControl> = {
  claude: {
    tool: 'claude',
    provider: 'anthropic',
    startCommand: 'claude',
    startArgs: [],
    usageCommand: '/usage',
    hasAutocomplete: true,
    // Type /usage, Enter shows autocomplete menu, second Enter selects
    submitSequence: ['/usage', 'Enter', 'Enter'],
    exitMethod: 'double-ctrl-c',
    exitSequence: [['C-c'], ['C-c']],
    exitDelayMs: 500,
    dismissKey: 'Escape',
    captureDelayMs: 2000,
    captureScrollback: -60,
    readyPattern: />\s*$/m,
    notes:
      'Claude Code uses an autocomplete dropdown for slash commands. ' +
      'First Enter opens the menu, second Enter selects the highlighted item. ' +
      'Single Ctrl+C only clears the current input line; need double Ctrl+C to exit. ' +
      'Escape dismisses dialogs/overlays and cancels running responses. ' +
      '/usage output format: "Current session: ██▌ 5% used  Resets 9:59pm PT" ' +
      'and "Current week (all): ███████▌ 15% used  Resets Feb 12 at 7:59pm PT". ' +
      'Percentages are "% used" (0% = fresh, 100% = exhausted).',
  },

  codex: {
    tool: 'codex',
    provider: 'openai',
    startCommand: 'codex',
    startArgs: [],
    usageCommand: '/status',
    hasAutocomplete: true,
    submitSequence: ['/status', 'Enter', 'Enter'],
    exitMethod: 'double-ctrl-c',
    exitSequence: [['C-c'], ['C-c']],
    exitDelayMs: 500,
    dismissKey: 'Escape',
    captureDelayMs: 2000,
    captureScrollback: -40,
    readyPattern: /OpenAI Codex/,
    startupDialogPattern: /Update available|Try new model|Choose.*model/i,
    notes:
      'Codex CLI also has autocomplete for slash commands. ' +
      'Double Ctrl+C to exit (single only clears input). ' +
      '/status output format: "5h limit: [████████████████████] 99% left (resets 22:20)" ' +
      'and "Weekly limit: [████████████████████] 100% left (resets 17:20 on 16 Feb)". ' +
      'Percentages are "% left" (100% = fresh, 0% = exhausted) — INVERSE of Claude.',
  },

  gemini: {
    tool: 'gemini',
    provider: 'google',
    startCommand: 'gemini',
    startArgs: [],
    usageCommand: '/stats',
    hasAutocomplete: true,
    submitSequence: ['/stats', 'Enter', 'Enter'],
    exitMethod: 'slash-quit',
    exitSequence: [['/quit', 'Enter', 'Enter']],
    exitDelayMs: 1000,
    dismissKey: 'Escape',
    captureDelayMs: 3000,
    captureScrollback: -60,
    readyPattern: /Type your message|>\s/,
    notes:
      'Gemini CLI has autocomplete for slash commands (same double-Enter pattern). ' +
      'Ctrl+C quits the app but /quit is the clean exit. ' +
      '/stats output shows per-model usage with: ' +
      '"gemini-2.5-flash  -  100.0% (Resets in 24h)" format. ' +
      'Percentages are "% left" (100% = fresh, 0% = exhausted) — same as Codex, inverse of Claude. ' +
      '/stats subcommands: session (default), model (token breakdown), tools (tool calls). ' +
      '"Usage limits span all sessions and reset daily." ' +
      'Note: Gemini lists multiple models; the active model is shown in the status bar.',
  },

  cursor: {
    tool: 'cursor',
    provider: 'cursor',
    startCommand: 'agent',
    startArgs: ['--agent'],
    usageCommand: '',  // No known usage command
    hasAutocomplete: false,
    submitSequence: [],
    exitMethod: 'ctrl-c',
    exitSequence: [['C-c']],
    exitDelayMs: 500,
    dismissKey: 'Escape',
    captureDelayMs: 1000,
    captureScrollback: -30,
    readyPattern: />\s*$/m,
    notes:
      'Cursor agent mode has no known interactive usage/status command. ' +
      'Usage tracking is not available via tmux probing.',
  },
};

/**
 * Build tmux send-keys commands for probing a tool's usage.
 *
 * Returns an array of { command, delayAfterMs } steps.
 * Each step.command is the full args to pass to `tmux send-keys`.
 */
export interface TmuxStep {
  keys: string[];
  delayAfterMs: number;
}

export function buildUsageProbeSteps(tool: string): TmuxStep[] | null {
  const ctrl = TOOL_CONTROLS[tool];
  if (!ctrl || !ctrl.usageCommand) return null;

  const steps: TmuxStep[] = [];

  // Send the slash command
  steps.push({ keys: [ctrl.submitSequence[0]], delayAfterMs: 500 });

  // Send Enter(s) for autocomplete
  for (let i = 1; i < ctrl.submitSequence.length; i++) {
    steps.push({ keys: [ctrl.submitSequence[i]], delayAfterMs: i === ctrl.submitSequence.length - 1 ? ctrl.captureDelayMs : 500 });
  }

  return steps;
}

export function buildExitSteps(tool: string): TmuxStep[] | null {
  const ctrl = TOOL_CONTROLS[tool];
  if (!ctrl) return null;

  return ctrl.exitSequence.map(keys => ({
    keys,
    delayAfterMs: ctrl.exitDelayMs,
  }));
}
