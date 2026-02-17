# OpenHive Improvements

Priority-ordered list of improvements and features.

---

## P0 (Top Priority)

### Replace tmux-based orchestration with Claude Agent SDK

**Status**: Research / Design
**Impact**: Massive architectural simplification

The [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`) provides the same tools and agent loop as Claude Code, programmable in TypeScript. It would replace the entire tmux-based session management layer.

**What it replaces:**
- `WorkerSession` (tmux window management)
- `StateDetector` (regex-based pane output parsing)
- `ResponseEngine` (LLM escalation for stuck/error recovery)
- `patterns.ts` (per-tool state patterns and action rules)
- Auto-approve logic (sending Enter keystrokes to tmux)

**What it provides:**
- `query()` function with streaming message events
- Built-in tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
- Session resume/fork for multi-turn conversations
- Subagents via the `Task` tool
- Hooks: PreToolUse, PostToolUse, Stop, SessionStart, etc.
- Permission control via `allowedTools` and `permissionMode`
- MCP server integration

**Requirements:**
- Requires an **Anthropic API key** (not a Claude Code subscription)
- Docs note: "Anthropic does not allow third party developers to offer claude.ai login or rate limits"
- Also supports Bedrock, Vertex AI, and Azure credentials

**Implementation approach:**
1. Create `AgentSDKAdapter` that wraps `query()` from the SDK
2. Map orchestrator events to SDK message events
3. Replace `WorkerSession.start()` with `query()` call
4. Replace state detection with structured message parsing
5. Keep tmux-based adapters as fallback for agents without SDKs
6. Investigate if Codex and Gemini have similar programmatic SDKs

**Open questions:**
- Can we make API key usage cost-effective for dev workflows?
- Can we support a "bring your own key" model?
- Should the orchestrator agent (the one deciding how to handle errors) be configurable?

### Multi-provider SDK support

**Status**: Research complete
**Impact**: Full programmatic control of all three agent providers

Research confirms viable SDKs exist for all major providers (except Cursor):

| Provider | SDK | Language | Built-in Tools | Status |
|----------|-----|----------|----------------|--------|
| Anthropic | `@anthropic-ai/claude-agent-sdk` | TypeScript/Python | Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task | Production |
| OpenAI | `@openai/agents` | TypeScript/Python | Shell, FileEditor, ComputerUse, WebSearch | Production |
| Google | `@google/genai` | TypeScript/Python | Function calling (tools are user-defined) | Production |
| Cursor | None | — | — | No composable SDK; CLI-only |

**Key finding: No shared billing.** No provider shares billing between CLI subscriptions (Claude Max, ChatGPT Pro, etc.) and API usage. All SDKs require separate API keys with pay-per-token billing. This is a fundamental billing architecture constraint — subscriptions use flat-rate pricing while APIs use metered pricing.

**Cost analysis — API pricing per 1M tokens:**

| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| Claude Sonnet 4 | $3.00 | $15.00 | Best value for worker tasks |
| Claude Opus 4 | $15.00 | $75.00 | Most capable |
| GPT-4.1 | $2.00 | $8.00 | Competitive pricing |
| GPT-4.1 mini | $0.40 | $1.60 | Good for orchestrator |
| Gemini 2.5 Pro | $1.25–$10.00 | $2.50–$10.00 | Tiered by prompt size |
| Gemini 2.5 Flash | $0.15 | $0.60 | Excellent for orchestrator |
| Gemini Flash-Lite | $0.10 | $0.40 | Cheapest option |

**Recommended architecture: Cheap orchestrator + capable workers**

Use a cheap model (Gemini Flash-Lite or GPT-4.1 mini) as the orchestrator for decision-making (error recovery, task routing, approval decisions). Worker agents use the existing CLI-based subprocess approach (free with subscriptions). A typical orchestrator decision (~500 input + 200 output tokens) costs ~$0.0001–$0.0004.

**Implementation approach:**
1. Start with Claude Agent SDK for the orchestrator layer (highest priority)
2. Add OpenAI Agents SDK adapter for Codex replacement
3. Add Google GenAI adapter for Gemini (lighter integration — no built-in tools)
4. Keep subprocess/tmux adapters as fallback for CLI-only usage
5. Support "bring your own key" config per provider
6. Allow configurable orchestrator model selection

---

## P1 (High Priority)

### Configurable orchestrator agent

Allow users to select which agent acts as the orchestrator/decision-maker (currently hardcoded to claude for LLM escalation). This becomes especially relevant with the Agent SDK integration.

### Improve `openhive do` stream parser robustness

The JSONL stream parser for `claude --output-format stream-json` needs validation against actual output. Test with real claude CLI output to ensure all event types are handled.

### Add `--safe` flag to `openhive do` and `openhive chat`

Currently defaults to `full-auto` permissions. Add a `--safe` flag that uses `standard` permissions (ask before shell/network) for security-conscious use cases.

---

## P2 (Medium Priority)

### Better error recovery without LLM escalation

Add simple recovery strategies that don't require spawning another agent:
- Retry on transient errors (rate limits, network)
- Send Enter/y on stuck approval prompts
- Restart agent on crash/hang

### Test tier stability

The e2e tier tests are inherently non-deterministic (real agents produce different output each run). Add retry logic and better diagnostics for flaky test runs.

### `openhive chat` session persistence

Currently chat sessions are stored in `.openhive/chat-session.json`. Add session listing, naming, and the ability to switch between saved sessions.
