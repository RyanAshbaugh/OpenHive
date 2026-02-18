/**
 * Orchestrated spec runner — executes project specs through persistent
 * tmux workers instead of the subprocess-based scheduler.
 *
 * Computes dependency waves, dispatches each wave through the Orchestrator,
 * waits for all tasks in a wave to complete before starting the next.
 */

import { Orchestrator } from './orchestrator.js';
import { computeWaves } from '../specs/runner.js';
import { createTask } from '../tasks/task.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { sleep } from './tmux.js';
import { writeSession } from '../specs/session.js';
import type { ProjectSpec } from '../specs/schema.js';
import type { OrchestratorConfig } from './types.js';
import type { TaskStorage } from '../tasks/storage.js';
import type { LaunchSession } from '../specs/session.js';
import type {
  SpecRunResult,
  WaveResult,
  Wave,
} from '../specs/runner.js';

export interface OrchestratedSpecOptions {
  /** Orchestrator config overrides */
  config?: Partial<OrchestratorConfig>;
  /** Directory for session state persistence */
  sessionDir?: string;
  /** Callback for orchestrator events */
  onEvent?: import('./types.js').OrchestratorEventHandler;
  /** Task storage for persisting task state to disk */
  taskStorage?: TaskStorage;
}

/**
 * Run a project spec through the orchestrator (persistent tmux workers).
 *
 * Unlike runSpec() which uses the scheduler (subprocess per task), this
 * function uses persistent interactive sessions. Agents accumulate context
 * across tasks within a wave and can be reused across waves.
 */
export async function runSpecOrchestrated(
  spec: ProjectSpec,
  options?: OrchestratedSpecOptions,
): Promise<SpecRunResult> {
  const waves = computeWaves(spec.tasks);
  const taskMap = new Map(spec.tasks.map(t => [t.id, t]));
  const specToInternalId = new Map<string, string>();
  const waveResults: WaveResult[] = [];
  let allSuccess = true;

  // Initialize session state
  const sessionDir = options?.sessionDir;
  const session: LaunchSession = {
    specName: spec.name,
    startedAt: new Date().toISOString(),
    totalWaves: waves.length,
    currentWave: 0,
    status: 'running',
    waves: waves.map(w => ({
      number: w.number,
      status: 'pending',
      tasks: w.taskIds.map(id => ({ specId: id, internalId: '', status: 'pending' as const })),
    })),
  };
  if (sessionDir) await writeSession(sessionDir, session);

  // Create orchestrator
  const orchestrator = new Orchestrator({
    config: options?.config,
    onEvent: options?.onEvent,
    taskStorage: options?.taskStorage,
  });

  try {
    for (const wave of waves) {
      logger.info(`Wave ${wave.number}: dispatching ${wave.taskIds.join(', ')} (orchestrated)`);

      // Update session: wave starting
      session.currentWave = wave.number;
      const sessionWave = session.waves[wave.number - 1];
      sessionWave.status = 'running';

      // Create internal tasks for this wave
      const waveTasks: Array<{ specId: string; internalId: string }> = [];

      for (let idx = 0; idx < wave.taskIds.length; idx++) {
        const specId = wave.taskIds[idx];
        const specTask = taskMap.get(specId)!;
        const internalId = generateId();
        specToInternalId.set(specId, internalId);

        // Update session
        sessionWave.tasks[idx].internalId = internalId;
        sessionWave.tasks[idx].status = 'running';
        if (specTask.agent) sessionWave.tasks[idx].agent = specTask.agent;

        const task = createTask(specTask.prompt, internalId, {
          agent: specTask.agent,
        });

        // Map spec-level dependsOn to internal task IDs for context affinity
        const depIds = specTask.dependsOn
          ?.map(depSpecId => specToInternalId.get(depSpecId))
          .filter((id): id is string => !!id);

        orchestrator.queueTask(task, depIds);
        waveTasks.push({ specId, internalId });
      }

      if (sessionDir) await writeSession(sessionDir, session);

      // Run orchestrator until all wave tasks complete or fail
      await runUntilWaveComplete(orchestrator, waveTasks.map(t => t.internalId));

      // Check results
      const completed: string[] = [];
      const failed: string[] = [];

      for (const { specId, internalId } of waveTasks) {
        const sessionTask = sessionWave.tasks.find(t => t.specId === specId);

        if (orchestrator.isTaskCompleted(internalId)) {
          completed.push(specId);
          if (sessionTask) sessionTask.status = 'completed';
        } else {
          failed.push(specId);
          allSuccess = false;
          const reason = orchestrator.getFailureReason(internalId) ?? 'unknown';
          logger.error(`Task "${specId}" failed: ${reason}`);
          if (sessionTask) sessionTask.status = 'failed';
        }
      }

      sessionWave.status = failed.length > 0 ? 'failed' : 'completed';
      if (sessionDir) await writeSession(sessionDir, session);

      waveResults.push({
        wave: wave.number,
        taskIds: wave.taskIds,
        completed,
        failed,
      });

      if (failed.length > 0) {
        logger.warn(`Wave ${wave.number} had failures, stopping dispatch`);
        break;
      }
    }
  } finally {
    // Always clean up
    await orchestrator.shutdown();
  }

  // Finalize session
  session.status = allSuccess ? 'completed' : 'failed';
  if (sessionDir) await writeSession(sessionDir, session);

  return {
    success: allSuccess,
    waves: waveResults,
    taskIdMap: specToInternalId,
  };
}

/**
 * Run the orchestrator tick loop until all specified tasks are complete or failed.
 */
async function runUntilWaveComplete(
  orchestrator: Orchestrator,
  taskIds: string[],
): Promise<void> {
  const maxIterations = 3600; // 2h at 2s ticks
  let iterations = 0;

  while (iterations < maxIterations) {
    await orchestrator.tick();

    // Check if all tasks in this wave are resolved
    const allResolved = taskIds.every(
      id => orchestrator.isTaskCompleted(id) || orchestrator.isTaskFailed(id),
    );

    if (allResolved) return;

    await sleep(2000);
    iterations++;
  }

  logger.error('Wave timed out after maximum iterations');
}
