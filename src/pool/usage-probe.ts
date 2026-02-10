/**
 * Probe running CLI tools for their real usage/quota data via tmux.
 *
 * Strategy:
 *   1. Start each tool in a hidden tmux pane (or reuse an existing one)
 *   2. Send the tool's usage/status slash command
 *   3. Capture the pane output with `tmux capture-pane`
 *   4. Parse percentages + reset times with regex
 *   5. Shut down the pane
 *
 * This gives us the same data a human sees when typing /usage, /status, /stats.
 *
 * Each tool reports usage differently:
 *   Claude (/usage):  "Current session: ██▌ 5% used  Resets 9:59pm PT"
 *                     "Current week (all): ███████▌ 15% used  Resets Feb 12 at 7:59pm PT"
 *   Codex  (/status): "5h limit: [████████████████████] 99% left (resets 22:20)"
 *                     "Weekly limit: [████████████████████] 100% left (resets 17:20 on 16 Feb)"
 *   Gemini (/stats):  "gemini-2.5-flash  -  100.0% (Resets in 24h)"
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TOOL_CONTROLS, buildUsageProbeSteps } from '../agents/tool-control.js';
import { logger } from '../utils/logger.js';

const exec = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UsageWindow {
  label: string;
  /** 0–100, where 0 = fresh, 100 = exhausted */
  percentUsed: number;
  /** Human-readable reset description, e.g. "9:59pm PT" or "in 24h" */
  resetInfo: string;
}

export interface ProbeResult {
  provider: string;
  tool: string;
  available: boolean;
  windows: UsageWindow[];
  rawOutput?: string;
  error?: string;
  probedAt: string;
}

// ─── tmux helpers ───────────────────────────────────────────────────────────

const PROBE_SESSION = 'openhive-probe';

