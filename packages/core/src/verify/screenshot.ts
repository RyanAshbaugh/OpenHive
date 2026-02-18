import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from '../utils/process.js';
import { logger } from '../utils/logger.js';

export interface ScreenshotResult {
  /** Path to the saved screenshot file */
  path: string;
  /** Whether the screenshot was captured successfully */
  success: boolean;
  /** Error message if capture failed */
  error?: string;
}

/** Take a screenshot of a URL using Playwright or a custom command */
export async function takeScreenshot(options: {
  url: string;
  name: string;
  outputDir: string;
  screenshotCommand?: string;
}): Promise<ScreenshotResult> {
  const { url, name, outputDir, screenshotCommand } = options;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${name}-${timestamp}.png`;
  const outputPath = join(outputDir, filename);

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  if (screenshotCommand) {
    // Use custom screenshot command
    const cmd = screenshotCommand
      .replace('{url}', url)
      .replace('{output}', outputPath);

    const parts = cmd.split(' ');
    const result = await exec(parts[0], parts.slice(1));

    if (result.exitCode !== 0) {
      return {
        path: outputPath,
        success: false,
        error: `Screenshot command failed (exit ${result.exitCode}): ${result.stderr}`,
      };
    }

    return { path: outputPath, success: true };
  }

  // Default: use npx playwright screenshot
  const result = await exec('npx', [
    'playwright',
    'screenshot',
    '--wait-for-timeout=2000',
    url,
    outputPath,
  ], { timeout: 30000 });

  if (result.exitCode !== 0) {
    // Check if playwright is not installed
    if (result.stderr.includes('playwright') && result.stderr.includes('not found') ||
        result.stderr.includes('Cannot find module') ||
        result.stderr.includes('ERR_MODULE_NOT_FOUND')) {
      return {
        path: outputPath,
        success: false,
        error: 'Playwright is not installed. Install with: npm install -D playwright && npx playwright install chromium',
      };
    }

    return {
      path: outputPath,
      success: false,
      error: `Screenshot failed (exit ${result.exitCode}): ${result.stderr}`,
    };
  }

  logger.info(`Screenshot saved: ${outputPath}`);
  return { path: outputPath, success: true };
}
