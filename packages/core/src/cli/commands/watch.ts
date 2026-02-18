import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { readSession } from '../../specs/session.js';
import type { LaunchSession } from '../../specs/session.js';
import {
  theme, BOX, progressBar, statusDot,
  ScreenBuffer, padRight, renderPanel, stripAnsi,
  runTuiLoop,
} from '../tui.js';

// ─── Single-task tail mode ──────────────────────────────────────────────────

async function tailTask(taskId: string): Promise<void> {
  const ctx = await getContext();
  const task = ctx.queue.get(taskId);

  if (!task) {
    console.error(chalk.red(`Task ${taskId} not found`));
    process.exitCode = 1;
    return;
  }

  const logPath = task.logFile ?? join(process.cwd(), '.openhive', 'logs', `${taskId}.log`);
  let offset = 0;

  const poll = async () => {
    try {
      const info = await stat(logPath);
      if (info.size > offset) {
        const buf = Buffer.alloc(info.size - offset);
        const { open } = await import('node:fs/promises');
        const fh = await open(logPath, 'r');
        await fh.read(buf, 0, buf.length, offset);
        await fh.close();
        process.stdout.write(buf.toString());
        offset = info.size;
      }
    } catch {
      // Log file doesn't exist yet — wait
    }

    // Check if task is done
    const tasks = await ctx.storage.loadAll();
    ctx.queue.loadAll(tasks);
    const current = ctx.queue.get(taskId);
    if (current && (current.status === 'completed' || current.status === 'failed')) {
      // One last read to catch remaining output
      try {
        const info = await stat(logPath);
        if (info.size > offset) {
          const buf = Buffer.alloc(info.size - offset);
          const { open } = await import('node:fs/promises');
          const fh = await open(logPath, 'r');
          await fh.read(buf, 0, buf.length, offset);
          await fh.close();
          process.stdout.write(buf.toString());
        }
      } catch {
        // ignore
      }

      const statusStr = current.status === 'completed'
        ? chalk.green('completed')
        : chalk.red('failed');
      console.log(`\n${chalk.dim('---')} Task ${statusStr}${current.durationMs ? chalk.dim(` in ${(current.durationMs / 1000).toFixed(1)}s`) : ''}`);
      return;
    }
  };

  // Initial read
  await poll();

  // Poll loop
  await new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      const current = ctx.queue.get(taskId);
      if (current && (current.status === 'completed' || current.status === 'failed')) {
        clearInterval(interval);
        await poll();
        resolve();
        return;
      }
      await poll();
    }, 200);

    // Allow Ctrl+C to exit
    process.on('SIGINT', () => {
      clearInterval(interval);
      resolve();
    });
  });
}

// ─── Full-screen watch mode ─────────────────────────────────────────────────

