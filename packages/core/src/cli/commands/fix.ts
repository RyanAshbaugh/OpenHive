/**
 * `openhive fix` — self-heal as a first-class CLI command.
 *
 * Mode A (default): Run a command, auto-fix on failure, retry.
 *   openhive fix "npx vitest run"
 *   openhive fix -c "npx vitest run" --retries 5
 *
 * Mode B: Grab failure context from a tmux pane, dispatch a single fix.
 *   openhive fix --context-from-tmux hive:0.3
 */

import type { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Orchestrator } from '../../orchestrator/orchestrator.js';
import { createTask } from '../../tasks/task.js';
import { TaskStorage } from '../../tasks/storage.js';
import { runWithSelfHealing, buildFixPrompt } from './self-heal.js';
import { readTmuxPane } from '../context-sources.js';
import { printSuccess, printError, printInfo } from '../output.js';

const DEFAULT_TASK_STORAGE_DIR = join(homedir(), '.openhive', 'tasks');

export function registerFixCommand(program: Command): void {
  program
    .command('fix [command]')
    .description('Run a command and auto-fix failures, or fix from tmux context')
    .option('-c, --command <cmd>', 'command to run (alternative to positional arg)')
    .option('-a, --agent <name>', 'agent to use for fixes', 'claude')
    .option('--retries <n>', 'max fix attempts', parseInt, 3)
    .option('--timeout <ms>', 'timeout per test run in ms', parseInt, 120_000)
    .option('--context-from-tmux <target>', 'grab failure context from a tmux pane and dispatch a fix')
    .action(async (positionalCmd: string | undefined, options: {
      command?: string;
      agent: string;
      retries: number;
      timeout: number;
      contextFromTmux?: string;
    }) => {
      // Mode B: context-from-tmux — grab pane content, dispatch single fix
      if (options.contextFromTmux) {
        await fixFromTmux(options.contextFromTmux, options.agent);
        return;
      }

      // Mode A: run-and-heal
      const cmdString = positionalCmd ?? options.command;
      if (!cmdString) {
        printError('Provide a command to run: openhive fix "npx vitest run"');
        process.exitCode = 1;
        return;
      }

      const parts = cmdString.split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      printInfo(`Running with self-heal: ${cmdString}`);

      const result = await runWithSelfHealing({
        command,
        args,
        cwd: process.cwd(),
        agent: options.agent,
        maxRetries: options.retries,
        testTimeout: options.timeout,
      });

      if (result.success) {
        printSuccess(`Tests passed after ${result.attempts} attempt(s)`);
      } else {
        printError(`Failed after ${result.attempts} attempt(s)`);
        process.exitCode = 1;
      }
    });
}

async function fixFromTmux(target: string, agentName: string): Promise<void> {
  printInfo(`Capturing context from tmux pane: ${target}`);

  let paneContent: string;
  try {
    paneContent = await readTmuxPane(target);
  } catch (err) {
    printError(`Failed to capture tmux pane "${target}": ${err}`);
    process.exitCode = 1;
    return;
  }

  if (!paneContent) {
    printError('Tmux pane was empty — nothing to fix');
    process.exitCode = 1;
    return;
  }

  const prompt = buildFixPrompt(paneContent, '');
  const cwd = process.cwd();

  printInfo(`Dispatching fix to ${agentName} via orchestrator...`);

  const taskStorage = new TaskStorage(DEFAULT_TASK_STORAGE_DIR);
  const orchestrator = new Orchestrator({
    config: {
      maxWorkers: 1,
      autoApprove: true,
      tickIntervalMs: 2000,
      useWorktrees: false,
      repoRoot: cwd,
      stuckTimeoutMs: 180_000,
      taskTimeoutMs: 300_000,
    },
    taskStorage,
    onEvent: (e) => printInfo(`Fix [${e.type}]`),
  });

  const task = createTask(prompt, 'tmux-fix', { agent: agentName });
  orchestrator.queueTask(task);
  await orchestrator.start();

  const succeeded = orchestrator.isTaskCompleted(task.id);
  const failReason = orchestrator.getFailureReason(task.id);
  await orchestrator.shutdown();

  if (succeeded) {
    printSuccess('Agent completed fix');
  } else {
    printError(`Agent fix failed${failReason ? `: ${failReason}` : ''}`);
    process.exitCode = 1;
  }
}
