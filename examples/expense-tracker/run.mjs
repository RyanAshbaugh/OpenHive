#!/usr/bin/env node

/**
 * Expense Tracker Dashboard — One-command runner
 *
 * Usage: node examples/expense-tracker/run.mjs /path/to/target-dir
 *
 * This script:
 * 1. Creates the target directory, runs git init + npm init
 * 2. Copies the spec into .openhive/spec.json5
 * 3. Runs openhive launch
 * 4. Prints results
 */

import { execFileSync, execSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const openhive = resolve(__dirname, '..', '..', 'bin', 'openhive.mjs');
const specFile = resolve(__dirname, 'spec.json5');
const targetDir = process.argv[2];

if (!targetDir) {
  console.error('Usage: node examples/expense-tracker/run.mjs <target-dir>');
  console.error('');
  console.error('  <target-dir>  Path to an empty directory where the app will be built');
  process.exit(1);
}

const absTarget = resolve(targetDir);

function run(command, args, opts = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  try {
    const result = execFileSync(command, args, {
      cwd: absTarget,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000, // 10 min
      ...opts,
    });
    if (result.trim()) console.log(result.trim());
    return result;
  } catch (err) {
    console.error(`Command failed: ${err.stderr || err.message}`);
    return '';
  }
}

console.log('=== OpenHive: Expense Tracker Dashboard ===\n');
console.log(`Target: ${absTarget}`);
console.log(`Spec:   ${specFile}`);

// Step 1: Set up target directory
console.log('\n--- Step 1: Initialize target directory ---');

if (!existsSync(absTarget)) {
  mkdirSync(absTarget, { recursive: true });
  console.log(`Created ${absTarget}`);
}

if (!existsSync(join(absTarget, '.git'))) {
  run('git', ['init']);
}

if (!existsSync(join(absTarget, 'package.json'))) {
  run('npm', ['init', '-y']);
}

// Step 2: Copy spec
console.log('\n--- Step 2: Copy spec into .openhive/ ---');
const openhiveDir = join(absTarget, '.openhive');
if (!existsSync(openhiveDir)) {
  mkdirSync(openhiveDir, { recursive: true });
}
copyFileSync(specFile, join(openhiveDir, 'spec.json5'));
console.log(`Copied spec.json5 to ${openhiveDir}`);

// Step 3: Initialize OpenHive
console.log('\n--- Step 3: Initialize OpenHive ---');
run('node', [openhive, 'init']);

// Step 4: Preview the plan
console.log('\n--- Step 4: Execution Plan ---');
run('node', [openhive, 'launch', '--dry-run']);

// Step 5: Launch
console.log('\n--- Step 5: Launching hive ---');
run('node', [openhive, 'launch'], { timeout: 1800_000 }); // 30 min for full run

// Step 6: Results
console.log('\n--- Step 6: Results ---');
run('node', [openhive, 'tasks']);

console.log('\n=== Done! ===');
console.log('');
console.log('Next steps:');
console.log(`  cd ${absTarget}`);
console.log('  npm run dev              # Start the app');
console.log('  open http://localhost:3000  # Login with test@test.com / password');
console.log('');
console.log('Review what the hive built:');
console.log('  openhive tasks           # List all tasks');
console.log('  openhive logs <task-id>  # See agent output');
console.log('  ls .openhive/screenshots/ # View verification screenshots');
