/**
 * `openhive chat` — interactive REPL for multi-turn conversations with agents.
 *
 * Features:
 * - Multi-turn conversation with history formatted into each prompt
 * - Live-streaming agent output
 * - Slash commands: /agent, /heal, /status, /clear, /context, /quit
 * - Ctrl-C kills current agent subprocess; double Ctrl-C exits
 */

import type { Command } from 'commander';
import * as readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentRegistry } from '../../agents/registry.js';
import { streamAgent } from '../../agents/streaming.js';
import { getStreamParserForAgent } from '../../agents/stream-parsers.js';
import { buildFixPrompt } from './self-heal.js';
import { ChatContext } from './chat-context.js';
import { gatherContext, readStdinIfPiped, readTmuxPane, readTaskLog } from '../context-sources.js';
import { getContext } from '../context.js';
import { printError } from '../output.js';
import { getPreset } from '../../agents/permissions.js';

const execFileAsync = promisify(execFile);

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Interactive REPL for multi-turn conversation with an agent')
    .option('-a, --agent <name>', 'starting agent (default: claude)')
    .option('-f, --file <path...>', 'initial context files')
    .option('--context-from-tmux <target>', 'initial context from a tmux pane')
    .option('--context-from-task <id>', 'initial context from a task log')
    .action(async (options: {
      agent?: string;
      file?: string[];
      contextFromTmux?: string;
      contextFromTask?: string;
    }) => {
      const agentName = options.agent ?? 'claude';
      const registry = new AgentRegistry();

      // Validate agent
      const adapter = registry.get(agentName);
      if (!adapter) {
        printError(`Unknown agent: ${agentName}. Available: ${registry.getAll().map(a => a.name).join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const available = await adapter.checkAvailability();
      if (!available) {
        printError(`Agent "${agentName}" is not installed or not in PATH`);
        process.exitCode = 1;
        return;
      }

      // Initialize conversation context
      const chatCtx = new ChatContext(agentName);

      // Gather initial context if provided
      let storageDir: string | undefined;
      if (options.contextFromTask) {
        const ctx = await getContext();
        storageDir = ctx.config.taskStorageDir;
      }

      const initialContext = await gatherContext({
        files: options.file,
        tmuxTarget: options.contextFromTmux,
        taskId: options.contextFromTask,
        storageDir,
      });

      if (initialContext) {
        // Store initial context as a system turn
        await chatCtx.appendTurn('user', `[initial context]\n${initialContext}`);
      }

      // Start the REPL
      await runRepl(registry, chatCtx);
    });
}

async function runRepl(registry: AgentRegistry, chatCtx: ChatContext): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // Prompts go to stderr so stdout is clean for agent output
    prompt: `${chatCtx.agent}> `,
    terminal: true,
  });

  let currentKill: (() => void) | null = null;
  let lastCtrlC = 0;

  console.error(`OpenHive Chat — agent: ${chatCtx.agent}`);
  console.error('Type a message, or use /help for commands. Ctrl-D to exit.\n');

  rl.prompt();

  rl.on('SIGINT', () => {
    if (currentKill) {
      // Kill the running agent subprocess
      currentKill();
      currentKill = null;
      console.error('\n[agent interrupted]');
      rl.prompt();
      return;
    }

    // Double Ctrl-C to exit
    const now = Date.now();
    if (now - lastCtrlC < 1000) {
      console.error('\nBye!');
      rl.close();
      return;
    }
    lastCtrlC = now;
    console.error('\n(Press Ctrl-C again to exit, or type a message)');
    rl.prompt();
  });

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }

    // Handle slash commands
    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, registry, chatCtx, rl);
      if (handled === 'quit') {
        rl.close();
        return;
      }
      rl.prompt();
      continue;
    }

    // Regular message — send to agent
    const adapterName = chatCtx.agent;
    const adapter = registry.get(adapterName);
    if (!adapter) {
      console.error(`Agent "${adapterName}" not found. Use /agent <name> to switch.`);
      rl.prompt();
      continue;
    }

    // Build prompt with conversation history
    const prompt = chatCtx.buildPrompt(input);
    await chatCtx.appendTurn('user', input);

    const streamParser = getStreamParserForAgent(adapterName);

    // Stream agent output
    let responseText = '';
    const { promise, kill } = streamAgent({
      adapter,
      runOptions: {
        prompt,
        cwd: process.cwd(),
        streamParser,
        permissions: getPreset('full-auto'),
      },
      output: process.stdout,
      onChunk: (chunk) => {
        responseText += chunk;
      },
    });

    currentKill = kill;

    try {
      const result = await promise;
      currentKill = null;

      // Store the agent's response in conversation history
      if (responseText.trim()) {
        // Truncate long responses to keep history manageable
        const truncated = responseText.length > 2000
          ? responseText.slice(0, 2000) + '...(truncated)'
          : responseText;
        await chatCtx.appendTurn('assistant', truncated.trim());
      }

      if (result.exitCode !== 0 && result.stderr.trim()) {
        console.error(`\n[agent exited with code ${result.exitCode}]`);
      }
    } catch {
      currentKill = null;
      console.error('\n[agent error]');
    }

    // Ensure newline after agent output
    process.stdout.write('\n');
    rl.prompt();
  }

  // EOF (Ctrl-D)
  console.error('\nBye!');
}

async function handleSlashCommand(
  input: string,
  registry: AgentRegistry,
  chatCtx: ChatContext,
  rl: readline.Interface,
): Promise<'quit' | void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/quit':
    case '/exit':
    case '/q':
      console.error('Bye!');
      return 'quit';

    case '/agent': {
      if (!arg) {
        console.error(`Current agent: ${chatCtx.agent}`);
        console.error(`Available: ${registry.getAll().map(a => a.name).join(', ')}`);
        return;
      }
      const adapter = registry.get(arg);
      if (!adapter) {
        console.error(`Unknown agent: ${arg}. Available: ${registry.getAll().map(a => a.name).join(', ')}`);
        return;
      }
      await chatCtx.switchAgent(arg);
      rl.setPrompt(`${arg}> `);
      console.error(`Switched to ${arg}. Conversation history cleared.`);
      return;
    }

    case '/heal': {
      if (!arg) {
        console.error('Usage: /heal <command>  — run a command; on failure, send error to agent');
        return;
      }
      console.error(`Running: ${arg}`);
      try {
        const { stdout } = await execFileAsync('sh', ['-c', arg], {
          cwd: process.cwd(),
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        console.error('Command succeeded.');
        if (stdout.trim()) {
          console.error(stdout.trim().slice(0, 500));
        }
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number };
        const stdout = execErr.stdout ?? '';
        const stderr = execErr.stderr ?? '';
        console.error(`Command failed (exit ${execErr.code ?? 1}). Sending error to agent...`);

        // Build fix prompt and dispatch to agent
        const fixPrompt = buildFixPrompt(stdout, stderr);
        const fullPrompt = chatCtx.buildPrompt(fixPrompt);
        await chatCtx.appendTurn('user', `[/heal ${arg}]\n${fixPrompt.slice(0, 500)}`);

        const adapter = registry.get(chatCtx.agent);
        if (!adapter) return;

        const streamParser = getStreamParserForAgent(chatCtx.agent);
        let responseText = '';
        const { promise } = streamAgent({
          adapter,
          runOptions: {
            prompt: fullPrompt,
            cwd: process.cwd(),
            streamParser,
            permissions: getPreset('full-auto'),
          },
          output: process.stdout,
          onChunk: (chunk) => { responseText += chunk; },
        });

        await promise;
        if (responseText.trim()) {
          const truncated = responseText.length > 2000
            ? responseText.slice(0, 2000) + '...(truncated)'
            : responseText;
          await chatCtx.appendTurn('assistant', truncated.trim());
        }
        process.stdout.write('\n');
      }
      return;
    }

    case '/status': {
      console.error(`Agent: ${chatCtx.agent}`);
      console.error(`Turns in history: ${chatCtx.turns.length}`);
      const available: string[] = [];
      for (const a of registry.getAll()) {
        const ok = await a.checkAvailability();
        available.push(`${a.name}${ok ? ' (available)' : ' (not found)'}`);
      }
      console.error(`Agents: ${available.join(', ')}`);
      return;
    }

    case '/clear':
      await chatCtx.clear();
      console.error('Conversation history cleared.');
      return;

    case '/context': {
      if (!arg) {
        console.error('Usage: /context <path|tmux:target|task:id>');
        return;
      }

      let contextText = '';
      if (arg.startsWith('tmux:')) {
        const target = arg.slice(5);
        try {
          contextText = await readTmuxPane(target);
          console.error(`Added tmux context from ${target} (${contextText.length} chars)`);
        } catch (err) {
          console.error(`Failed to read tmux pane: ${err}`);
          return;
        }
      } else if (arg.startsWith('task:')) {
        const taskId = arg.slice(5);
        try {
          const ctx = await getContext();
          contextText = await readTaskLog(taskId, ctx.config.taskStorageDir);
          console.error(`Added task context from ${taskId} (${contextText.length} chars)`);
        } catch (err) {
          console.error(`Failed to read task log: ${err}`);
          return;
        }
      } else {
        // File path
        try {
          contextText = await readFile(arg, 'utf-8');
          console.error(`Added file context from ${arg} (${contextText.length} chars)`);
        } catch (err) {
          console.error(`Failed to read file: ${err}`);
          return;
        }
      }

      await chatCtx.appendTurn('user', `[context: ${arg}]\n${contextText.trim()}`);
      return;
    }

    case '/help':
      console.error([
        'Slash commands:',
        '  /agent <name>   — switch agent (clears history)',
        '  /heal <command> — run command; on failure, send error to agent',
        '  /status         — show agent and pool status',
        '  /clear          — clear conversation history',
        '  /context <src>  — add context: file path, tmux:<target>, task:<id>',
        '  /quit           — exit',
        '',
        'Ctrl-C interrupts running agent. Double Ctrl-C exits.',
      ].join('\n'));
      return;

    default:
      console.error(`Unknown command: ${cmd}. Type /help for available commands.`);
      return;
  }
}
