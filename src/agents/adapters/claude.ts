import type { ChildProcess } from 'node:child_process';
import type { AgentAdapter, AgentCapabilities, AgentRunOptions, AgentRunResult } from '../adapter.js';
import type { InteractionMode } from '../../config/schema.js';
import { commandExists } from '../../utils/process.js';
import { spawnAgent, runAgent } from '../subprocess.js';
import { claudeStreamParser } from '../stream-parsers.js';

export class ClaudeAdapter implements AgentAdapter {
  name = 'claude';
  displayName = 'Claude Code';
  provider = 'anthropic';
  command = 'claude';
  supportedModes: InteractionMode[] = ['pipe'];

  capabilities: AgentCapabilities = {
    vision: true,
    streaming: true,
    headless: true,
  };

  async checkAvailability(): Promise<boolean> {
    return commandExists(this.command);
  }

  buildCommand(options: AgentRunOptions): { command: string; args: string[] } {
    const args = ['-p', options.prompt, '--output-format', 'stream-json'];
    if (options.contextFiles?.length) {
      for (const file of options.contextFiles) {
        args.push('--file', file);
      }
    }

    // Apply permission flags
    if (options.permissions) {
      const p = options.permissions;
      const allAllow = p.fileRead === 'allow' && p.fileWrite === 'allow' &&
        p.shellExec === 'allow' && p.network === 'allow' &&
        p.packageInstall === 'allow' && p.git === 'allow';

      if (allAllow && p.deniedCommands.length === 0) {
        args.push('--dangerously-skip-permissions');
      } else {
        // Granular: use --allowedTools for allowed categories
        const allowed: string[] = [];
        if (p.fileRead === 'allow') allowed.push('Read', 'Glob', 'Grep');
        if (p.fileWrite === 'allow') allowed.push('Edit', 'Write');
        if (p.shellExec === 'allow') allowed.push('Bash');
        if (p.network === 'allow') allowed.push('WebFetch', 'WebSearch');
        for (const tool of allowed) {
          args.push('--allowedTools', tool);
        }
      }
    }

    return { command: this.command, args };
  }

  spawn(options: AgentRunOptions): ChildProcess {
    const { command, args } = this.buildCommand(options);
    return spawnAgent(command, args, options);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { command, args } = this.buildCommand(options);
    return runAgent(command, args, { ...options, streamParser: claudeStreamParser });
  }
}