async function watchFullScreen(): Promise<void> {
  const sessionDir = join(process.cwd(), '.openhive');
  const ctx = await getContext();
  let session: LaunchSession | null = null;
  let selectedIdx = 0;
  let logContent = '';

  const getAllTasks = () => {
    if (!session) return [];
    return session.waves.flatMap(w => w.tasks);
  };

  const loadLogForSelected = async () => {
    const tasks = getAllTasks();
    if (tasks.length === 0) {
      logContent = '';
      return;
    }
    const selected = tasks[selectedIdx];
    if (!selected?.internalId) {
      logContent = '';
      return;
    }
    const logPath = join(sessionDir, 'logs', `${selected.internalId}.log`);
    try {
      logContent = await readFile(logPath, 'utf-8');
    } catch {
      logContent = '';
    }
  };

  const render = (cols: number, rows: number): string => {
    const buf = new ScreenBuffer(cols, rows);
    const outerW = Math.min(cols, 80);
    const outerLeft = Math.max(0, Math.floor((cols - outerW) / 2));
    const innerLeft = outerLeft + 1;
    const innerW = outerW - 2;

    if (!session) {
      const noSession = [theme.dim('No active launch session found.'), '', theme.dim('Run `openhive launch <spec>` to start one.')];
      renderPanel(buf, 0, outerLeft, outerW, 5, 'Watch', noSession);
      return buf.flush();
    }

    // ── Top panel: Launch overview ──
    const topLines: string[] = [];
    const tasks = getAllTasks();

    for (const wave of session.waves) {
      const completedCount = wave.tasks.filter(t => t.status === 'completed').length;
      const total = wave.tasks.length;
      const barW = 16;
      const bar = wave.status === 'pending'
        ? chalk.gray('░'.repeat(barW))
        : progressBar(completedCount, total, barW);
      const statusLabel = wave.status === 'running'
        ? theme.info(wave.status)
        : wave.status === 'completed'
          ? theme.success(wave.status)
          : wave.status === 'failed'
            ? theme.error(wave.status)
            : theme.dim(wave.status);
      topLines.push(`  Wave ${wave.number}/${session.totalWaves}  ${bar}  ${completedCount}/${total} ${statusLabel}`);

      for (const task of wave.tasks) {
        const globalIdx = tasks.indexOf(task);
        const isSelected = globalIdx === selectedIdx;
        const dot = statusDot(task.status);
        const agentStr = task.agent ? chalk.gray(`(${task.agent})`) : '';
        const prefix = isSelected ? theme.borderFocus('> ') : '  ';
        const dur = task.internalId
          ? (() => {
              const t = ctx.queue.get(task.internalId);
              if (t?.durationMs) return theme.dim(`${(t.durationMs / 1000).toFixed(1)}s`);
              if (t?.startedAt && t.status === 'running') {
                const elapsed = (Date.now() - new Date(t.startedAt).getTime()) / 1000;
                return theme.dim(`${elapsed.toFixed(0)}s...`);
              }
              return '';
            })()
          : '';
        topLines.push(`  ${prefix}${dot} ${padRight(task.specId, 18)} ${padRight(agentStr, 12)} ${padRight(task.status, 10)} ${dur}`);
      }
    }

    const topPanelH = Math.min(topLines.length + 2, Math.floor(rows * 0.55));
    const launchTitle = `Launch: ${session.specName}`;
    renderPanel(buf, 0, outerLeft, outerW, topPanelH, launchTitle, topLines);

    // ── Bottom panel: Live log output ──
    const bottomStart = topPanelH + 1;
    const bottomH = Math.max(rows - bottomStart - 1, 4);

    const selected = tasks[selectedIdx];
    const logTitle = selected
      ? `Live Output: ${selected.specId}${selected.agent ? ` (${selected.agent})` : ''}`
      : 'Live Output';

    const logLines = logContent ? logContent.split('\n').slice(-(bottomH - 2)) : [theme.dim('No output yet.')];
    const maxLineW = innerW - 2;
    const truncatedLogLines = logLines.map(l => {
      if (stripAnsi(l).length > maxLineW) {
        return l.slice(0, maxLineW - 3) + '...';
      }
      return l;
    });

    renderPanel(buf, bottomStart, outerLeft, outerW, bottomH, logTitle, truncatedLogLines);

    // Footer
    const footer = theme.dim('  j/k select  q quit');
    buf.write(rows - 1, outerLeft, footer);

    return buf.flush();
  };

  await runTuiLoop({
    render,
    onKey: async (key) => {
      const tasks = getAllTasks();
      if (key === 'q') {
        process.exit(0);
      }
      if (key === 'j' && selectedIdx < tasks.length - 1) {
        selectedIdx++;
        await loadLogForSelected();
      }
      if (key === 'k' && selectedIdx > 0) {
        selectedIdx--;
        await loadLogForSelected();
      }
    },
    onTick: async () => {
      session = await readSession(sessionDir);
      // Reload tasks from disk
      try {
        const tasks = await ctx.storage.loadAll();
        ctx.queue.loadAll(tasks);
      } catch {
        // ignore
      }
      await loadLogForSelected();
    },
    intervalMs: 500,
  });
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerWatchCommand(program: Command): void {
  program
    .command('watch [task-id]')
    .description('Watch a running launch or tail a specific task\'s output')
    .action(async (taskId?: string) => {
      if (taskId) {
        await tailTask(taskId);
      } else {
        await watchFullScreen();
      }
    });
}
