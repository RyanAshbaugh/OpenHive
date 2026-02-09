import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  debug(msg: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.error(chalk.gray(`[${timestamp()}] DEBUG ${msg}`), ...args);
    }
  },

  info(msg: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.error(chalk.blue(`[${timestamp()}] INFO  ${msg}`), ...args);
    }
  },

  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.error(chalk.yellow(`[${timestamp()}] WARN  ${msg}`), ...args);
    }
  },

  error(msg: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(chalk.red(`[${timestamp()}] ERROR ${msg}`), ...args);
    }
  },
};
