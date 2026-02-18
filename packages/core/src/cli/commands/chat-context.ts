/**
 * Conversation context manager for `openhive chat`.
 *
 * Since each agent invocation is a separate subprocess, we format
 * conversation history into the prompt. Backed by a JSON session file
 * at `.openhive/chat-session.json`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatSession {
  agent: string;
  turns: ChatTurn[];
  createdAt: string;
}

/** Max turns to keep in history before truncating oldest. */
const MAX_TURNS = 20;

export class ChatContext {
  private sessionFile: string;
  private session: ChatSession;

  constructor(agent: string, sessionDir?: string) {
    const dir = sessionDir ?? join(process.cwd(), '.openhive');
    this.sessionFile = join(dir, 'chat-session.json');
    this.session = {
      agent,
      turns: [],
      createdAt: new Date().toISOString(),
    };
  }

  get agent(): string {
    return this.session.agent;
  }

  get turns(): readonly ChatTurn[] {
    return this.session.turns;
  }

  /**
   * Append a turn to the conversation history and persist.
   */
  async appendTurn(role: 'user' | 'assistant', content: string): Promise<void> {
    this.session.turns.push({ role, content });

    // Truncate oldest turns if we exceed the limit
    if (this.session.turns.length > MAX_TURNS) {
      this.session.turns = this.session.turns.slice(-MAX_TURNS);
    }

    await this.save();
  }

  /**
   * Build a prompt that includes conversation history + new user message.
   */
  buildPrompt(newMessage: string): string {
    if (this.session.turns.length === 0) {
      return newMessage;
    }

    const historyLines: string[] = [
      'Here is our conversation so far:',
      '',
    ];

    for (const turn of this.session.turns) {
      const label = turn.role === 'user' ? 'User' : 'Assistant';
      historyLines.push(`${label}: ${turn.content}`);
      historyLines.push('');
    }

    historyLines.push('---');
    historyLines.push('');
    historyLines.push(`Now respond to this new message: ${newMessage}`);

    return historyLines.join('\n');
  }

  /**
   * Clear conversation history.
   */
  async clear(): Promise<void> {
    this.session.turns = [];
    await this.save();
  }

  /**
   * Switch to a different agent and clear history.
   */
  async switchAgent(name: string): Promise<void> {
    this.session.agent = name;
    this.session.turns = [];
    await this.save();
  }

  /**
   * Load an existing session from disk if available.
   */
  async load(): Promise<boolean> {
    try {
      const raw = await readFile(this.sessionFile, 'utf-8');
      const parsed = JSON.parse(raw) as ChatSession;
      this.session = parsed;
      return true;
    } catch {
      return false;
    }
  }

  private async save(): Promise<void> {
    try {
      const dir = this.sessionFile.replace(/\/[^/]+$/, '');
      await mkdir(dir, { recursive: true });
      await writeFile(this.sessionFile, JSON.stringify(this.session, null, 2), 'utf-8');
    } catch {
      // Best-effort persistence
    }
  }
}