async function tmux(...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('tmux', args, { timeout: 10000 });
    return stdout;
  } catch (err: any) {
    throw new Error(`tmux ${args[0]} failed: ${err.message}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let sessionReady = false;

async function ensureProbeSession(): Promise<void> {
  if (sessionReady) return;
  try {
    await tmux('has-session', '-t', PROBE_SESSION);
    sessionReady = true;
  } catch {
    // Session doesn't exist, create it detached
    await tmux('new-session', '-d', '-s', PROBE_SESSION, '-x', '200', '-y', '60');
    sessionReady = true;
  }
}

async function createProbePane(tool: string): Promise<string> {
  const ctrl = TOOL_CONTROLS[tool];
  if (!ctrl) throw new Error(`No control definition for tool: ${tool}`);

  const paneTarget = `${PROBE_SESSION}:${tool}`;

  // Kill existing window if present
  try {
    await tmux('kill-window', '-t', paneTarget);
  } catch {
    // Window doesn't exist, fine
  }

  // Create a new window with the tool running in it
  const startCmd = [ctrl.startCommand, ...ctrl.startArgs].join(' ');
  await tmux('new-window', '-t', PROBE_SESSION, '-n', tool, startCmd);

  return paneTarget;
}

async function sendKeys(target: string, keys: string[]): Promise<void> {
  await tmux('send-keys', '-t', target, ...keys);
}

async function capturePane(target: string, scrollback: number): Promise<string> {
  return tmux('capture-pane', '-t', target, '-p', '-S', String(scrollback));
}

async function killWindow(target: string): Promise<void> {
  try {
    await tmux('kill-window', '-t', target);
  } catch {
    // Already dead
  }
}

// ─── Readiness detection ─────────────────────────────────────────────────────

/**
 * Wait for a tool's main UI to be ready for input.
 * Polls the pane, looking for the readyPattern. If a startup dialog
 * is detected (update prompts, model choosers), sends Escape to dismiss.
 * Returns the captured output when ready, or throws after timeout.
 */
async function waitForReady(target: string, tool: string): Promise<string> {
  const ctrl = TOOL_CONTROLS[tool];
  const maxWaitMs = 15000;
  const pollMs = 1000;
  const maxAttempts = Math.ceil(maxWaitMs / pollMs);

  // Wait a bit for the tool to start rendering
  await sleep(2000);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await capturePane(target, ctrl.captureScrollback);
    const output = stripAnsi(raw);

    // Check if the main UI is ready
    if (ctrl.readyPattern.test(output)) {
      logger.debug(`${tool} ready after ${attempt + 1} polls`);
      return output;
    }

    // Check for startup dialogs that need dismissing
    if (ctrl.startupDialogPattern && ctrl.startupDialogPattern.test(output)) {
      logger.debug(`${tool}: startup dialog detected, sending Escape`);
      await sendKeys(target, ['Escape']);
      await sleep(1500);
      continue;
    }

    // Not ready yet and no dialog — wait and retry
    await sleep(pollMs);
  }

  // Timed out — return whatever we have (probeTool will try anyway)
  logger.debug(`${tool}: readiness timeout after ${maxWaitMs}ms, proceeding anyway`);
  return await capturePane(target, ctrl.captureScrollback);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes from tmux captured output */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Shorten verbose timezone/reset strings for compact display */
function shortenResetInfo(s: string): string {
  return s
    .replace(/\(America\/Los_Angeles\)/g, 'PT')
    .replace(/\(America\/New_York\)/g, 'ET')
    .replace(/\(America\/Chicago\)/g, 'CT')
    .replace(/\(America\/Denver\)/g, 'MT')
    .replace(/\(Europe\/London\)/g, 'GMT')
    .replace(/\(UTC\)/g, 'UTC')
    .replace(/\([A-Za-z/_]+\)/g, '')  // strip any remaining IANA tz
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * Parse Claude /usage output.
 * Lines like: "Current session:     ██▌  5% used     Resets 9:59pm PT"
 *             "Current week (all):  ███████▌  15% used     Resets Feb 12 at 7:59pm PT"
 *             "Current week (Sonnet): ▌  1% used     Resets Feb 14 at 11:59pm PT"
 */
/**
 * Parse Claude /usage output.
 *
 * Claude v2.1+ uses a multi-line format:
 *   Current session
 *   █████▌                                             11% used
 *   Resets 10pm (America/Los_Angeles)
 *
 *   Current week (all models)
 *   ████████                                           16% used
 *   Resets Feb 12 at 8pm (America/Los_Angeles)
 *
 * Older versions used a single-line format:
 *   Current session:     ██▌  5% used     Resets 9:59pm PT
 */
function parseClaudeUsage(rawOutput: string): UsageWindow[] {
  const output = stripAnsi(rawOutput);
  const windows: UsageWindow[] = [];
  const lines = output.split('\n').map(l => l.trim());

  for (let i = 0; i < lines.length; i++) {
    // Look for "X% used" on any line
    const pctMatch = lines[i].match(/(\d+)%\s+used/);
    if (!pctMatch) continue;

    const pctUsed = parseInt(pctMatch[1], 10);

    // Look backwards for the label (e.g. "Current session", "Current week (all models)")
    let rawLabel = '';
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (lines[j].match(/^Current\s+(session|week)/i)) {
        rawLabel = lines[j];
        break;
      }
    }

    // Look forwards for reset info (e.g. "Resets 10pm (America/Los_Angeles)")
    let resetInfo = '';
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
      const resetMatch = lines[j].match(/Resets?\s+(.+)/i);
      if (resetMatch) {
        resetInfo = shortenResetInfo(resetMatch[1].trim());
        break;
      }
    }

    let label: string;
    if (rawLabel.toLowerCase().includes('session')) {
      label = '5h';
    } else if (rawLabel.toLowerCase().includes('week') && rawLabel.toLowerCase().includes('all')) {
      label = 'wk';
    } else if (rawLabel.toLowerCase().includes('week')) {
      const sub = rawLabel.replace(/current\s+week\s*/i, '').replace(/[()]/g, '').trim();
      label = sub ? `wk(${sub})` : 'wk';
    } else {
      label = rawLabel || '?';
    }

    windows.push({ label, percentUsed: pctUsed, resetInfo });
  }

  // Also try the single-line format (older Claude versions)
  if (windows.length === 0) {
    const re = /(?:Current\s+(\w[\w\s()]*?)):\s+[█▌░\s]*\s*(\d+)%\s+used\s+Resets\s+(.+?)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const rawLabel = m[1].trim();
      const pctUsed = parseInt(m[2], 10);
      const resetInfo = shortenResetInfo(m[3].trim());

      let label: string;
      if (rawLabel.toLowerCase().includes('session')) {
        label = '5h';
      } else if (rawLabel.toLowerCase().includes('week') && rawLabel.toLowerCase().includes('all')) {
        label = 'wk';
      } else if (rawLabel.toLowerCase().includes('week')) {
        label = `wk(${rawLabel.replace(/current\s+week\s*/i, '').replace(/[()]/g, '').trim()})`;
      } else {
        label = rawLabel;
      }

      windows.push({ label, percentUsed: pctUsed, resetInfo });
    }
  }

  return windows;
}

/**
 * Parse Codex /status output.
 * Lines like: "5h limit:     [████████████████████] 99% left (resets 22:20)"
 *             "Weekly limit: [████████████████████] 100% left (resets 17:20 on 16 Feb)"
 */
function parseCodexUsage(rawOutput: string): UsageWindow[] {
  const output = stripAnsi(rawOutput);
  const windows: UsageWindow[] = [];
  const re = /(5h|Weekly)\s+limit:\s+\[.*?\]\s+(\d+)%\s+left\s+\(resets\s+(.+?)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const rawLabel = m[1].toLowerCase();
    const pctLeft = parseInt(m[2], 10);
    const resetInfo = m[3].trim();

    windows.push({
      label: rawLabel === '5h' ? '5h' : 'wk',
      percentUsed: 100 - pctLeft,  // Codex reports "% left", we normalize to "% used"
      resetInfo,
    });
  }
  return windows;
}

/**
 * Parse Gemini /stats output.
 * Lines like: "gemini-2.5-flash  -  100.0% (Resets in 24h)"
 *             "gemini-3-pro-preview  -  95.5% (Resets in 18h)"
 */
function parseGeminiUsage(rawOutput: string): UsageWindow[] {
  const output = stripAnsi(rawOutput);
  const windows: UsageWindow[] = [];
  // Match per-model lines with percentage and reset
  const re = /(gemini-[\w.-]+)\s+.*?\s+(\d+(?:\.\d+)?)%\s+\(Resets?\s+in\s+(.+?)\)/gi;
  let m: RegExpExecArray | null;

  // Collect all model usages, then report the most-used model as the summary
  const models: { model: string; pctLeft: number; resetInfo: string }[] = [];
  while ((m = re.exec(output)) !== null) {
    models.push({
      model: m[1],
      pctLeft: parseFloat(m[2]),
      resetInfo: m[3].trim(),
    });
  }

  if (models.length === 0) return windows;

  // Find the most-used model (lowest % left = highest usage)
  const mostUsed = models.reduce((a, b) => a.pctLeft < b.pctLeft ? a : b);
  const resetInfo = mostUsed.resetInfo;

  // Report overall daily usage — use the most-used model's percentage
  windows.push({
    label: 'day',
    percentUsed: Math.round(100 - mostUsed.pctLeft),  // "% left" → "% used"
    resetInfo: `in ${resetInfo}`,
  });

  // If there are multiple models with different usage, also report the active model
  if (models.length > 1) {
    for (const model of models) {
      if (model.pctLeft < 100) {
        const shortName = model.model.replace('gemini-', '').replace('-preview', '');
        windows.push({
          label: shortName,
          percentUsed: Math.round(100 - model.pctLeft),
          resetInfo: `in ${model.resetInfo}`,
        });
      }
    }
  }

  return windows;
}

const parsers: Record<string, (output: string) => UsageWindow[]> = {
  claude: parseClaudeUsage,
  codex: parseCodexUsage,
  gemini: parseGeminiUsage,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Probe a single tool for usage data.
 * Starts the tool in a tmux pane, sends the usage command, captures + parses output.
 * Pane is cleaned up after capture.
 */
export async function probeTool(tool: string): Promise<ProbeResult> {
  const ctrl = TOOL_CONTROLS[tool];
  if (!ctrl || !ctrl.usageCommand) {
    return {
      provider: ctrl?.provider ?? tool,
      tool,
      available: false,
      windows: [],
      error: 'No usage command available',
      probedAt: new Date().toISOString(),
    };
  }

  const parser = parsers[tool];
  if (!parser) {
    return {
      provider: ctrl.provider,
      tool,
      available: false,
      windows: [],
      error: 'No parser for this tool',
      probedAt: new Date().toISOString(),
    };
  }

  try {
    // Session must be created by probeAllTools() before calling probeTool()
    const target = await createProbePane(tool);

    // Wait for the tool to be ready for input (handles startup prompts)
    await waitForReady(target, tool);

    // Send usage command
    const steps = buildUsageProbeSteps(tool);
    if (!steps) throw new Error('No probe steps');

    for (const step of steps) {
      await sendKeys(target, step.keys);
      await sleep(step.delayAfterMs);
    }

    // Capture output
    const output = await capturePane(target, ctrl.captureScrollback);

    // Clean up: kill the probe window
    await killWindow(target);

    // Parse
    const windows = parser(output);

    return {
      provider: ctrl.provider,
      tool,
      available: windows.length > 0,
      windows,
      rawOutput: output,
      probedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    logger.debug(`Usage probe failed for ${tool}: ${err.message}`);
    return {
      provider: ctrl.provider,
      tool,
      available: false,
      windows: [],
      error: err.message,
      probedAt: new Date().toISOString(),
    };
  }
}

/**
 * Probe all tools that have usage commands.
 * Creates the tmux session first, then runs probes in parallel.
 */
export async function probeAllTools(): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  const tools = Object.keys(TOOL_CONTROLS).filter(t => TOOL_CONTROLS[t].usageCommand);

  // Ensure session exists before spawning parallel probes
  await ensureProbeSession();

  // Run all probes in parallel
  const probeResults = await Promise.allSettled(tools.map(t => probeTool(t)));
  for (const result of probeResults) {
    if (result.status === 'fulfilled') {
      results.set(result.value.provider, result.value);
    }
  }

  // Add entries for tools without usage commands
  for (const [name, ctrl] of Object.entries(TOOL_CONTROLS)) {
    if (!ctrl.usageCommand && !results.has(ctrl.provider)) {
      results.set(ctrl.provider, {
        provider: ctrl.provider,
        tool: name,
        available: false,
        windows: [],
        error: 'No usage command',
        probedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

// ─── Disk persistence ───────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), '.openhive');
const CACHE_FILE = join(CACHE_DIR, 'probe-cache.json');

interface DiskCache {
  version: 1;
  results: Record<string, ProbeResult>;
}

async function loadDiskCache(): Promise<Map<string, ProbeResult>> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    const data: DiskCache = JSON.parse(raw);
    if (data.version !== 1) return new Map();
    return new Map(Object.entries(data.results));
  } catch {
    return new Map();
  }
}

async function saveDiskCache(results: Map<string, ProbeResult>): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const data: DiskCache = {
      version: 1,
      results: Object.fromEntries(results),
    };
    // Strip rawOutput to keep the file small
    for (const r of Object.values(data.results)) {
      delete r.rawOutput;
    }
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.debug(`Failed to save probe cache: ${err}`);
  }
}

// ─── Cached probing ─────────────────────────────────────────────────────────

let probeCache: Map<string, ProbeResult> | null = null;
let lastProbeTime = 0;
let diskCacheLoaded = false;
let probeInFlight = false;
const PROBE_CACHE_TTL = 2 * 60_000;  // 2 minutes (probing is expensive)

/**
 * Load probe cache from disk. Call once at startup.
 * Returns immediately-available results from the last successful probe.
 */
export async function loadProbeCache(): Promise<Map<string, ProbeResult>> {
  if (!diskCacheLoaded) {
    probeCache = await loadDiskCache();
    diskCacheLoaded = true;
    // Treat disk cache as already "timed out" so a fresh probe triggers
    lastProbeTime = 0;
  }
  return probeCache ?? new Map();
}

/**
 * Get cached probe results, refreshing if stale.
 * This is safe to call frequently from the dashboard render loop.
 * Returns immediately with cached data; triggers background refresh if stale.
 */
export function getCachedProbeResults(): Map<string, ProbeResult> {
  const now = Date.now();

  if (now - lastProbeTime > PROBE_CACHE_TTL) {
    // Trigger background probe
    if (!probeInFlight) {
      probeInFlight = true;
      probeAllTools()
        .then(async (results) => {
          // Merge: only update a provider if the new probe got real data,
          // otherwise keep the existing cached entry (don't overwrite good data with failures)
          const merged = new Map(probeCache ?? new Map());
          for (const [provider, result] of results) {
            const existing = merged.get(provider);
            if (result.available) {
              // New probe succeeded — use it
              merged.set(provider, result);
            } else if (!existing || !existing.available) {
              // Both failed or no prior data — update anyway (keeps error info fresh)
              merged.set(provider, result);
            }
            // else: new probe failed but we have good cached data — keep the old one
          }
          probeCache = merged;
          lastProbeTime = Date.now();
          await saveDiskCache(merged);
        })
        .catch(err => {
          logger.debug(`Background probe failed: ${err}`);
        })
        .finally(() => {
          probeInFlight = false;
        });
    }
  }

  return probeCache ?? new Map();
}

/** True if a probe is currently running in the background */
export function isProbing(): boolean {
  return probeInFlight;
}

/**
 * Force an immediate probe and wait for results.
 * Use this for initial data load, not in render loops.
 */
export async function forceProbe(): Promise<Map<string, ProbeResult>> {
  const results = await probeAllTools();
  probeCache = results;
  lastProbeTime = Date.now();
  await saveDiskCache(results);
  return results;
}

/**
 * Clean up the probe tmux session.
 * Call this when shutting down.
 */
export async function cleanupProbeSession(): Promise<void> {
  sessionReady = false;
  try {
    await tmux('kill-session', '-t', PROBE_SESSION);
  } catch {
    // Session doesn't exist, fine
  }
}
