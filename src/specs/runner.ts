import type { ProjectSpec, TaskSpec } from './schema.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { TaskQueue } from '../tasks/queue.js';
import type { TaskStorage } from '../tasks/storage.js';
import { createTask } from '../tasks/task.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';

export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

export interface Wave {
  /** Wave number (1-based) */
  number: number;
  /** Task spec IDs in this wave */
  taskIds: string[];
}

/** Topological sort of tasks into parallel execution waves */
export function computeWaves(tasks: TaskSpec[]): Wave[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const completed = new Set<string>();
  const waves: Wave[] = [];
  let remaining = new Set(tasks.map(t => t.id));

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      const task = taskMap.get(id)!;
      const deps = task.dependsOn ?? [];
      if (deps.every(d => completed.has(d))) {
        ready.push(id);
      }
    }

    if (ready.length === 0) {
      const stuck = [...remaining].join(', ');
      throw new CycleError(`Dependency cycle detected among tasks: ${stuck}`);
    }

    waves.push({ number: waves.length + 1, taskIds: ready });
    for (const id of ready) {
      completed.add(id);
      remaining.delete(id);
    }
  }

  return waves;
}

export interface SpecRunResult {
  /** Whether all tasks completed successfully */
  success: boolean;
  /** Wave execution details */
  waves: WaveResult[];
  /** Map from spec task ID to internal task ID */
  taskIdMap: Map<string, string>;
}

export interface WaveResult {
  wave: number;
  taskIds: string[];
  /** Spec task IDs that completed successfully */
  completed: string[];
  /** Spec task IDs that failed */
  failed: string[];
}

/** Run a project spec through wave-based dispatch */
export async function runSpec(
  spec: ProjectSpec,
  scheduler: Scheduler,
  queue: TaskQueue,
  storage: TaskStorage,
): Promise<SpecRunResult> {
  const waves = computeWaves(spec.tasks);
  const taskMap = new Map(spec.tasks.map(t => [t.id, t]));
  const specToInternalId = new Map<string, string>();
  const waveResults: WaveResult[] = [];
  let allSuccess = true;

  for (const wave of waves) {
    logger.info(`Wave ${wave.number}: dispatching ${wave.taskIds.join(', ')}`);

    // Create internal tasks for this wave
    const internalTasks = wave.taskIds.map(specId => {
      const specTask = taskMap.get(specId)!;
      const internalId = generateId();
      specToInternalId.set(specId, internalId);

      const task = createTask(specTask.prompt, internalId, {
        agent: specTask.agent,
      });
      queue.add(task);
      storage.save(task);
      return { specId, internalId, task };
    });

    // Dispatch all tasks in this wave in parallel
    await Promise.all(
      internalTasks.map(({ task }) => scheduler.dispatchTask(task))
    );

    // Check results
    const completed: string[] = [];
    const failed: string[] = [];

    for (const { specId, internalId } of internalTasks) {
      const result = queue.get(internalId);
      if (result?.status === 'completed') {
        completed.push(specId);
      } else {
        failed.push(specId);
        allSuccess = false;
        logger.error(`Task "${specId}" failed: ${result?.error ?? 'unknown error'}`);
      }
    }

    waveResults.push({
      wave: wave.number,
      taskIds: wave.taskIds,
      completed,
      failed,
    });

    // If any task in this wave failed, stop dispatching subsequent waves
    if (failed.length > 0) {
      logger.warn(`Wave ${wave.number} had failures, stopping dispatch`);
      break;
    }
  }

  return {
    success: allSuccess,
    waves: waveResults,
    taskIdMap: specToInternalId,
  };
}
