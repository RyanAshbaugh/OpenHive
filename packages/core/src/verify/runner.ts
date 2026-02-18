import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ProjectSpec } from '../specs/schema.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { OpenHiveConfig } from '../config/schema.js';
import { exec, spawnProcess } from '../utils/process.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot, type ScreenshotResult } from './screenshot.js';
import { assessScreenshot, type AssessmentResult } from './assess.js';

export interface TestResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

export interface ScreenshotVerifyResult {
  name: string;
  url: string;
  screenshot: ScreenshotResult;
  assessment?: AssessmentResult;
}

export interface VerifyResult {
  /** Overall pass/fail */
  passed: boolean;
  /** Test results (if tests were configured) */
  tests?: TestResult;
  /** Screenshot verification results */
  screenshots: ScreenshotVerifyResult[];
}

/** Run the full verification pipeline for a project spec */
export async function runVerification(options: {
  spec: ProjectSpec;
  cwd: string;
  registry: AgentRegistry;
  config: OpenHiveConfig;
  skipScreenshots?: boolean;
}): Promise<VerifyResult> {
  const { spec, cwd, registry, config, skipScreenshots } = options;
  const verify = spec.verify;

  if (!verify) {
    logger.info('No verification configured in spec');
    return { passed: true, screenshots: [] };
  }

  let allPassed = true;
  let testResult: TestResult | undefined;
  const screenshotResults: ScreenshotVerifyResult[] = [];

  // Step 1: Run tests
  if (verify.tests) {
    logger.info(`Running tests: ${verify.tests}`);
    const parts = verify.tests.split(' ');
    const result = await exec(parts[0], parts.slice(1), { cwd });

    testResult = {
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      output: result.stdout + result.stderr,
    };

    if (!testResult.passed) {
      allPassed = false;
      logger.error(`Tests failed (exit ${result.exitCode})`);
    } else {
      logger.info('Tests passed');
    }
  }

  // Step 2: Screenshot verification
  if (!skipScreenshots && verify.screenshots && verify.screenshots.length > 0 && spec.serve) {
    const screenshotDir = join(cwd, '.openhive', 'screenshots');
    await mkdir(screenshotDir, { recursive: true });

    // Start dev server
    const server = await startDevServer(spec, cwd);

    try {
      for (const ss of verify.screenshots) {
        // Take screenshot
        const screenshot = await takeScreenshot({
          url: ss.url,
          name: ss.name,
          outputDir: screenshotDir,
          screenshotCommand: verify.screenshotCommand,
        });

        let assessment: AssessmentResult | undefined;
        if (screenshot.success) {
          // Assess with vision agent
          assessment = await assessScreenshot({
            screenshotPath: screenshot.path,
            url: ss.url,
            expectedDescription: ss.expect,
            registry,
            config,
          });

          if (!assessment.passed) {
            allPassed = false;
          }
        } else {
          allPassed = false;
          logger.warn(`Screenshot "${ss.name}" failed: ${screenshot.error}`);
        }

        screenshotResults.push({
          name: ss.name,
          url: ss.url,
          screenshot,
          assessment,
        });
      }
    } finally {
      // Kill dev server
      if (server) {
        server.kill();
        logger.info('Dev server stopped');
      }
    }
  }

  return {
    passed: allPassed,
    tests: testResult,
    screenshots: screenshotResults,
  };
}

/** Start the dev server and wait for it to be ready */
async function startDevServer(
  spec: ProjectSpec,
  cwd: string,
): Promise<ReturnType<typeof spawnProcess> | null> {
  if (!spec.serve) return null;

  const { command, readyPattern, startupTimeout = 15000 } = spec.serve;
  const parts = command.split(' ');

  logger.info(`Starting dev server: ${command}`);
  const proc = spawnProcess(parts[0], parts.slice(1), { cwd, stdio: 'pipe' });

  // Wait for the ready pattern in stdout
  if (readyPattern) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Dev server did not become ready within ${startupTimeout}ms`));
      }, startupTimeout);

      const onData = (data: Buffer) => {
        const text = data.toString();
        if (text.includes(readyPattern)) {
          clearTimeout(timer);
          proc.stdout?.off('data', onData);
          proc.stderr?.off('data', onDataStderr);
          resolve();
        }
      };

      const onDataStderr = (data: Buffer) => {
        const text = data.toString();
        if (text.includes(readyPattern)) {
          clearTimeout(timer);
          proc.stdout?.off('data', onData);
          proc.stderr?.off('data', onDataStderr);
          resolve();
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onDataStderr);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Dev server exited with code ${code} before becoming ready`));
      });
    });
  } else {
    // No pattern — wait a fixed delay for the server to start
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  logger.info('Dev server ready');
  return proc;
}
