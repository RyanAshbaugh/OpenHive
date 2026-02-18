import type { AgentAdapter } from './adapter.js';
import type { OpenHiveConfig } from '../config/schema.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { CursorAdapter } from './adapters/cursor.js';
import { logger } from '../utils/logger.js';

export interface AgentStatus {
  adapter: AgentAdapter;
  available: boolean;
  enabled: boolean;
}

function builtinAdapters(): AgentAdapter[] {
  return [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new GeminiAdapter(),
    new CursorAdapter(),
  ];
}

export class AgentRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private availability = new Map<string, boolean>();

  constructor() {
    for (const adapter of builtinAdapters()) {
      this.adapters.set(adapter.name, adapter);
    }
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getAll(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  async checkAll(config: OpenHiveConfig): Promise<AgentStatus[]> {
    const results: AgentStatus[] = [];

    for (const adapter of this.adapters.values()) {
      const agentConfig = config.agents[adapter.name];
      const enabled = agentConfig?.enabled ?? false;

      let available = false;
      if (enabled) {
        try {
          available = await adapter.checkAvailability();
        } catch {
          available = false;
        }
      }

      this.availability.set(adapter.name, available);
      logger.debug(`Agent ${adapter.name}: enabled=${enabled}, available=${available}`);
      results.push({ adapter, available, enabled });
    }

    return results;
  }

  isAvailable(name: string): boolean {
    return this.availability.get(name) ?? false;
  }

  getAvailable(config: OpenHiveConfig): AgentAdapter[] {
    return this.getAll().filter(a => {
      const agentConfig = config.agents[a.name];
      return (agentConfig?.enabled ?? false) && this.isAvailable(a.name);
    });
  }
}
