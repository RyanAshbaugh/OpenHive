import { resolve } from 'node:path';
import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { parseSpec } from '../../specs/parser.js';
import { computeWaves, runSpec } from '../../specs/runner.js';
import { runVerification } from '../../verify/runner.js';
import { printSuccess, printError, printInfo, printWarning, printJson, isJsonOutput, printTable } from '../output.js';

export function registerLaunchCommand(program: Command): void {
  program
    .command('launch [spec-file]')
    .description('Launch a full project spec — dispatch tasks in waves, then verify')
    .option('--spec <path>', 'path to spec file (default: .openhive/spec.json5)')
    .option('--skip-verify', 'skip verification step')
    .option('--dry-run', 'show execution plan without dispatching')
    .action(async (specFile: string | undefined, options: {
      spec?: string;
      skipVerify?: boolean;
      dryRun?: boolean;
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

      console.log(chalk.bold(`\nLaunching: ${spec.name}`));
      console.log(chalk.gray(`${spec.tasks.length} tasks in ${waves.length} waves\n`));

      // Run spec
      const spinner = ora('Dispatching tasks...').start();
      let runResult;
      try {
        spinner.text = `Wave 1 of ${waves.length}...`;
        runResult = await runSpec(spec, ctx.scheduler, ctx.queue, ctx.storage);
        spinner.stop();
      } catch (err) {
        spinner.stop();
        printError(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      // Print wave results
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
