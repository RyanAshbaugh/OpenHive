import chalk, { type ChalkInstance } from 'chalk';
import type { AppContext } from './context.js';

// ─── Theme ──────────────────────────────────────────────────────────────────

const theme = {
  border: chalk.gray,
  borderFocus: chalk.cyan,
  title: chalk.bold.white,
  header: chalk.bold.cyan,
  dim: chalk.dim,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.blue,
  providers: {
    anthropic: chalk.hex('#D4A574'),
    openai: chalk.hex('#74AA9C'),
    google: chalk.hex('#4285F4'),
    cursor: chalk.hex('#FF6B6B'),
  } as Record<string, ChalkInstance>,
  gradient(pct: number): ChalkInstance {
    if (pct < 0.6) return chalk.green;
    if (pct < 0.85) return chalk.yellow;
    return chalk.red;
  },
};

// ─── Unicode Helpers ────────────────────────────────────────────────────────

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } as const;
const BLOCKS = '░▒▓█';
const FRACTIONAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARK = '▁▂▃▄▅▆▇█';

function progressBar(value: number, max: number, width: number): string {
  if (max <= 0) {
    // No limit — just show count as dim bar
    const pct = Math.min(value / Math.max(value, 1), 1);
    const filled = Math.min(value, width);
    return chalk.dim('█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled)));
  }
  const pct = Math.min(value / max, 1);
  const total = pct * width;
  const full = Math.floor(total);
  const frac = Math.round((total - full) * 7);
  const empty = width - full - (frac > 0 ? 1 : 0);
  const color = theme.gradient(pct);
  return color('█'.repeat(full) + (frac > 0 ? FRACTIONAL[frac] : '')) + chalk.gray('░'.repeat(Math.max(0, empty)));
}

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  return values.map(v => {
    const idx = Math.round((v / max) * 7);
    return chalk.cyan(SPARK[idx]);
  }).join('');
}

function statusDot(status: string): string {
  switch (status) {
    case 'running': return theme.info('●');
    case 'completed': return theme.success('○');
    case 'failed': return theme.error('✗');
    case 'pending': case 'queued': return theme.warning('●');
    case 'cancelled': return theme.dim('○');
    default: return theme.dim('○');
  }
}

// ─── Screen Buffer ──────────────────────────────────────────────────────────

class ScreenBuffer {
  private lines: string[];
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.lines = Array(rows).fill('');
  }

  /** Write text at (row, col). row/col are 0-based. */
  write(row: number, col: number, text: string): void {
    if (row < 0 || row >= this.rows) return;
    const line = this.lines[row];
    // Pad if needed
    const visible = stripAnsi(line);
    if (visible.length < col) {
      this.lines[row] = line + ' '.repeat(col - visible.length) + text;
    } else {
      // Overwrite at position — we work with the raw string
      // For simplicity, build line from pieces
      const before = sliceVisible(line, 0, col);
      const after = sliceVisible(line, col + stripAnsi(text).length);
      this.lines[row] = before + text + after;
    }
  }

  flush(): string {
    return this.lines.join('\n');
  }
}

/** Strip ANSI escape codes to get visible length */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Slice a styled string by visible character positions */
function sliceVisible(str: string, start: number, end?: number): string {
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\x1b\[[0-9;]*m/g;
  let result = '';
  let visIdx = 0;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = ansiRe.exec(str)) !== null) {
    const textBefore = str.slice(lastIdx, match.index);
    for (const ch of textBefore) {
      if (visIdx >= start && (end === undefined || visIdx < end)) {
        result += ch;
      }
      visIdx++;
    }
    // Always include ANSI codes that are within range
    if (visIdx >= start && (end === undefined || visIdx <= (end ?? Infinity))) {
      result += match[0];
    }
    lastIdx = match.index + match[0].length;
  }
  // Remaining text
  const remaining = str.slice(lastIdx);
  for (const ch of remaining) {
    if (visIdx >= start && (end === undefined || visIdx < end)) {
      result += ch;
    }
    visIdx++;
  }
  return result;
}

function pad(text: string, width: number): string {
  const vis = stripAnsi(text).length;
  if (vis >= width) return sliceVisible(text, 0, width);
  return text + ' '.repeat(width - vis);
}

function padRight(text: string, width: number): string {
  return pad(text, width);
}

// ─── Panel Rendering ────────────────────────────────────────────────────────

function renderPanel(
  buf: ScreenBuffer,
  row: number,
  col: number,
  width: number,
  height: number,
  title: string,
  content: string[],
  focused = false,
): void {
  const border = focused ? theme.borderFocus : theme.border;
  const innerW = width - 2;

  // Top border
  const titleStr = title ? ` ${title} ` : '';
  const topLine = border(BOX.tl + BOX.h) + theme.title(titleStr) + border(BOX.h.repeat(Math.max(0, innerW - stripAnsi(titleStr).length)) + BOX.tr);
  buf.write(row, col, topLine);

  // Content rows
  for (let i = 0; i < height - 2; i++) {
    const line = i < content.length ? content[i] : '';
    buf.write(row + 1 + i, col, border(BOX.v) + ' ' + padRight(line, innerW - 1) + border(BOX.v));
  }

  // Bottom border
  buf.write(row + height - 1, col, border(BOX.bl + BOX.h.repeat(innerW) + BOX.br));
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
  const availRows = rows - curRow - 2; // leave room for recent tasks + bottom
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
  const stdout = process.stdout;
  if (!stdout.isTTY) {
    console.error('Dashboard requires a TTY terminal.');
    process.exit(1);
  }

  // Enter alternate screen, hide cursor
  stdout.write('\x1b[?1049h');
  stdout.write('\x1b[?25l');

  let running = true;
  let agents = await gatherAgents(ctx);

  // Enable raw mode for keypress
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf-8');

  const cleanup = () => {
    running = false;
    // Restore terminal
    stdout.write('\x1b[?25h'); // show cursor
    stdout.write('\x1b[?1049l'); // leave alternate screen
    stdin.setRawMode(false);
    stdin.pause();
  };

  stdin.on('data', async (key: string) => {
    if (key === 'q' || key === '\x03') { // q or Ctrl+C
      cleanup();
      process.exit(0);
    }
    if (key === 'r') {
      agents = await gatherAgents(ctx);
      paint();
    }
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  const paint = () => {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const frame = renderDashboard(ctx, agents, cols, rows);
    stdout.write('\x1b[H'); // cursor to top-left
    stdout.write(frame);
  };

  // Handle resize
  stdout.on('resize', paint);

  // Render loop
  const tick = async () => {
    if (!running) return;
    // Reload data from disk
    try {
      const tasks = await ctx.storage.loadAll();
      ctx.queue.loadAll(tasks);
      await ctx.poolTracker.reloadUsageStore();
    } catch {
      // Ignore load errors in dashboard
    }
    paint();
  };

  // Initial paint
  await tick();

  // 1-second interval
  const interval = setInterval(tick, 1000);

  // Keep alive until cleanup
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(interval);
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}
