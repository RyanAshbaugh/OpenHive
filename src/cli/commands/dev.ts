import type { Command } from 'commander';
import { spawn } from 'node:child_process';

function run(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}

export function registerDevCommands(program: Command): void {
  program
    .command('build')
    .description('Compile TypeScript')
    .action(() => {
      run('npx', ['tsc']);
    });

  program
    .command('dev')
    .description('Watch mode (recompile on change)')
    .action(() => {
      run('npx', ['tsc', '--watch']);
    });

  program
    .command('lint')
    .description('Type-check without emitting')
    .action(() => {
      run('npx', ['tsc', '--noEmit']);
    });
}
