import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import type { AppContext } from './context.js';
import type { Task } from '../tasks/task.js';
import {
  theme, BOX, progressBar, statusDot,
  ScreenBuffer, stripAnsi, padRight, renderPanel,
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

// ─── Overview mode renderer ─────────────────────────────────────────────────

function renderOverview(
  ctx: AppContext,
  agents: AgentInfo[],
  cols: number,
  rows: number,
  selectedIdx: number,
  logContent: string,
  sortedTasks: Task[],
): string {
  const buf = new ScreenBuffer(cols, rows);
  const tasks = ctx.queue.list();
  const pools = ctx.poolTracker.getAllPools();

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const titleBar = ' OpenHive ';
  const outerW = Math.min(cols, 80);
  const outerLeft = Math.max(0, Math.floor((cols - outerW) / 2));
  const topBarPad = outerW - 2 - titleBar.length - timeStr.length - 2;
  buf.write(0, outerLeft, theme.border(BOX.tl + BOX.h) + theme.title(titleBar) + theme.border(BOX.h.repeat(Math.max(0, topBarPad)) + ' ') + theme.dim(timeStr) + theme.border(' ' + BOX.tr));

  for (let r = 1; r < rows - 1; r++) {
    buf.write(r, outerLeft, theme.border(BOX.v));
    buf.write(r, outerLeft + outerW - 1, theme.border(BOX.v));
  }

  const keys = '  j/k select  Enter stream  x kill  r refresh  q quit';
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
    return `${dot} ${padRight(a.displayName, agentPanelW - 14)}${provColor(a.provider)}`;
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

  // ── Pool Usage panel (compact: 1 line per provider) ──
  const poolBarW = 8;
  const poolLines: string[] = [];
  for (const pool of pools) {
    const provColor = theme.providers[pool.provider] ?? chalk.white;
    const summary = ctx.poolTracker.getUsageSummary(pool.provider);

    if (summary.windows.length === 0) {
      // No known limits (e.g. cursor)
      const active = `${summary.activeCount}/${summary.maxConcurrent}`;
      poolLines.push(`${provColor(padRight(pool.provider, 11))}${theme.dim(active)}  ${theme.dim('N/A')}`);
      continue;
    }

    // Build compact window segments: "5h ████░░░░ 3  wk ████░░░░ 1"
    const segments: string[] = [];
    for (const win of summary.windows) {
      const bar = progressBar(win.used, win.limit ?? 0, poolBarW);
      const label = win.limit ? `${win.used}/${win.limit}` : String(win.used);
      let reset = '';
      if (win.resetInMs !== undefined && win.used > 0) {
        reset = theme.dim(` ${formatCountdown(win.resetInMs)}`);
      }
      segments.push(`${theme.dim(padRight(win.label, 4))}${bar} ${padRight(label, 6)}${reset}`);
    }

    const active = `${summary.activeCount}/${summary.maxConcurrent}`;
    poolLines.push(`${provColor(padRight(pool.provider, 11))}${theme.dim(active)}  ${segments.join('  ')}`);
  }
  const poolPanelH = poolLines.length + 2;
  const availRows = rows - curRow - 2;
  const poolH = Math.min(poolPanelH, Math.max(poolLines.length + 2, 4));
  renderPanel(buf, curRow, innerLeft, innerW, Math.min(poolH, availRows), 'Pools', poolLines);

  curRow += poolH + 1;

  // ── Task list (selectable) + live preview ──
  const hasLog = logContent.length > 0;
  const remainingRows = rows - curRow - 2;
  const taskPanelH = hasLog ? Math.max(Math.floor(remainingRows * 0.45), 4) : Math.max(remainingRows, 4);

  const recent = sortedTasks.slice(0, taskPanelH - 2);
  const recentLines = recent.map((t, i) => {
    const isSelected = i === selectedIdx;
    const dot = statusDot(t.status);
    const id = t.id.slice(0, 6);
    const status = padRight(t.status, 10);
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
  const outerW = Math.min(cols, 80);
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

  const getSortedTasks = (): Task[] => {
    const tasks = ctx.queue.list();
    return [...tasks].sort((a, b) => {
      const order: Record<string, number> = { running: 0, pending: 1, queued: 2, completed: 3, failed: 4, cancelled: 5 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });
  };

  const loadLogForTask = async (taskId: string) => {
    const logPath = join(process.cwd(), '.openhive', 'logs', `${taskId}.log`);
    try {
      logContent = await readFile(logPath, 'utf-8');
    } catch {
      logContent = '';
    }
  };

  await runTuiLoop({
    render: (cols, rows) => {
      if (mode === 'stream') {
        return renderStreamView(ctx, streamTaskId, logContent, cols, rows);
      }
      return renderOverview(ctx, agents, cols, rows, selectedIdx, logContent, sortedTasks);
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
        process.exit(0);
      }
      if (key === 'r') {
        agents = await gatherAgents(ctx);
      }
      if (key === 'j' && selectedIdx < sortedTasks.length - 1) {
        selectedIdx++;
        const task = sortedTasks[selectedIdx];
        if (task) await loadLogForTask(task.id);
      }
      if (key === 'k' && selectedIdx > 0) {
        selectedIdx--;
        const task = sortedTasks[selectedIdx];
        if (task) await loadLogForTask(task.id);
      }
      // Enter: switch to full-screen stream view
      if (key === '\r' || key === '\n') {
        const task = sortedTasks[selectedIdx];
        if (task) {
          mode = 'stream';
          streamTaskId = task.id;
          await loadLogForTask(task.id);
        }
      }
      // x: kill a running task
      if (key === 'x') {
        const task = sortedTasks[selectedIdx];
        if (task && task.status === 'running') {
          ctx.queue.update(task.id, {
            status: 'failed',
            error: 'Killed by user',
            completedAt: new Date().toISOString(),
          });
          await ctx.storage.save(ctx.queue.get(task.id)!);
          sortedTasks = getSortedTasks();
          if (selectedIdx >= sortedTasks.length) {
            selectedIdx = Math.max(0, sortedTasks.length - 1);
          }
        }
      }
    },
    onTick: async () => {
      try {
        const tasks = await ctx.storage.loadAll();
        ctx.queue.loadAll(tasks);
        await ctx.poolTracker.reloadUsageStore();
      } catch {
        // Ignore load errors
      }
      sortedTasks = getSortedTasks();
      if (selectedIdx >= sortedTasks.length) {
        selectedIdx = Math.max(0, sortedTasks.length - 1);
      }
      // Reload log for current view
      if (mode === 'stream' && streamTaskId) {
        await loadLogForTask(streamTaskId);
      } else if (sortedTasks[selectedIdx]) {
        await loadLogForTask(sortedTasks[selectedIdx].id);
      } else {
        logContent = '';
      }
    },
    intervalMs: 500,
  });
}
