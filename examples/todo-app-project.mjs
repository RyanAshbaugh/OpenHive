#!/usr/bin/env node

/**
 * Example: Build a Todo CLI App using OpenHive
 *
 * Usage: node examples/todo-app-project.mjs [target-repo-path]
 *
 * This demonstrates OpenHive dispatching multiple tasks to AI agents,
 * each running in its own git worktree for isolation.
 */

import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const openhive = resolve(import.meta.dirname, '..', 'bin', 'openhive.mjs');
const targetDir = process.argv[2] || process.cwd();

function run(args, opts = {}) {
  console.log(`\n$ openhive ${args.join(' ')}`);
  try {
    const result = execFileSync('node', [openhive, ...args], {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5 min per task
      ...opts,
    });
    console.log(result);
    return result;
  } catch (err) {
    console.error(`Command failed: ${err.stderr || err.message}`);
    return '';
  }
}

console.log('=== OpenHive Example: Todo CLI App ===\n');
console.log(`Target directory: ${targetDir}`);

// Step 1: Initialize
console.log('\n--- Step 1: Initialize OpenHive ---');
run(['init']);

// Step 2: Show available agents
console.log('\n--- Step 2: Available Agents ---');
run(['agents']);

// Step 3: Dispatch tasks
const tasks = [
  {
    prompt: 'Create a file src/todo.ts with a Todo interface (id: string, title: string, done: boolean, createdAt: string) and pure functions: createTodo(title) returning a new Todo, toggleTodo(todo) returning a copy with done flipped, deleteTodo(todos, id) returning filtered array. Use nanoid for IDs.',
    name: 'data model',
  },
  {
    prompt: 'Create a file src/storage.ts that reads and writes an array of Todo objects to a todos.json file in the current directory. Export async functions: loadTodos() returns Todo[], saveTodos(todos: Todo[]) writes to disk. Handle file-not-found gracefully by returning empty array.',
    name: 'storage layer',
  },
  {
    prompt: 'Write tests in test/todo.test.ts for a Todo module at src/todo.ts. Test createTodo (returns object with title, id, done=false), toggleTodo (flips done), and deleteTodo (removes by id). Use vitest with import { describe, it, expect } from "vitest".',
    name: 'unit tests',
  },
];

console.log(`\n--- Step 3: Dispatching ${tasks.length} tasks ---`);
for (const task of tasks) {
  console.log(`\nDispatching: ${task.name}`);
  run(['run', task.prompt]);
}

// Step 4: Show results
console.log('\n--- Step 4: Task Results ---');
run(['tasks']);
run(['status']);
run(['pool']);

console.log('\n=== Done! ===');
console.log('Review completed tasks with:');
console.log('  openhive tasks');
console.log('  openhive logs <task-id>');
console.log('  openhive diff <task-id>');
