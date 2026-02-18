import type { AgentAdapter } from '../agents/adapter.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { OpenHiveConfig } from '../config/schema.js';
import type { PoolTracker } from '../pool/tracker.js';
import type { Task } from '../tasks/task.js';
import { logger } from '../utils/logger.js';

export interface DispatchDecision {
  task: Task;
  agent: AgentAdapter;
}

export class Dispatcher {
  constructor(
    private registry: AgentRegistry,
    private poolTracker: PoolTracker,
    private config: OpenHiveConfig,
  ) {}

  /** Find the best agent for a task */
  selectAgent(task: Task): AgentAdapter | null {
    // If task specifies an agent, use that
    if (task.agent) {
      const adapter = this.registry.get(task.agent);
      if (adapter && this.registry.isAvailable(task.agent)) {
        if (this.poolTracker.canDispatch(adapter.provider)) {
          return adapter;
        }
        logger.warn(`Agent ${task.agent} pool is at capacity`);
      }
      return null;
    }

    // If config specifies a default agent, try that first
    if (this.config.defaultAgent) {
      const adapter = this.registry.get(this.config.defaultAgent);
      if (adapter && this.registry.isAvailable(this.config.defaultAgent)) {
        if (this.poolTracker.canDispatch(adapter.provider)) {
          return adapter;
        }
      }
    }

    // Otherwise, pick the first available agent with pool capacity
    const available = this.registry.getAvailable(this.config);
    for (const adapter of available) {
      if (this.poolTracker.canDispatch(adapter.provider)) {
        return adapter;
      }
    }

    return null;
  }

  /** Match pending tasks to available agents */
  matchTasks(pendingTasks: Task[]): DispatchDecision[] {
    const decisions: DispatchDecision[] = [];

    for (const task of pendingTasks) {
      const agent = this.selectAgent(task);
      if (agent) {
        decisions.push({ task, agent });
      }
    }

    return decisions;
  }
}
