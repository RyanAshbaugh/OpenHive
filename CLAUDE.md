# OpenHive — Project Instructions

## What is this?
OpenHive is a CLI-first multi-agent orchestrator for AI coding agents (Claude Code, Codex, Gemini CLI, etc.). It dispatches tasks to agents via subprocess spawning, manages git worktrees for isolation, and tracks token pool usage.

## Monorepo Structure
This is a **pnpm workspace monorepo** with three packages:

| Package | Path | Description |
|---------|------|-------------|
| `@openhive/core` | `packages/core/` | CLI orchestrator (Commander.js, agent adapters, task system) |
| `@openhive/mobile` | `packages/mobile/` | Mobile simulator automation (build, launch, auth scripts) |
| `@openhive/web` | `packages/web/` | Web automation tools (placeholder) |

## Architecture
- **TypeScript, ES2022, NodeNext modules** — all imports use `.js` extensions
- **CLI framework**: Commander.js via `packages/core/src/cli/program.ts`
- **Agent adapters**: `packages/core/src/agents/adapters/` — each adapter wraps one CLI tool
- **Task system**: In-memory queue + JSON file persistence
- **Git isolation**: Each task gets its own worktree in `.openhive-worktrees/`
- **Token pool**: Passive tracking of per-provider dispatch counts and rate limits
- **Mobile config**: JSON5-based config at `.openhive/mobile.json5` in consumer projects

## Key Patterns
- All agent interaction is via subprocess spawning (not API calls)
- Config merges global (`~/.openhive/config.json`) + local (`.openhive/config.json`)
- Tasks have a `projectId` field for future project grouping
- All CLI commands support `--json` for scriptability
- Mobile scripts are config-driven — no hardcoded app IDs or schemes

## Commands
```
# Workspace-wide
pnpm build          # Build all packages
pnpm test           # Run all package tests
pnpm lint           # Lint all packages
pnpm dev            # Watch mode (all packages)

# Core-specific
pnpm --filter @openhive/core test        # Core unit tests
pnpm --filter @openhive/core test:e2e    # Core e2e tests
./packages/core/bin/openhive.mjs         # Run CLI

# Mobile-specific
./packages/mobile/bin/openhive-mobile help   # Mobile CLI help
./packages/mobile/bin/openhive-mobile run    # Build + launch + auth
```

## File Conventions
- Source in `packages/*/src/`, tests in `packages/core/test/` mirroring src structure
- Use `.js` extensions in all TypeScript imports (NodeNext resolution)
- Prefer interfaces over types, named exports over default exports
- Root `tsconfig.json` uses project references; each package has `"composite": true`
