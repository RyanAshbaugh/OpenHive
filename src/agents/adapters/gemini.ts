import type { ChildProcess } from 'node:child_process';
import type { AgentAdapter, AgentCapabilities, AgentRunOptions, AgentRunResult } from '../adapter.js';
import type { InteractionMode } from '../../config/schema.js';
import { commandExists } from '../../utils/process.js';
import { spawnAgent, runAgent } from '../subprocess.js';
import { geminiStreamParser } from '../stream-parsers.js';

export class GeminiAdapter implements AgentAdapter {
  name = 'gemini';
  displayName = 'Gemini CLI';
  provider = 'google';
  command = 'gemini';
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
    return { command: this.command, args };
  }

  spawn(options: AgentRunOptions): ChildProcess {
    const { command, args } = this.buildCommand(options);
    return spawnAgent(command, args, options);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { command, args } = this.buildCommand(options);
    return runAgent(command, args, { ...options, streamParser: geminiStreamParser });
  }
}
