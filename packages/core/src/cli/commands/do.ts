/**
 * `openhive do <prompt>` — quick one-off agent dispatch with live streaming.
 *
 * No task persistence, no worktree, no spinner. Just dispatch and stream.
 */

import type { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry.js';
import { streamAgent } from '../../agents/streaming.js';
import { getStreamParserForAgent } from '../../agents/stream-parsers.js';
import { gatherContext, readStdinIfPiped } from '../context-sources.js';
import { getContext } from '../context.js';
import { printError } from '../output.js';
import { getPreset } from '../../agents/permissions.js';

export function registerDoCommand(program: Command): void {
  program
    .command('do <prompt>')
    .description('Quick one-off: dispatch a prompt to an agent and stream output live')
    .option('-a, --agent <name>', 'agent to use (default: claude)')
    .option('-f, --file <path...>', 'context files to include')
    .option('--context-from-tmux <target>', 'read context from a tmux pane')
    .option('--context-from-task <id>', 'read context from a previous task log')
    .option('--timeout <ms>', 'timeout in milliseconds', parseInt)
    .action(async (prompt: string, options: {
      agent?: string;
      file?: string[];
      contextFromTmux?: string;
      contextFromTask?: string;
      timeout?: number;
    }) => {
      const agentName = options.agent ?? 'claude';
      const registry = new AgentRegistry();
      const adapter = registry.get(agentName);

      if (!adapter) {
        printError(`Unknown agent: ${agentName}. Available: ${registry.getAll().map(a => a.name).join(', ')}`);
        process.exitCode = 1;
        return;
      }

      // Check availability
      const available = await adapter.checkAvailability();
      if (!available) {
        printError(`Agent "${agentName}" is not installed or not in PATH`);
        process.exitCode = 1;
        return;
      }

      // Gather context from all sources
      // Read stdin before starting readline (must be done first)
      const stdinText = await readStdinIfPiped();

      let storageDir: string | undefined;
      if (options.contextFromTask) {
        const ctx = await getContext();
        storageDir = ctx.config.taskStorageDir;
      }

      const context = await gatherContext({
        stdinText,
        files: options.file,
        tmuxTarget: options.contextFromTmux,
        taskId: options.contextFromTask,
        storageDir,
      });

      // Build the full prompt with context prepended
      const fullPrompt = context
        ? `${context}\n\n${prompt}`
        : prompt;

      // Get the stream parser for this adapter
      const streamParser = getStreamParserForAgent(agentName);

      // Stream the agent's output live
      const { promise, kill } = streamAgent({
        adapter,
        runOptions: {
          prompt: fullPrompt,
          cwd: process.cwd(),
          contextFiles: options.file,
          timeout: options.timeout,
          streamParser,
          permissions: getPreset('full-auto'),
        },
        output: process.stdout,
      });

      // Handle Ctrl-C: kill the agent subprocess
      const sigintHandler = () => {
        kill();
      };
      process.on('SIGINT', sigintHandler);

      try {
        const result = await promise;
        process.exitCode = result.exitCode;

        if (result.exitCode !== 0 && !result.stdout && !result.stderr) {
          printError(`Agent exited with code ${result.exitCode} and produced no output`);
        }
      } finally {
        process.removeListener('SIGINT', sigintHandler);
      }
    });
}
