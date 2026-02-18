import type { ChildProcess } from 'node:child_process';
import type { AgentAdapter, AgentCapabilities, AgentRunOptions, AgentRunResult } from '../adapter.js';
import type { InteractionMode } from '../../config/schema.js';
import { commandExists } from '../../utils/process.js';
import { spawnAgent, runAgent } from '../subprocess.js';
import { codexStreamParser } from '../stream-parsers.js';

export class CodexAdapter implements AgentAdapter {
  name = 'codex';
  displayName = 'Codex CLI';
  provider = 'openai';
  command = 'codex';
  supportedModes: InteractionMode[] = ['pipe'];

  capabilities: AgentCapabilities = {
    vision: false,
    streaming: true,
    headless: true,
  };

  async checkAvailability(): Promise<boolean> {
    return commandExists(this.command);
  }

  buildCommand(options: AgentRunOptions): { command: string; args: string[] } {
    const args = ['exec', '--json'];

    // Apply permission flags
    if (options.permissions) {
      const p = options.permissions;
      const allAllow = p.fileRead === 'allow' && p.fileWrite === 'allow' &&
        p.shellExec === 'allow' && p.network === 'allow' &&
        p.packageInstall === 'allow' && p.git === 'allow';

      if (allAllow && p.deniedCommands.length === 0) {
        args.push('--approval-mode', 'full-auto');
      } else if (p.fileWrite === 'allow' && p.shellExec !== 'allow') {
        args.push('--approval-mode', 'auto-edit');
      } else {
        args.push('--approval-mode', 'suggest');
      }
    }

    args.push(options.prompt);
    return { command: this.command, args };
  }

  spawn(options: AgentRunOptions): ChildProcess {
    const { command, args } = this.buildCommand(options);
    return spawnAgent(command, args, options);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { command, args } = this.buildCommand(options);
    return runAgent(command, args, { ...options, streamParser: codexStreamParser });
  }
}
