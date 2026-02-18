import type { ChildProcess } from 'node:child_process';
import type { InteractionMode } from '../config/schema.js';
import type { ResolvedPermissions } from './permissions.js';

export interface AgentCapabilities {
  vision: boolean;
  streaming: boolean;
  headless: boolean;
}

/** Parse a JSONL line from streaming output into human-readable text */
export type StreamParser = (line: string) => string | null;

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  contextFiles?: string[];
  timeout?: number;
  logFile?: string;
  /** When set, stdout is treated as JSONL. Each line is parsed to extract readable text for the log file and stdout accumulator. */
  streamParser?: StreamParser;
  /** Resolved permissions for this run */
  permissions?: ResolvedPermissions;
}

export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface AgentAdapter {
  /** Unique name for this adapter */
  name: string;

  /** Display name */
  displayName: string;

  /** Which provider's token pool this uses */
  provider: string;

  /** CLI command to check/invoke */
  command: string;

  /** Supported interaction modes */
  supportedModes: InteractionMode[];

  /** Agent capabilities */
  capabilities: AgentCapabilities;

  /** Check if the agent CLI is available */
  checkAvailability(): Promise<boolean>;

  /** Build the full command + args for a task */
  buildCommand(options: AgentRunOptions): { command: string; args: string[] };

  /** Spawn the agent as a subprocess */
  spawn(options: AgentRunOptions): ChildProcess;

  /** Run the agent and wait for completion */
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}
