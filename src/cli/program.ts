import { Command } from 'commander';
import { setJsonOutput } from './output.js';
import { registerInitCommand } from './commands/init.js';
import { registerRunCommand } from './commands/run.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerStatusCommand } from './commands/status.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerPoolCommand } from './commands/pool.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerReviewCommands } from './commands/review.js';
import { registerDashboardCommand } from './commands/dashboard.js';

function createProgram(): Command {
  const program = new Command();

  program
    .name('openhive')
    .description('CLI-first multi-agent orchestrator for AI coding agents')
    .version('0.1.0')
    .option('--json', 'output in JSON format')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts.json) {
        setJsonOutput(true);
      }
    });

  registerInitCommand(program);
  registerRunCommand(program);
  registerTasksCommand(program);
  registerStatusCommand(program);
  registerAgentsCommand(program);
  registerPoolCommand(program);
  registerLogsCommand(program);
  registerReviewCommands(program);
  registerDashboardCommand(program);

  return program;
}

export async function run(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
