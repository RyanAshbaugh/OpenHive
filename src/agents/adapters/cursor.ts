import type { ChildProcess } from 'node:child_process';
import type { AgentAdapter, AgentCapabilities, AgentRunOptions, AgentRunResult } from '../adapter.js';
import type { InteractionMode } from '../../config/schema.js';
import { commandExists } from '../../utils/process.js';
import { spawnAgent, runAgent } from '../subprocess.js';

export class CursorAdapter implements AgentAdapter {
  name = 'cursor';
  displayName = 'Cursor Agent';
  provider = 'cursor';
  command = 'agent';
  supportedModes: InteractionMode[] = ['pipe'];

  capabilities: AgentCapabilities = {
    vision: true,
    streaming: false,
    headless: false,
  };

  async checkAvailability(): Promise<boolean> {
    return commandExists(this.command);
  }

  buildCommand(options: AgentRunOptions): { command: string; args: string[] } {
    const args = ['--agent', options.prompt];
    return { command: this.command, args };
  }

  spawn(options: AgentRunOptions): ChildProcess {
    const { command, args } = this.buildCommand(options);
    return spawnAgent(command, args, options);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { command, args } = this.buildCommand(options);
    return runAgent(command, args, options);
  }
}
