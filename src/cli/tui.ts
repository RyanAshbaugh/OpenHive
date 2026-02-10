import chalk, { type ChalkInstance } from 'chalk';

// ─── Theme ──────────────────────────────────────────────────────────────────

export const theme = {
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

export const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } as const;
const FRACTIONAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function progressBar(value: number, max: number, width: number): string {
  if (max <= 0) {
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

export function statusDot(status: string): string {
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

export class ScreenBuffer {
  private lines: string[];
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.lines = Array(rows).fill('');
  }

  write(row: number, col: number, text: string): void {
    if (row < 0 || row >= this.rows) return;
    const line = this.lines[row];
    const visible = stripAnsi(line);
    if (visible.length < col) {
      this.lines[row] = line + ' '.repeat(col - visible.length) + text;
    } else {
      const before = sliceVisible(line, 0, col);
      const after = sliceVisible(line, col + stripAnsi(text).length);
      this.lines[row] = before + text + after;
    }
  }

  flush(): string {
    return this.lines.join('\n');
  }
}

// ─── String Helpers ─────────────────────────────────────────────────────────

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function sliceVisible(str: string, start: number, end?: number): string {
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
    if (visIdx >= start && (end === undefined || visIdx <= (end ?? Infinity))) {
      result += match[0];
    }
    lastIdx = match.index + match[0].length;
  }
  const remaining = str.slice(lastIdx);
  for (const ch of remaining) {
    if (visIdx >= start && (end === undefined || visIdx < end)) {
      result += ch;
    }
    visIdx++;
  }
  return result;
}

export function pad(text: string, width: number): string {
  const vis = stripAnsi(text).length;
  if (vis >= width) return sliceVisible(text, 0, width);
  return text + ' '.repeat(width - vis);
}

export function padRight(text: string, width: number): string {
  return pad(text, width);
}

// ─── Panel Rendering ────────────────────────────────────────────────────────

export function renderPanel(
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

  const titleStr = title ? ` ${title} ` : '';
  const topLine = border(BOX.tl + BOX.h) + theme.title(titleStr) + border(BOX.h.repeat(Math.max(0, innerW - stripAnsi(titleStr).length - 1)) + BOX.tr);
  buf.write(row, col, topLine);

  for (let i = 0; i < height - 2; i++) {
    const line = i < content.length ? content[i] : '';
    buf.write(row + 1 + i, col, border(BOX.v) + ' ' + padRight(line, innerW - 1) + border(BOX.v));
  }

  buf.write(row + height - 1, col, border(BOX.bl + BOX.h.repeat(innerW) + BOX.br));
}

// ─── TUI Loop ───────────────────────────────────────────────────────────────

export interface TuiLoopOptions {
  render: (cols: number, rows: number) => string;
  onKey: (key: string) => void | Promise<void>;
  intervalMs?: number;
  onTick?: () => void | Promise<void>;
}

export async function runTuiLoop(options: TuiLoopOptions): Promise<void> {
  const stdout = process.stdout;
  if (!stdout.isTTY) {
    console.error('This command requires a TTY terminal.');
    process.exit(1);
  }

  stdout.write('\x1b[?1049h');
  stdout.write('\x1b[?25l');

  let running = true;

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf-8');

  const cleanup = () => {
    running = false;
    stdout.write('\x1b[?25h');
    stdout.write('\x1b[?1049l');
    stdin.setRawMode(false);
    stdin.pause();
  };

  stdin.on('data', async (key: string) => {
    if (key === '\x03') { // Ctrl+C always quits
      cleanup();
      process.exit(0);
    }
    await options.onKey(key);
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  const paint = () => {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const frame = options.render(cols, rows);
    stdout.write('\x1b[H');
    stdout.write(frame);
  };

  stdout.on('resize', paint);

  const tick = async () => {
    if (!running) return;
    if (options.onTick) await options.onTick();
    paint();
  };

  await tick();

  const interval = setInterval(tick, options.intervalMs ?? 1000);

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
