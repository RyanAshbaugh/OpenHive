import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import type { AppContext } from './context.js';
import type { Task } from '../tasks/task.js';
import type { ToolUsageReport } from '../pool/tool-usage.js';
import { readAllToolUsage } from '../pool/tool-usage.js';
import type { ProbeResult } from '../pool/usage-probe.js';
import { getCachedProbeResults, loadProbeCache, isProbing, cleanupProbeSession } from '../pool/usage-probe.js';
import type { OrchestrationSessionState } from '../orchestrator/types.js';
import {
  theme, BOX, progressBar, statusDot,
  ScreenBuffer, stripAnsi, sliceVisible, padRight, renderPanel,
  runTuiLoop,
} from './tui.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  if (ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `~${h}h${m > 0 ? `${m}m` : ''}`;
  if (m > 0) return `~${m}m`;
  return `~${totalSec}s`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Shorten verbose timezone strings at display time */
function shortenReset(s: string): string {
  return s
    .replace(/\(America\/Los_Angeles\)/g, 'PT')
    .replace(/\(America\/New_York\)/g, 'ET')
    .replace(/\(America\/Chicago\)/g, 'CT')
    .replace(/\([A-Za-z/_]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadOrchestrationState(): Promise<OrchestrationSessionState | null> {
  try {
    const filePath = join(homedir(), '.openhive', 'orchestration-state.json');
    const raw = await readFile(filePath, 'utf-8');
    const state = JSON.parse(raw) as OrchestrationSessionState;
    // Ignore stale state files (>30s old or stopped)
    if (state.status === 'stopped') return null;
    const age = Date.now() - new Date(state.updatedAt).getTime();
    if (age > 30_000) return null;
    return state;
  } catch {
    return null;
  }
}

function workerStateDot(state: string): string {
  switch (state) {
    case 'idle': return theme.success('●');
    case 'working': return theme.info('●');
    case 'waiting_approval': return theme.warning('●');
    case 'waiting_input': return theme.warning('●');
    case 'stuck': return theme.error('●');
    case 'rate_limited': return theme.error('●');
    case 'error': return theme.error('✗');
    case 'starting': return theme.dim('●');
    case 'dead': return theme.dim('✗');
    default: return theme.dim('○');
  }
}

type PoolMode = 'tool' | 'openhive';

// ─── Dashboard Composer ─────────────────────────────────────────────────────

interface AgentInfo {
  name: string;
  displayName: string;
  provider: string;
  available: boolean;
}

async function gatherAgents(ctx: AppContext): Promise<AgentInfo[]> {
  const statuses = await ctx.registry.checkAll(ctx.config);
  return statuses.map(s => ({
    name: s.adapter.name,
    displayName: s.adapter.displayName,
    provider: s.adapter.provider,
    available: s.available,
  }));
}

// ─── Pool panel renderers ───────────────────────────────────────────────────

function renderPoolTool(
  pools: { provider: string }[],
  toolUsage: Map<string, ToolUsageReport>,
  probeResults: Map<string, ProbeResult>,
  innerW: number,
): string[] {
  const lines: string[] = [];
  const barW = 12;

  for (const pool of pools) {
    const provColor = theme.providers[pool.provider] ?? chalk.white;
    const probe = probeResults.get(pool.provider);

    // No usage command for this provider
    if (probe?.error === 'No usage command available' || probe?.error === 'No usage command') {
      lines.push(`${provColor(padRight(pool.provider, 11))}${theme.dim('N/A')}`);
      continue;
    }

    // Have probe data — show real bars (max 2 windows per line to fit)
    if (probe && probe.available && probe.windows.length > 0) {
      // Show the 2 most important windows (5h and wk, or day, etc.)
      const displayWins = probe.windows.slice(0, 2);
      const segments: string[] = [];
      for (const win of displayWins) {
        const bar = progressBar(win.percentUsed, 100, barW);
        const pctStr = `${win.percentUsed}%`;
        const reset = win.resetInfo ? theme.dim(` ${shortenReset(win.resetInfo)}`) : '';
        segments.push(`${theme.dim(padRight(win.label, 4))}${bar} ${padRight(pctStr, 5)}${reset}`);
      }

      // Stale indicator: if probed more than 5 mins ago
      const age = Date.now() - new Date(probe.probedAt).getTime();
      const stale = age > 5 * 60_000 ? theme.dim(' *') : '';

      const raw = `${provColor(padRight(pool.provider, 11))}${segments.join('  ')}${stale}`;
      lines.push(stripAnsi(raw).length > innerW ? sliceVisible(raw, 0, innerW) : raw);
      continue;
    }

    // No probe data yet — show placeholder bars or "probing..."
    if (isProbing()) {
      lines.push(`${provColor(padRight(pool.provider, 11))}${theme.dim('probing...')}`);
    } else {
      // Probe failed or hasn't run — show what we have from local files
      const report = toolUsage.get(pool.provider);
      if (report?.available && report.today) {
        const parts: string[] = [];
        if (report.today.messages > 0) parts.push(`${formatNumber(report.today.messages)} msgs`);
        if (report.today.sessions > 0) parts.push(`${report.today.sessions} sess`);
        if (report.today.tokens > 0) parts.push(`${formatNumber(report.today.tokens)} tok`);
        const info = parts.length > 0 ? parts.join('  ') : 'no activity today';
        lines.push(`${provColor(padRight(pool.provider, 11))}${theme.dim(info)}  ${theme.dim('(r to probe)')}`);
      } else {
        lines.push(`${provColor(padRight(pool.provider, 11))}${theme.dim('no data')}  ${theme.dim('(r to probe)')}`);
      }
    }
  }

  return lines;
}

function renderPoolOpenHive(
  ctx: AppContext,
  pools: { provider: string; maxConcurrent: number; activeCount: number }[],
  innerW: number,
): string[] {
  const lines: string[] = [];
  const poolBarW = 8;

  for (const pool of pools) {
    const provColor = theme.providers[pool.provider] ?? chalk.white;
    const summary = ctx.poolTracker.getUsageSummary(pool.provider);

    if (summary.windows.length === 0) {
      const slots = summary.activeCount > 0
        ? theme.info(`${summary.activeCount} active`)
        : theme.dim('idle');
      lines.push(`${provColor(padRight(pool.provider, 11))}${slots}  ${theme.dim('no known limits')}`);
      continue;
    }

    const segments: string[] = [];
    for (const win of summary.windows) {
      const bar = progressBar(win.used, win.limit ?? 0, poolBarW);
      const label = win.limit ? `${win.used}/${win.limit}` : String(win.used);
      let reset = '';
      if (win.resetInMs !== undefined && win.used > 0) {
        reset = theme.dim(` ${formatCountdown(win.resetInMs)}`);
      }
      segments.push(`${theme.dim(padRight(win.label, 4))}${bar} ${padRight(label, 7)}${reset}`);
    }

    const slots = summary.activeCount > 0
      ? theme.info(`${summary.activeCount}/${summary.maxConcurrent}`)
      : theme.dim('idle');
    const raw = `${provColor(padRight(pool.provider, 11))}${padRight(slots, 6)} ${segments.join('  ')}`;
    lines.push(stripAnsi(raw).length > innerW ? sliceVisible(raw, 0, innerW) : raw);
  }

  return lines;
}

// ─── Overview mode renderer ─────────────────────────────────────────────────

function renderOverview(
  ctx: AppContext,
  agents: AgentInfo[],
  cols: number,
  rows: number,
  selectedIdx: number,
  logContent: string,
  sortedTasks: Task[],
  poolMode: PoolMode,
  toolUsage: Map<string, ToolUsageReport>,
  probeResults: Map<string, ProbeResult>,
  orchState: OrchestrationSessionState | null,
): string {
  const buf = new ScreenBuffer(cols, rows);
  const tasks = ctx.queue.list();
  const pools = ctx.poolTracker.getAllPools();

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const titleBar = ' OpenHive ';
  const outerW = cols;
  const outerLeft = Math.max(0, Math.floor((cols - outerW) / 2));
  const topBarPad = outerW - 2 - titleBar.length - timeStr.length - 3;
  buf.write(0, outerLeft, theme.border(BOX.tl + BOX.h) + theme.title(titleBar) + theme.border(BOX.h.repeat(Math.max(0, topBarPad)) + ' ') + theme.dim(timeStr) + theme.border(' ' + BOX.tr));

  for (let r = 1; r < rows - 1; r++) {
    buf.write(r, outerLeft, theme.border(BOX.v));
    buf.write(r, outerLeft + outerW - 1, theme.border(BOX.v));
  }

  const keys = '  j/k select  Enter stream  c clear done  p pools  x kill  r refresh  q quit';
  const bottomPad = outerW - 2 - keys.length;
  buf.write(rows - 1, outerLeft, theme.border(BOX.bl) + theme.dim(keys) + theme.border(BOX.h.repeat(Math.max(0, bottomPad)) + BOX.br));

  const innerLeft = outerLeft + 2;
  const innerW = outerW - 4;
  let curRow = 2;

  // ── Agents + Tasks summary (side by side) ──
  const agentPanelW = Math.floor(innerW * 0.4);
  const taskPanelW = innerW - agentPanelW - 1;

  const agentLines = agents.map(a => {
    const dot = a.available ? theme.success('●') : theme.dim('○');
    const provColor = theme.providers[a.provider] ?? chalk.white;
    return `${dot} ${padRight(a.displayName, agentPanelW - 15)}${provColor(a.provider)}`;
  });
  const agentPanelH = Math.max(agents.length + 2, 4);
  renderPanel(buf, curRow, innerLeft, agentPanelW, agentPanelH, 'Agents', agentLines);

  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'queued').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const total = Math.max(pending + running + completed + failed, 1);
  const barW = 10;

  const taskSummaryLines = [
    `${padRight('Pending', 12)}${progressBar(pending, total, barW)}  ${pending}`,
    `${padRight('Running', 12)}${progressBar(running, total, barW)}  ${running}`,
    `${padRight('Completed', 12)}${progressBar(completed, total, barW)}  ${completed}`,
    `${padRight('Failed', 12)}${progressBar(failed, total, barW)}  ${failed}`,
  ];
  renderPanel(buf, curRow, innerLeft + agentPanelW + 1, taskPanelW, agentPanelH, 'Summary', taskSummaryLines);

  curRow += agentPanelH + 1;

  // ── Orchestration status line (compact, when orchestrator is active) ──
  if (orchState && orchState.status === 'running') {
    const workingCount = orchState.workers.filter(w => w.taskId).length;
    const idleCount = orchState.workers.filter(w => !w.taskId).length;
    const orchLine = `${theme.info('Orchestration:')} running  ${workingCount} working, ${idleCount} idle  ${theme.dim('pending:')} ${orchState.pendingTaskCount}  ${theme.dim('done:')} ${orchState.completedTaskCount}  ${theme.dim('failed:')} ${orchState.failedTaskCount}`;
    buf.write(curRow, innerLeft, orchLine);
    curRow += 2;
  }

  // ── Pool panel ──
  const probingIndicator = isProbing() ? ' ...' : '';
  const poolTitle = poolMode === 'tool'
    ? `Pools: Tool Usage${probingIndicator} (p to toggle)`
    : 'Pools: OpenHive (p to toggle)';

  const poolLines = poolMode === 'tool'
    ? renderPoolTool(pools, toolUsage, probeResults, innerW)
    : renderPoolOpenHive(ctx, pools, innerW);

  const poolPanelH = Math.max(poolLines.length + 2, 4);
  const availRows = rows - curRow - 2;
  const poolH = Math.min(poolPanelH, availRows);
  renderPanel(buf, curRow, innerLeft, innerW, poolH, poolTitle, poolLines);

  curRow += poolH + 1;

  // ── Task list (selectable) + live preview ──
  const hasLog = logContent.length > 0;
  const remainingRows = rows - curRow - 2;
  const taskPanelH = hasLog ? Math.max(Math.floor(remainingRows * 0.45), 4) : Math.max(remainingRows, 4);

  const recent = sortedTasks.slice(0, taskPanelH - 2);
  const recentLines = recent.map((t, i) => {
    const isSelected = i === selectedIdx;
    // For orchestrated tasks, use workerState-aware dot; otherwise use status dot
    const dot = t.workerId ? workerStateDot(t.workerState ?? t.status) : statusDot(t.status);
    const id = t.id.slice(0, 6);
    // Show workerState when available (more granular), otherwise show task status
    const displayStatus = t.workerState ?? t.status;
    const status = padRight(displayStatus, 10);
    const agent = padRight(t.agent ?? '-', 8);
    const dur = t.durationMs
      ? `${(t.durationMs / 1000).toFixed(1)}s`
      : t.startedAt && t.status === 'running'
        ? `${((Date.now() - new Date(t.startedAt).getTime()) / 1000).toFixed(0)}s...`
        : '';
    const prefix = isSelected ? theme.borderFocus('> ') : '  ';
    const promptW = innerW - 44;
    const prompt = t.prompt.length > promptW ? t.prompt.slice(0, promptW - 3) + '...' : t.prompt;
    return `${prefix}${dot} ${theme.dim(id)}  ${status} ${agent} ${prompt}  ${theme.dim(dur)}`;
  });
  if (recentLines.length === 0) {
    recentLines.push(theme.dim('No tasks yet.'));
  }
  renderPanel(buf, curRow, innerLeft, innerW, taskPanelH, 'Tasks', recentLines);

  curRow += taskPanelH + 1;

  // ── Live preview panel ──
  if (hasLog && curRow < rows - 2) {
    const logPanelH = Math.max(rows - curRow - 2, 3);
    const selected = sortedTasks[selectedIdx];
    const logTitle = selected
      ? `Preview: ${selected.id.slice(0, 6)}${selected.agent ? ` (${selected.agent})` : ''}`
      : 'Preview';
    const logLines = logContent.split('\n').slice(-(logPanelH - 2));
    const maxLineW = innerW - 2;
    const trimmedLogLines = logLines.map(l =>
      stripAnsi(l).length > maxLineW ? l.slice(0, maxLineW - 3) + '...' : l,
    );
    renderPanel(buf, curRow, innerLeft, innerW, logPanelH, logTitle, trimmedLogLines);
  }

  return buf.flush();
}

// ─── Stream view renderer ───────────────────────────────────────────────────

function renderStreamView(
  ctx: AppContext,
  taskId: string,
  logContent: string,
  cols: number,
  rows: number,
): string {
  const buf = new ScreenBuffer(cols, rows);
  const outerW = cols;
  const outerLeft = Math.max(0, Math.floor((cols - outerW) / 2));
  const innerW = outerW - 2;

  const task = ctx.queue.get(taskId);
  const statusStr = task?.status ?? 'unknown';
  const agentStr = task?.agent ?? '';
  const elapsed = task?.startedAt && task.status === 'running'
    ? `${((Date.now() - new Date(task.startedAt).getTime()) / 1000).toFixed(0)}s`
    : task?.durationMs ? `${(task.durationMs / 1000).toFixed(1)}s` : '';

  const title = `${taskId.slice(0, 8)} ${agentStr} [${statusStr}] ${elapsed}`;
  const panelH = rows - 1;
  const logLines = logContent ? logContent.split('\n').slice(-(panelH - 2)) : [theme.dim('No output yet...')];
  const maxLineW = innerW - 2;
  const trimmed = logLines.map(l =>
    stripAnsi(l).length > maxLineW ? l.slice(0, maxLineW - 3) + '...' : l,
  );

  renderPanel(buf, 0, outerLeft, outerW, panelH, title, trimmed);

  const footer = theme.dim('  Esc back  q quit');
  buf.write(rows - 1, outerLeft, footer);

  return buf.flush();
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

export async function runDashboard(ctx: AppContext): Promise<void> {
  let agents = await gatherAgents(ctx);
  let selectedIdx = 0;
  let logContent = '';
  let sortedTasks: Task[] = [];
  let mode: 'overview' | 'stream' = 'overview';
  let streamTaskId = '';
  let poolMode: PoolMode = 'tool';
  let toolUsage = new Map<string, ToolUsageReport>();
  let probeResults = new Map<string, ProbeResult>();
  let orchState: OrchestrationSessionState | null = null;
  const dismissedTaskIds = new Set<string>();

  // Load persisted probe cache from disk (instant — shows last-known bars)
  probeResults = await loadProbeCache();

  // Load local file usage data (fast)
  try {
    toolUsage = await readAllToolUsage();
  } catch {
    // ignore
  }

  // Trigger a fresh background probe (takes ~10s, runs in parallel)
  getCachedProbeResults();

  const getSortedTasks = (): Task[] => {
    const tasks = ctx.queue.list();
    return [...tasks].sort((a, b) => {
      const order: Record<string, number> = { running: 0, pending: 1, queued: 2, completed: 3, failed: 4, cancelled: 5 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });
  };

  let displayTasks: Task[] = [];
  const updateDisplayTasks = () => {
    displayTasks = sortedTasks.filter(t => !dismissedTaskIds.has(t.id));
  };

  const loadLogForTask = async (taskId: string) => {
    const logPath = join(process.cwd(), '.openhive', 'logs', `${taskId}.log`);
    try {
      logContent = await readFile(logPath, 'utf-8');
    } catch {
      logContent = '';
    }
  };

  let tickCount = 0;

  await runTuiLoop({
    render: (cols, rows) => {
      if (mode === 'stream') {
        return renderStreamView(ctx, streamTaskId, logContent, cols, rows);
      }
      return renderOverview(ctx, agents, cols, rows, selectedIdx, logContent, displayTasks, poolMode, toolUsage, probeResults, orchState);
    },
    onKey: async (key) => {
      if (mode === 'stream') {
        // Esc or 'b' returns to overview
        if (key === '\x1b' || key === 'b') {
          mode = 'overview';
          return;
        }
        if (key === 'q') {
          process.exit(0);
        }
        return;
      }

      // Overview mode keys
      if (key === 'q') {
        cleanupProbeSession().catch(() => {});
        process.exit(0);
      }
      if (key === 'r') {
        agents = await gatherAgents(ctx);
        toolUsage = await readAllToolUsage();
        probeResults = getCachedProbeResults();
      }
      if (key === 'p') {
        poolMode = poolMode === 'tool' ? 'openhive' : 'tool';
      }
      if (key === 'j' && selectedIdx < displayTasks.length - 1) {
        selectedIdx++;
        const task = displayTasks[selectedIdx];
        if (task) await loadLogForTask(task.id);
      }
      if (key === 'k' && selectedIdx > 0) {
        selectedIdx--;
        const task = displayTasks[selectedIdx];
        if (task) await loadLogForTask(task.id);
      }
      // Enter: switch to full-screen stream view
      if (key === '\r' || key === '\n') {
        const task = displayTasks[selectedIdx];
        if (task) {
          mode = 'stream';
          streamTaskId = task.id;
          await loadLogForTask(task.id);
        }
      }
      // x: kill a running task
      if (key === 'x') {
        const task = displayTasks[selectedIdx];
        if (task && task.status === 'running') {
          ctx.queue.update(task.id, {
            status: 'failed',
            error: 'Killed by user',
            completedAt: new Date().toISOString(),
          });
          await ctx.storage.save(ctx.queue.get(task.id)!);
          sortedTasks = getSortedTasks();
          updateDisplayTasks();
          if (selectedIdx >= displayTasks.length) {
            selectedIdx = Math.max(0, displayTasks.length - 1);
          }
        }
      }
      // c: clear completed tasks from display
      if (key === 'c') {
        for (const t of sortedTasks) {
          if (t.status === 'completed') {
            dismissedTaskIds.add(t.id);
          }
        }
        updateDisplayTasks();
        if (selectedIdx >= displayTasks.length) {
          selectedIdx = Math.max(0, displayTasks.length - 1);
        }
      }
    },
    onTick: async () => {
      try {
        const tasks = await ctx.storage.loadAll();
        ctx.queue.loadAll(tasks);
        await ctx.poolTracker.reloadUsageStore();

        // Auto-cleanup failed tasks older than 1 hour
        const oneHourAgo = Date.now() - 3_600_000;
        for (const task of tasks) {
          if (task.status === 'failed' && task.completedAt) {
            const completedTime = new Date(task.completedAt).getTime();
            if (completedTime < oneHourAgo) {
              await ctx.storage.delete(task.id);
            }
          }
        }
      } catch {
        // Ignore load errors
      }
      sortedTasks = getSortedTasks();
      updateDisplayTasks();
      if (selectedIdx >= displayTasks.length) {
        selectedIdx = Math.max(0, displayTasks.length - 1);
      }
      tickCount++;
      // Reload local file usage every 10 ticks (~5 seconds)
      if (tickCount % 10 === 0) {
        try {
          toolUsage = await readAllToolUsage();
        } catch {
          // ignore
        }
      }
      // Refresh probe cache (returns immediately, triggers bg probe if stale)
      probeResults = getCachedProbeResults();
      // Load orchestration session state
      orchState = await loadOrchestrationState();
      // Reload log for current view
      if (mode === 'stream' && streamTaskId) {
        await loadLogForTask(streamTaskId);
      } else if (displayTasks[selectedIdx]) {
        await loadLogForTask(displayTasks[selectedIdx].id);
      } else {
        logContent = '';
      }
    },
    intervalMs: 500,
  });
}
