# OpenHive — Project Instructions

## What is this?
OpenHive is a CLI-first multi-agent orchestrator for AI coding agents (Claude Code, Codex, Gemini CLI, etc.). It dispatches tasks to agents via subprocess spawning, manages git worktrees for isolation, and tracks token pool usage.

## Architecture
- **TypeScript, ES2022, NodeNext modules** — all imports use `.js` extensions
- **CLI framework**: Commander.js via `src/cli/program.ts`
- **Agent adapters**: `src/agents/adapters/` — each adapter wraps one CLI tool
- **Task system**: In-memory queue + JSON file persistence
- **Git isolation**: Each task gets its own worktree in `.openhive-worktrees/`
- **Token pool**: Passive tracking of per-provider dispatch counts and rate limits

## Key Patterns
- All agent interaction is via subprocess spawning (not API calls)
- Config merges global (`~/.openhive/config.json`) + local (`.openhive/config.json`)
- Tasks have a `projectId` field for future project grouping
- All CLI commands support `--json` for scriptability

## Commands
```
pnpm build          # Compile TypeScript
pnpm test           # Run tests with Vitest
pnpm dev            # Watch mode
./bin/openhive.mjs  # Run CLI
```

## File Conventions
- Source in `src/`, tests in `test/` mirroring src structure
- Use `.js` extensions in all TypeScript imports (NodeNext resolution)
- Prefer interfaces over types, named exports over default exports
