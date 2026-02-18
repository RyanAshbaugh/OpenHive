import type { OpenHiveConfig } from '../config/schema.js';
import { loadConfig } from '../config/config.js';
import { AgentRegistry } from '../agents/registry.js';
import { TaskQueue } from '../tasks/queue.js';
import { TaskStorage } from '../tasks/storage.js';
import { PoolTracker } from '../pool/tracker.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { ProjectManager } from '../projects/manager.js';
import { setLogLevel } from '../utils/logger.js';
import { join } from 'node:path';
import { getGlobalConfigDir } from '../config/config.js';

export interface AppContext {
  config: OpenHiveConfig;
  registry: AgentRegistry;
  queue: TaskQueue;
  storage: TaskStorage;
  poolTracker: PoolTracker;
  scheduler: Scheduler;
  projectManager: ProjectManager;
}

let cachedContext: AppContext | null = null;

export async function getContext(): Promise<AppContext> {
  if (cachedContext) return cachedContext;

  const config = await loadConfig();
  setLogLevel(config.logLevel);

  const registry = new AgentRegistry();
  const queue = new TaskQueue();
  const storage = new TaskStorage(config.taskStorageDir);
  const poolTracker = new PoolTracker(config.pools, getGlobalConfigDir());
  await poolTracker.initUsageStore();
  const scheduler = new Scheduler(config, registry, queue, storage, poolTracker);
  const projectManager = new ProjectManager(join(getGlobalConfigDir(), 'projects'));

  // Load persisted tasks
  const tasks = await storage.loadAll();
  queue.loadAll(tasks);

  // Load persisted projects
  await projectManager.loadAll();

  cachedContext = { config, registry, queue, storage, poolTracker, scheduler, projectManager };
  return cachedContext;
}
