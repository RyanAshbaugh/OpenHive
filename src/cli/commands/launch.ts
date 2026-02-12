import { resolve, join } from 'node:path';
import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { parseSpec } from '../../specs/parser.js';
import { computeWaves, runSpec } from '../../specs/runner.js';
import { runSpecOrchestrated } from '../../orchestrator/spec-runner.js';
import { readSession } from '../../specs/session.js';
import { runVerification } from '../../verify/runner.js';
import { printSuccess, printError, printInfo, printWarning, printJson, isJsonOutput, printTable } from '../output.js';

export function registerLaunchCommand(program: Command): void {
  program
    .command('launch [spec-file]')
    .description('Launch a full project spec — dispatch tasks in waves, then verify')
    .option('--spec <path>', 'path to spec file (default: .openhive/spec.json5)')
    .option('--skip-verify', 'skip verification step')
    .option('--dry-run', 'show execution plan without dispatching')
    .option('--orchestrated', 'use persistent tmux sessions instead of subprocess dispatch')
    .action(async (specFile: string | undefined, options: {
      spec?: string;
      skipVerify?: boolean;
      dryRun?: boolean;
      orchestrated?: boolean;
    }) => {
      const specPath = resolve(specFile ?? options.spec ?? '.openhive/spec.json5');

      // Parse spec
      let spec;
      try {
        spec = await parseSpec(specPath);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput() && options.dryRun) {
        const waves = computeWaves(spec.tasks);
        printJson({
          name: spec.name,
          goal: spec.goal,
          waves: waves.map(w => ({
            wave: w.number,
            tasks: w.taskIds,
          })),
          verify: spec.verify ? {
            tests: spec.verify.tests ?? null,
            screenshots: spec.verify.screenshots?.length ?? 0,
          } : null,
        });
        return;
      }

      // Compute waves
      let waves;
      try {
        waves = computeWaves(spec.tasks);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const taskMap = new Map(spec.tasks.map(t => [t.id, t]));

      // Dry-run: print plan and exit
      if (options.dryRun) {
        console.log(chalk.bold(`\nProject: ${spec.name}`));
        console.log(chalk.gray(spec.goal));
        console.log(chalk.bold('\nExecution Plan:\n'));

        for (const wave of waves) {
          const taskNames = wave.taskIds.map(id => {
            const t = taskMap.get(id)!;
            const agentTag = t.agent ? chalk.gray(` (${t.agent})`) : '';
            return `${id}${agentTag}`;
          });
          const parallel = wave.taskIds.length > 1
            ? chalk.gray(` (parallel — ${wave.taskIds.length} agents)`)
            : '';
          console.log(`  Wave ${wave.number}: ${taskNames.join(', ')}${parallel}`);
        }

        if (spec.verify) {
          const parts: string[] = [];
          if (spec.verify.tests) parts.push(spec.verify.tests);
          if (spec.verify.screenshots?.length) {
            parts.push(`${spec.verify.screenshots.length} screenshots`);
          }
          console.log(`  Verify: ${parts.join(' + ')}`);
        }

        console.log('');
        return;
      }

      // Full run
      const ctx = await getContext();
      await ctx.registry.checkAll(ctx.config);

      const useOrchestrator = options.orchestrated || ctx.config.orchestrator?.enabled;
      const modeTag = useOrchestrator ? chalk.cyan(' (orchestrated)') : '';

      console.log(chalk.bold(`\nLaunching: ${spec.name}${modeTag}`));
      console.log(chalk.gray(`${spec.tasks.length} tasks in ${waves.length} waves\n`));

      // Run spec with inline progress
      const sessionDir = join(process.cwd(), '.openhive');
      let lastWave = 0;

      // Poll session.json for progress updates
      const progressInterval = setInterval(async () => {
        const session = await readSession(sessionDir);
        if (!session) return;
        if (session.currentWave > lastWave) {
          lastWave = session.currentWave;
          const wave = session.waves[session.currentWave - 1];
          const taskList = wave.tasks.map(t => {
            const agentTag = t.agent ? chalk.gray(` (${t.agent})`) : '';
            return `${t.specId}${agentTag}`;
          }).join(', ');
          console.log(chalk.dim(`  Wave ${session.currentWave}/${session.totalWaves}: ${taskList}...`));
        }
        // Print completed tasks within current wave
        const wave = session.waves[session.currentWave - 1];
        if (wave) {
          for (const t of wave.tasks) {
            if (t.status === 'completed' || t.status === 'failed') {
              const dot = t.status === 'completed' ? chalk.green('done') : chalk.red('failed');
              // Only print once — tracked by checking if we already printed for this wave/task
            }
          }
        }
      }, 500);

      let runResult;
      try {
        if (useOrchestrator) {
          const orchConfig = ctx.config.orchestrator ?? {};
          runResult = await runSpecOrchestrated(spec, {
            config: {
              maxWorkers: orchConfig.maxWorkers,
              autoApprove: orchConfig.autoApprove,
              tickIntervalMs: orchConfig.tickIntervalMs,
              stuckTimeoutMs: orchConfig.stuckTimeoutMs,
              llmEscalationTool: orchConfig.llmEscalationTool,
              llmContextLines: orchConfig.llmContextLines,
            },
            sessionDir,
            onEvent: (event) => {
              if (event.type === 'worker_created') {
                console.log(chalk.dim(`  Worker ${event.workerId} (${event.tool}) started`));
              }
            },
          });
        } else {
          runResult = await runSpec(spec, ctx.scheduler, ctx.queue, ctx.storage, { sessionDir });
        }
        clearInterval(progressInterval);
      } catch (err) {
        clearInterval(progressInterval);
        printError(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      // Print wave results
      console.log('');
      for (const wave of runResult.waves) {
        const status = wave.failed.length === 0
          ? chalk.green('done')
          : chalk.red(`${wave.failed.length} failed`);
        console.log(`  Wave ${wave.wave}: ${wave.taskIds.join(', ')} — ${status}`);
      }

      if (!runResult.success) {
        printError('\nSome tasks failed. Skipping verification.');
        process.exitCode = 1;
        return;
      }

      printSuccess(`All ${spec.tasks.length} tasks completed`);

      // Verification
      if (options.skipVerify || !spec.verify) {
        if (options.skipVerify) {
          printInfo('Verification skipped (--skip-verify)');
        }
        return;
      }

      console.log(chalk.bold('\nRunning verification...\n'));
      const verifySpinner = ora('Verifying...').start();

      let verifyResult;
      try {
        verifyResult = await runVerification({
          spec,
          cwd: process.cwd(),
          registry: ctx.registry,
          config: ctx.config,
        });
        verifySpinner.stop();
      } catch (err) {
        verifySpinner.stop();
        printError(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      // Print verification results
      if (verifyResult.tests) {
        if (verifyResult.tests.passed) {
          printSuccess('Tests passed');
        } else {
          printError(`Tests failed (exit ${verifyResult.tests.exitCode})`);
        }
      }

      if (verifyResult.screenshots.length > 0) {
        const rows = verifyResult.screenshots.map(ss => {
          const captureStatus = ss.screenshot.success ? 'captured' : 'failed';
          const assessStatus = ss.assessment
            ? (ss.assessment.passed ? chalk.green('PASS') : chalk.red('FAIL'))
            : chalk.gray('n/a');
          const detail = ss.assessment?.explanation?.split('\n')[0] ?? ss.screenshot.error ?? '';
          return [ss.name, ss.url, captureStatus, assessStatus, detail.slice(0, 60)];
        });

        printTable(
          ['Name', 'URL', 'Capture', 'Assessment', 'Detail'],
          rows,
        );
      }

      if (verifyResult.passed) {
        printSuccess('\nVerification passed');
      } else {
        printError('\nVerification failed');
        process.exitCode = 1;
      }

      if (isJsonOutput()) {
        printJson({
          launch: {
            spec: spec.name,
            success: runResult.success,
            waves: runResult.waves,
          },
          verify: {
            passed: verifyResult.passed,
            tests: verifyResult.tests,
            screenshots: verifyResult.screenshots.map(ss => ({
              name: ss.name,
              url: ss.url,
              captured: ss.screenshot.success,
              screenshotPath: ss.screenshot.path,
              passed: ss.assessment?.passed ?? null,
              explanation: ss.assessment?.explanation ?? null,
              agent: ss.assessment?.agent ?? null,
            })),
          },
        });
      }
    });
}
