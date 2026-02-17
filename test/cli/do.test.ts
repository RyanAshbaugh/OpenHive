import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

vi.mock('../../src/agents/registry.js', () => {
  const mockGet = vi.fn();
  const mockGetAll = vi.fn(() => []);

  class AgentRegistry {
    get = mockGet;
    getAll = mockGetAll;
  }

  return { AgentRegistry };
});

vi.mock('../../src/agents/streaming.js', () => ({
  streamAgent: vi.fn(),
}));

vi.mock('../../src/agents/stream-parsers.js', () => ({
  getStreamParserForAgent: vi.fn(() => undefined),
}));

vi.mock('../../src/cli/context-sources.js', () => ({
  readStdinIfPiped: vi.fn(async () => null),
  gatherContext: vi.fn(async () => ''),
}));

vi.mock('../../src/cli/context.js', () => ({
  getContext: vi.fn(),
}));

vi.mock('../../src/cli/output.js', () => ({
  printError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so we get the mocked versions
// ---------------------------------------------------------------------------

import { registerDoCommand } from '../../src/cli/commands/do.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { streamAgent } from '../../src/agents/streaming.js';
import { readStdinIfPiped, gatherContext } from '../../src/cli/context-sources.js';
import { printError } from '../../src/cli/output.js';

// Typed references to mocked functions
const mockedStreamAgent = vi.mocked(streamAgent);
const mockedReadStdinIfPiped = vi.mocked(readStdinIfPiped);
const mockedGatherContext = vi.mocked(gatherContext);
const mockedPrintError = vi.mocked(printError);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAdapter(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    provider: 'anthropic',
    command: 'claude',
    supportedModes: ['one-shot'],
    capabilities: { vision: false, streaming: true, headless: true },
    checkAvailability: vi.fn(async () => true),
    buildCommand: vi.fn(() => ({ command: 'claude', args: ['-p', 'test'] })),
    spawn: vi.fn(),
    run: vi.fn(),
    ...overrides,
  };
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerDoCommand(program);
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openhive do', () => {
  let savedExitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('prints an error and sets exitCode=1 when the agent name is unknown', async () => {
    // Registry returns undefined for an unknown agent
    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(undefined);
    vi.mocked(registry.getAll).mockReturnValue([]);

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'hello world', '-a', 'nonexistent']);

    expect(mockedPrintError).toHaveBeenCalledOnce();
    expect(mockedPrintError.mock.calls[0][0]).toMatch(/Unknown agent: nonexistent/);
    expect(process.exitCode).toBe(1);
    expect(mockedStreamAgent).not.toHaveBeenCalled();
  });

  it('prints an error and sets exitCode=1 when the agent is not available', async () => {
    const adapter = makeMockAdapter({
      checkAvailability: vi.fn(async () => false),
    });

    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(adapter as never);

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'hello world', '-a', 'claude']);

    expect(adapter.checkAvailability).toHaveBeenCalledOnce();
    expect(mockedPrintError).toHaveBeenCalledOnce();
    expect(mockedPrintError.mock.calls[0][0]).toMatch(/not installed or not in PATH/);
    expect(process.exitCode).toBe(1);
    expect(mockedStreamAgent).not.toHaveBeenCalled();
  });

  it('calls streamAgent with the correct arguments on successful dispatch', async () => {
    const adapter = makeMockAdapter();

    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(adapter as never);

    mockedReadStdinIfPiped.mockResolvedValue(null);
    mockedGatherContext.mockResolvedValue('');
    mockedStreamAgent.mockReturnValue({
      promise: Promise.resolve({ exitCode: 0, stdout: 'done', stderr: '', durationMs: 100 }),
      kill: vi.fn(),
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'fix the bug']);

    expect(mockedStreamAgent).toHaveBeenCalledOnce();

    const callArgs = mockedStreamAgent.mock.calls[0][0];
    expect(callArgs.adapter).toBe(adapter);
    expect(callArgs.runOptions.prompt).toBe('fix the bug');
    expect(callArgs.runOptions.cwd).toBe(process.cwd());
    expect(callArgs.output).toBe(process.stdout);
    expect(process.exitCode).toBe(0);
  });

  it('prepends gathered context to the prompt', async () => {
    const adapter = makeMockAdapter();

    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(adapter as never);

    mockedReadStdinIfPiped.mockResolvedValue(null);
    mockedGatherContext.mockResolvedValue('[file: foo.ts]\nconst x = 1;\n[/file]');
    mockedStreamAgent.mockReturnValue({
      promise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 50 }),
      kill: vi.fn(),
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'explain this', '-f', 'foo.ts']);

    const callArgs = mockedStreamAgent.mock.calls[0][0];
    expect(callArgs.runOptions.prompt).toContain('[file: foo.ts]');
    expect(callArgs.runOptions.prompt).toContain('explain this');
    expect(callArgs.runOptions.contextFiles).toEqual(['foo.ts']);
  });

  it('forwards the exit code from the agent result', async () => {
    const adapter = makeMockAdapter();

    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(adapter as never);

    mockedReadStdinIfPiped.mockResolvedValue(null);
    mockedGatherContext.mockResolvedValue('');
    mockedStreamAgent.mockReturnValue({
      promise: Promise.resolve({ exitCode: 2, stdout: '', stderr: 'err', durationMs: 10 }),
      kill: vi.fn(),
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'do something']);

    expect(process.exitCode).toBe(2);
  });

  it('defaults to the claude agent when --agent is not specified', async () => {
    const adapter = makeMockAdapter({ name: 'claude' });

    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(adapter as never);

    mockedReadStdinIfPiped.mockResolvedValue(null);
    mockedGatherContext.mockResolvedValue('');
    mockedStreamAgent.mockReturnValue({
      promise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 10 }),
      kill: vi.fn(),
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'hello']);

    // registry.get should have been called with 'claude' (the default)
    expect(vi.mocked(registry.get)).toHaveBeenCalledWith('claude');
  });

  it('passes the timeout option through to streamAgent', async () => {
    const adapter = makeMockAdapter();

    const registry = new AgentRegistry();
    vi.mocked(registry.get).mockReturnValue(adapter as never);

    mockedReadStdinIfPiped.mockResolvedValue(null);
    mockedGatherContext.mockResolvedValue('');
    mockedStreamAgent.mockReturnValue({
      promise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 10 }),
      kill: vi.fn(),
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'openhive', 'do', 'hello', '--timeout', '5000']);

    const callArgs = mockedStreamAgent.mock.calls[0][0];
    expect(callArgs.runOptions.timeout).toBe(5000);
  });
});
