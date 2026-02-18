import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerChatCommand } from '../../src/cli/commands/chat.js';

vi.mock('../../src/agents/registry.js', () => ({
  AgentRegistry: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue({
      name: 'claude',
      checkAvailability: vi.fn().mockResolvedValue(true),
    }),
    getAll: vi.fn().mockReturnValue([{ name: 'claude' }]),
  })),
}));

vi.mock('../../src/agents/streaming.js', () => ({
  streamAgent: vi.fn().mockReturnValue({
    promise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    kill: vi.fn(),
  }),
}));

vi.mock('../../src/agents/stream-parsers.js', () => ({
  getStreamParserForAgent: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../src/cli/commands/chat-context.js', () => ({
  ChatContext: vi.fn().mockImplementation(() => ({
    agent: 'claude',
    turns: [],
    buildPrompt: vi.fn().mockReturnValue('test'),
    appendTurn: vi.fn().mockResolvedValue(undefined),
    switchAgent: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/cli/commands/self-heal.js', () => ({
  buildFixPrompt: vi.fn().mockReturnValue('fix this'),
}));

vi.mock('../../src/cli/context-sources.js', () => ({
  gatherContext: vi.fn().mockResolvedValue(null),
  readStdinIfPiped: vi.fn().mockResolvedValue(null),
  readTmuxPane: vi.fn().mockResolvedValue(''),
  readTaskLog: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/cli/context.js', () => ({
  getContext: vi.fn().mockResolvedValue({
    config: { taskStorageDir: '/tmp/tasks' },
  }),
}));

vi.mock('../../src/cli/output.js', () => ({
  printError: vi.fn(),
}));

describe('registerChatCommand', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride(); // Prevent Commander from calling process.exit
  });

  it('registers a "chat" command on the program', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    expect(chatCmd).toBeDefined();
  });

  it('sets the correct description', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    expect(chatCmd!.description()).toBe(
      'Interactive REPL for multi-turn conversation with an agent',
    );
  });

  it('registers the -a / --agent option', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    const agentOpt = chatCmd!.options.find(
      (o) => o.short === '-a' && o.long === '--agent',
    );
    expect(agentOpt).toBeDefined();
    expect(agentOpt!.description).toBe('starting agent (default: claude)');
  });

  it('registers the -f / --file option', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    const fileOpt = chatCmd!.options.find(
      (o) => o.short === '-f' && o.long === '--file',
    );
    expect(fileOpt).toBeDefined();
    expect(fileOpt!.description).toBe('initial context files');
  });

  it('registers the --context-from-tmux option', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    const tmuxOpt = chatCmd!.options.find(
      (o) => o.long === '--context-from-tmux',
    );
    expect(tmuxOpt).toBeDefined();
    expect(tmuxOpt!.description).toBe('initial context from a tmux pane');
  });

  it('registers the --context-from-task option', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    const taskOpt = chatCmd!.options.find(
      (o) => o.long === '--context-from-task',
    );
    expect(taskOpt).toBeDefined();
    expect(taskOpt!.description).toBe('initial context from a task log');
  });

  it('parses --agent option correctly', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    chatCmd!.parseOptions(['--agent', 'codex']);
    expect(chatCmd!.opts().agent).toBe('codex');
  });

  it('parses -a short option correctly', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    chatCmd!.parseOptions(['-a', 'gemini']);
    expect(chatCmd!.opts().agent).toBe('gemini');
  });

  it('parses --file option with multiple paths', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    chatCmd!.parseOptions(['-f', 'a.txt', '-f', 'b.txt']);
    expect(chatCmd!.opts().file).toEqual(['a.txt', 'b.txt']);
  });

  it('parses --context-from-tmux option correctly', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    chatCmd!.parseOptions(['--context-from-tmux', '%1']);
    expect(chatCmd!.opts().contextFromTmux).toBe('%1');
  });

  it('parses --context-from-task option correctly', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    chatCmd!.parseOptions(['--context-from-task', 'task-123']);
    expect(chatCmd!.opts().contextFromTask).toBe('task-123');
  });

  it('has exactly four options registered', () => {
    registerChatCommand(program);

    const chatCmd = program.commands.find((c) => c.name() === 'chat');
    expect(chatCmd!.options).toHaveLength(4);
  });
});
