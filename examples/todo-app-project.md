# Example Project: Build a Todo CLI App

This example demonstrates using OpenHive to build a small Node.js todo CLI app
by dispatching tasks to multiple AI agents in parallel.

## Prerequisites

- Git repo initialized
- At least one AI agent CLI installed (claude, codex, or gemini)
- OpenHive built (`pnpm build`)

## Usage

### 1. Initialize OpenHive in your project

```bash
# In a fresh git repo for the todo app
mkdir todo-app && cd todo-app && git init
echo "node_modules/" > .gitignore
npm init -y
git add -A && git commit -m "initial commit"

# Initialize OpenHive
openhive init
```

### 2. Run the demo script

```bash
# From this repo:
node examples/todo-app-project.mjs /path/to/todo-app
```

This will:
1. Create a project named "Todo CLI App"
2. Dispatch tasks to available agents in parallel
3. Each task runs in its own git worktree for isolation
4. Show task status as they complete

### 3. Manual equivalent

If you prefer to run step by step:

```bash
cd /path/to/todo-app

# Task 1: Create the data model
openhive run "Create src/todo.ts with a Todo interface (id, title, done, createdAt) and functions: createTodo, toggleTodo, deleteTodo. Use pure functions, no side effects." -a claude

# Task 2: Create the storage layer
openhive run "Create src/storage.ts that reads/writes todos to a todos.json file. Export loadTodos() and saveTodos(todos) functions." -a claude

# Task 3: Create the CLI
openhive run "Create src/cli.ts using commander.js with commands: add <title>, list, done <id>, remove <id>. Import from ./todo.ts and ./storage.ts. Make it the bin entry in package.json." -a claude

# Task 4: Write tests
openhive run "Write tests in test/todo.test.ts for the todo functions in src/todo.ts. Use vitest. Test createTodo, toggleTodo, and deleteTodo." -a claude

# Check status
openhive tasks
openhive status
```
