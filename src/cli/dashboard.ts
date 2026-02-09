import chalk from 'chalk';
import type { AppContext } from './context.js';
import {
  theme, BOX, progressBar, statusDot,
  ScreenBuffer, stripAnsi, padRight, renderPanel,
  runTuiLoop,
} from './tui.js';

// ─── Unicode Helpers ────────────────────────────────────────────────────────

const SPARK = '▁▂▃▄▅▆▇█';

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  return values.map(v => {
    const idx = Math.round((v / max) * 7);
    return chalk.cyan(SPARK[idx]);
  }).join('');
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

function renderDashboard(
  ctx: AppContext,
  agents: AgentInfo[],
  cols: number,
  rows: number,
): string {
  const buf = new ScreenBuffer(cols, rows);
  const tasks = ctx.queue.list();
  const pools = ctx.poolTracker.getAllPools();

  // ─── Outer frame ──────────────────────────────
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

  // Bottom bar with keys
  const keys = '  q quit  r refresh agents';
  const bottomPad = outerW - 2 - keys.length;
  buf.write(rows - 1, outerLeft, theme.border(BOX.bl) + theme.dim(keys) + theme.border(BOX.h.repeat(Math.max(0, bottomPad)) + BOX.br));

  // ─── Inner layout ─────────────────────────────
  const innerLeft = outerLeft + 2;
  const innerW = outerW - 4;
  let curRow = 2;

  // ── Agents + Tasks (side by side) ─────────────
  const agentPanelW = Math.floor(innerW * 0.4);
  const taskPanelW = innerW - agentPanelW - 1;

  // Agent panel content
  const agentLines = agents.map(a => {
    const dot = a.available ? theme.success('●') : theme.dim('○');
    const provColor = theme.providers[a.provider] ?? chalk.white;
    return `${dot} ${padRight(a.displayName, agentPanelW - 14)}${provColor(a.provider)}`;
  });
  const agentPanelH = Math.max(agents.length + 2, 4);
  renderPanel(buf, curRow, innerLeft, agentPanelW, agentPanelH, 'Agents', agentLines);

  // Tasks summary panel content
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'queued').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const total = Math.max(pending + running + completed + failed, 1);
  const barW = 10;

  const taskLines = [
    `${padRight('Pending', 12)}${progressBar(pending, total, barW)}  ${pending}`,
    `${padRight('Running', 12)}${progressBar(running, total, barW)}  ${running}`,
    `${padRight('Completed', 12)}${progressBar(completed, total, barW)}  ${completed}`,
    `${padRight('Failed', 12)}${progressBar(failed, total, barW)}  ${failed}`,
  ];
  renderPanel(buf, curRow, innerLeft + agentPanelW + 1, taskPanelW, agentPanelH, 'Tasks', taskLines);

  curRow += agentPanelH + 1;

  // ── Pool Usage panel ──────────────────────────
  const poolBarW = 20;
  const poolLines: string[] = [];
  for (const pool of pools) {
    const provColor = theme.providers[pool.provider] ?? chalk.white;
    const active = `Active ${pool.activeCount}/${pool.maxConcurrent}`;
    poolLines.push(`${provColor(padRight(pool.provider, 14))}${theme.dim(active)}`);

    const daily = ctx.poolTracker.getDailyUsage(pool.provider);
    const dailyLimit = ctx.poolTracker.getDailyLimit(pool.provider);
    const dBar = progressBar(daily.dispatched, dailyLimit ?? 0, poolBarW);
    const dLabel = dailyLimit ? `${daily.dispatched}/${dailyLimit}` : String(daily.dispatched);
    poolLines.push(`  ${padRight('Daily', 8)}${dBar}  ${dLabel}`);

    const weekly = ctx.poolTracker.getWeeklyUsage(pool.provider);
    const weeklyLimit = ctx.poolTracker.getWeeklyLimit(pool.provider);
    const wBar = progressBar(weekly.dispatched, weeklyLimit ?? 0, poolBarW);
    const wLabel = weeklyLimit ? `${weekly.dispatched}/${weeklyLimit}` : String(weekly.dispatched);
    poolLines.push(`  ${padRight('Weekly', 8)}${wBar}  ${wLabel}`);

    poolLines.push('');
  }
  if (poolLines.length > 0 && poolLines[poolLines.length - 1] === '') {
    poolLines.pop();
  }
  const poolPanelH = poolLines.length + 2;
  const availRows = rows - curRow - 2;
  const poolH = Math.min(poolPanelH, Math.floor(availRows * 0.55));
  renderPanel(buf, curRow, innerLeft, innerW, poolH, 'Pool Usage', poolLines);

  curRow += poolH + 1;

  // ── Recent Tasks panel ────────────────────────
  const remainingRows = rows - curRow - 2;
  const recentH = Math.max(remainingRows, 4);
  const sorted = [...tasks].sort((a, b) => {
    const order: Record<string, number> = { running: 0, pending: 1, queued: 2, completed: 3, failed: 4, cancelled: 5 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });
  const recent = sorted.slice(0, recentH - 2);
  const recentLines = recent.map(t => {
    const dot = statusDot(t.status);
    const id = t.id.slice(0, 6);
    const status = padRight(t.status, 10);
    const agent = padRight(t.agent ?? '-', 8);
    const dur = t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : '';
    const promptW = innerW - 40;
    const prompt = t.prompt.length > promptW ? t.prompt.slice(0, promptW - 3) + '...' : t.prompt;
    return `${dot} ${theme.dim(id)}  ${status} ${agent} ${prompt}  ${theme.dim(dur)}`;
  });
  if (recentLines.length === 0) {
    recentLines.push(theme.dim('No tasks yet. Use `openhive run` to create one.'));
  }
  renderPanel(buf, curRow, innerLeft, innerW, recentH, 'Recent Tasks', recentLines);

  return buf.flush();
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

export async function runDashboard(ctx: AppContext): Promise<void> {
  let agents = await gatherAgents(ctx);

  await runTuiLoop({
    render: (cols, rows) => renderDashboard(ctx, agents, cols, rows),
    onKey: async (key) => {
      if (key === 'q') {
        process.exit(0);
      }
      if (key === 'r') {
        agents = await gatherAgents(ctx);
      }
    },
    onTick: async () => {
      try {
        const tasks = await ctx.storage.loadAll();
        ctx.queue.loadAll(tasks);
        await ctx.poolTracker.reloadUsageStore();
      } catch {
        // Ignore load errors in dashboard
      }
    },
    intervalMs: 1000,
  });
}
