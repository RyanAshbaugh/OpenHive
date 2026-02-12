/**
 * Agent availability detection for e2e tests.
 * Checks which AI agents and tools are installed and reachable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AgentAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  tmux: boolean;
}

async function isCommandAvailable(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check which agents and tools are available on this machine.
 */
export async function checkAgentAvailability(): Promise<AgentAvailability> {
  const [claude, codex, gemini, tmux] = await Promise.all([
    isCommandAvailable('claude', ['--version']),
    isCommandAvailable('codex', ['--version']),
    isCommandAvailable('gemini', ['--version']),
    isCommandAvailable('tmux', ['-V']),
  ]);

  return { claude, codex, gemini, tmux };
}

/**
 * Returns true only if all three agents AND tmux are available.
 */
export function allAgentsAvailable(avail: AgentAvailability): boolean {
  return avail.claude && avail.codex && avail.gemini && avail.tmux;
}

/**
 * Returns a human-readable summary of what's missing.
 */
export function unavailableSummary(avail: AgentAvailability): string {
  const missing: string[] = [];
  if (!avail.tmux) missing.push('tmux');
  if (!avail.claude) missing.push('claude');
  if (!avail.codex) missing.push('codex');
  if (!avail.gemini) missing.push('gemini');
  return missing.length ? `Missing: ${missing.join(', ')}` : 'All available';
}
