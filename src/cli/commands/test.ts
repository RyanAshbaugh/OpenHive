import type { Command } from 'commander';
import { spawn, execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { runWithSelfHealing } from './self-heal.js';

function run(command: string, args: string[], env?: Record<string, string>): void {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : undefined,
  });
  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}

export function registerTestCommand(program: Command): void {
  const test = program
    .command('test')
    .description('Run tests')
    .option('-w, --watch', 'run in watch mode')
    .action((opts) => {
      if (opts.watch) {
        run('npx', ['vitest']);
      } else {
        run('npx', ['vitest', 'run']);
      }
    });

  test
    .command('e2e')
    .description('Run end-to-end tests')
    .option('--tier <n>', 'run only the specified tier')
    .option('--keep', 'keep test artifacts after run')
    .option('--cleanup', 'kill tmux sessions and remove temp dirs')
    .option('--self-heal', 'auto-fix failures using an agent and retry')
    .option('--self-heal-retries <n>', 'max retries for self-heal (default 3)', '3')
    .option('--self-heal-agent <name>', 'agent for self-heal fixes (default claude)', 'claude')
    .action(async (opts) => {
      if (opts.cleanup) {
        await cleanup();
        return;
      }

      const args = ['vitest', 'run', '--config', 'vitest.e2e.config.ts'];
      const env: Record<string, string> = {};

      if (opts.tier) {
        args.push('-t', `Tier ${opts.tier}`);
      }

      if (opts.keep) {
        env['OPENHIVE_KEEP_ARTIFACTS'] = '1';
      }

      if (opts.selfHeal) {
        const result = await runWithSelfHealing({
          command: 'npx',
          args,
          agent: opts.selfHealAgent,
          maxRetries: parseInt(opts.selfHealRetries, 10),
        });
        if (!result.success) {
          console.error(`Self-heal failed after ${result.attempts} attempts`);
          process.exit(1);
        }
        console.log(`Tests passed after ${result.attempts} attempt(s)`);
        return;
      }

      run('npx', args, Object.keys(env).length > 0 ? env : undefined);
    });
}

async function cleanup(): Promise<void> {
  // Kill only openhive-related tmux sessions
  const sessionPrefixes = ['openhive-orch', 'openhive-probe'];
  let killedAny = false;
  for (const session of sessionPrefixes) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('tmux', ['kill-session', '-t', session], (error) => {
          if (error) {
            resolve(); // session doesn't exist, that's fine
          } else {
            console.log(`Killed tmux session: ${session}`);
            killedAny = true;
            resolve();
          }
        });
      });
    } catch {
      // ignore
    }
  }
  if (!killedAny) {
    console.log('No openhive tmux sessions to kill');
  }

  // Remove temp dirs
  const tmp = tmpdir();
  try {
    const entries = readdirSync(tmp);
    const dirs = entries.filter((e) => e.startsWith('openhive-e2e-'));
    for (const dir of dirs) {
      await rm(join(tmp, dir), { recursive: true, force: true });
      console.log(`Removed ${join(tmp, dir)}`);
    }
    if (dirs.length === 0) {
      console.log('No temp dirs to clean up');
    }
  } catch {
    console.log('No temp dirs to clean up');
  }
}
