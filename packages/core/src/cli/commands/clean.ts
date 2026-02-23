/**
 * `openhive clean` — kill orphaned processes, tmux sessions, and stale state.
 *
 *   openhive clean           # interactive: shows what it will do, asks to confirm
 *   openhive clean --force   # no confirmation
 *   openhive clean --tasks   # also wipe all task files from storage
 */

import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { printSuccess, printInfo, printError } from '../output.js';

const execFileAsync = promisify(execFile);

const OPENHIVE_DIR = join(homedir(), '.openhive');
const TASKS_DIR = join(OPENHIVE_DIR, 'tasks');
const STATE_FILE = join(OPENHIVE_DIR, 'orchestration-state.json');

const TMUX_SESSIONS = ['openhive-orch', 'openhive-probe'];

export function registerCleanCommand(program: Command): void {
  program
    .command('clean')
    .description('Kill orphaned processes, tmux sessions, and reset orchestration state')
    .option('--force', 'skip confirmation')
    .option('--tasks', 'also remove all task files from storage')
    .action(async (options: { force?: boolean; tasks?: boolean }) => {
      await clean(options);
    });
}

async function clean(options: { force?: boolean; tasks?: boolean }): Promise<void> {
  let acted = false;

  // 1. Kill openhive tmux sessions
  for (const session of TMUX_SESSIONS) {
    try {
      await execFileAsync('tmux', ['has-session', '-t', session], { timeout: 5000 });
      printInfo(`Killing tmux session: ${session}`);
      await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
      acted = true;
    } catch {
      // Session doesn't exist
    }
  }

  // 2. Kill orphaned agent processes (claude/codex/gemini spawned with -p flag)
  try {
    const { stdout } = await execFileAsync('pgrep', ['-lf', 'claude -p|codex -p|gemini -p'], { timeout: 5000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const pid = line.split(/\s+/)[0];
      if (pid) {
        printInfo(`Killing orphaned agent process: PID ${pid}`);
        await execFileAsync('kill', [pid]).catch(() => {});
        acted = true;
      }
    }
  } catch {
    // No matching processes
  }

  // 3. Reset orchestration state file
  try {
    const stoppedState = JSON.stringify({
      status: 'stopped',
      workers: [],
      pendingTaskCount: 0,
      completedTaskCount: 0,
      failedTaskCount: 0,
      updatedAt: new Date().toISOString(),
    }, null, 2);
    await writeFile(STATE_FILE, stoppedState, 'utf-8');
    printInfo('Reset orchestration state');
    acted = true;
  } catch {
    // File doesn't exist, that's fine
  }

  // 4. Cancel stale pending/running tasks (always), or wipe all with --tasks
  try {
    const files = await readdir(TASKS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    if (options.tasks) {
      // --tasks: remove ALL task files
      for (const file of jsonFiles) {
        await rm(join(TASKS_DIR, file));
      }
      if (jsonFiles.length > 0) {
        printInfo(`Removed ${jsonFiles.length} task file${jsonFiles.length === 1 ? '' : 's'}`);
        acted = true;
      }
    } else {
      // Default: mark pending/running tasks as cancelled
      let cancelled = 0;
      for (const file of jsonFiles) {
        const filePath = join(TASKS_DIR, file);
        try {
          const raw = await readFile(filePath, 'utf-8');
          const task = JSON.parse(raw);
          if (task.status === 'pending' || task.status === 'running') {
            task.status = 'cancelled';
            task.completedAt = new Date().toISOString();
            await writeFile(filePath, JSON.stringify(task, null, 2), 'utf-8');
            cancelled++;
          }
        } catch {
          // Malformed task file, skip
        }
      }
      if (cancelled > 0) {
        printInfo(`Cancelled ${cancelled} stale task${cancelled === 1 ? '' : 's'}`);
        acted = true;
      }
    }
  } catch {
    // Dir doesn't exist
  }

  // 5. Clean up temp dirs
  try {
    const { stdout } = await execFileAsync('ls', ['-d',
      '/tmp/openhive-selfheal-*',
      '/tmp/openhive-fix-*',
      '/tmp/openhive-e2e-*',
    ], { timeout: 5000 });
    const dirs = stdout.trim().split('\n').filter(Boolean);
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
      acted = true;
    }
    if (dirs.length > 0) {
      printInfo(`Removed ${dirs.length} temp dir${dirs.length === 1 ? '' : 's'}`);
    }
  } catch {
    // No temp dirs
  }

  if (acted) {
    printSuccess('Clean slate');
  } else {
    printInfo('Nothing to clean up');
  }
}
