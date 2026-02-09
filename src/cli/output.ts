import chalk from 'chalk';
import Table from 'cli-table3';

let jsonMode = false;

export function setJsonOutput(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonOutput(): boolean {
  return jsonMode;
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printTable(headers: string[], rows: string[][]): void {
  if (jsonMode) {
    const data = rows.map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
    printJson(data);
    return;
  }

  const table = new Table({
    head: headers.map(h => chalk.cyan(h)),
    style: { head: [], border: [] },
  });
  table.push(...rows);
  console.log(table.toString());
}

export function printSuccess(msg: string): void {
  if (jsonMode) {
    printJson({ status: 'success', message: msg });
  } else {
    console.log(chalk.green('✓ ') + msg);
  }
}

export function printError(msg: string): void {
  if (jsonMode) {
    printJson({ status: 'error', message: msg });
  } else {
    console.error(chalk.red('✗ ') + msg);
  }
}

export function printInfo(msg: string): void {
  if (jsonMode) {
    printJson({ status: 'info', message: msg });
  } else {
    console.log(chalk.blue('ℹ ') + msg);
  }
}

export function printWarning(msg: string): void {
  if (jsonMode) {
    printJson({ status: 'warning', message: msg });
  } else {
    console.log(chalk.yellow('⚠ ') + msg);
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'running': case 'active': return chalk.blue(status);
    case 'completed': return chalk.green(status);
    case 'failed': return chalk.red(status);
    case 'pending': case 'queued': return chalk.yellow(status);
    case 'cancelled': case 'paused': case 'archived': return chalk.gray(status);
    default: return status;
  }
}
