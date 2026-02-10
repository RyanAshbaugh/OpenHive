/**
 * Provider-specific rate limit definitions.
 *
 * These are the known limits for each CLI tool as of Feb 2026.
 * OpenHive tracks its own dispatches against these — the bars are always
 * approximate since usage on the web UI / IDE plugins draws from the same quota.
 *
 * ## How to verify / update these limits
 *
 * Each entry below includes `docsUrl` and `investigationMethod`.
 * To refresh the data:
 *   1. Check the linked docs page for the latest numbers.
 *   2. Run the CLI tool's help command (e.g. `claude --help`, `codex --help`).
 *   3. Check the tool's built-in usage command if available
 *      (`/usage` in Claude Code, `/status` in Codex CLI).
 *   4. Search for "[tool] rate limits 2026" for community reports.
 */

export type WindowType = 'rolling' | 'fixed';

export interface RateLimitWindow {
  /** Identifier used in config and tracking */
  id: string;
  /** Human-readable label for the dashboard (e.g. "5h", "wk", "rpm", "day") */
  label: string;
  /** Rolling or fixed (calendar-based) reset */
  type: WindowType;
  /** Window duration in milliseconds */
  windowMs: number;
  /**
   * Known default limit, if any. undefined = varies by plan or unknown.
   * For rolling windows this is approximate (providers don't publish exact numbers).
   */
  defaultLimit?: number;
  /** Human-readable description of when the window resets */
  resetDescription: string;
}

export interface ProviderLimitDef {
  provider: string;
  windows: RateLimitWindow[];
  notes: string;
  docsUrl: string;
  investigationMethod: string;
}

// ─── Window Presets ─────────────────────────────────────────────────────────

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

// ─── Provider Definitions ───────────────────────────────────────────────────

export const PROVIDER_LIMITS: Record<string, ProviderLimitDef> = {
  anthropic: {
    provider: 'anthropic',
    windows: [
      {
        id: '5h',
        label: '5h',
        type: 'rolling',
        windowMs: FIVE_HOURS_MS,
        // Pro ~10-45 prompts, Max5x ~225+, Max20x unlimited. Not settable exactly.
        defaultLimit: undefined,
        resetDescription: 'Rolling — oldest usage drops off after 5 hours',
      },
      {
        id: 'weekly',
        label: 'wk',
        type: 'rolling',
        windowMs: ONE_WEEK_MS,
        defaultLimit: undefined,
        resetDescription: 'Rolling — measured in active compute hours over 7 days',
      },
    ],
    notes:
      'Dual-layer: 5-hour rolling window + weekly rolling cap. ' +
      'Usage is unified across claude.ai, Claude Code CLI, Claude Desktop, and IDE extensions. ' +
      'Limits vary by plan (Pro $20/mo, Max5x $100/mo, Max20x $200/mo). ' +
      'Anthropic does not publish exact token numbers; community-observed ~10-45 prompts/5h on Pro.',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    investigationMethod:
      'Run `/usage` inside Claude Code to see current window status. ' +
      'Check https://support.anthropic.com/en/articles/usage-limits for plan-specific limits. ' +
      'Search "claude code rate limits" for community benchmarks.',
  },

  openai: {
    provider: 'openai',
    windows: [
      {
        id: '5h',
        label: '5h',
        type: 'rolling',
        windowMs: FIVE_HOURS_MS,
        // Plus ~30-150 local msgs, Pro ~300-1500. Varies widely.
        defaultLimit: undefined,
        resetDescription: 'Rolling — oldest usage drops off after 5 hours',
      },
      {
        id: 'weekly',
        label: 'wk',
        type: 'rolling',
        windowMs: ONE_WEEK_MS,
        defaultLimit: undefined,
        resetDescription: 'Rolling 7 days from first use, resets at 00:00 UTC',
      },
    ],
    notes:
      'Dual-layer: 5-hour rolling window + rolling 7-day weekly cap. ' +
      'Local messages and cloud tasks share the same 5h bucket but at different credit costs (~5 vs ~25). ' +
      'Limits vary by plan (Plus, Pro, Business, Enterprise). ' +
      'No built-in dashboard for weekly reset time; users must track manually.',
    docsUrl: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
    investigationMethod:
      'Run `/status` inside Codex CLI to check 5h window remaining. ' +
      'Check https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan for plan tiers. ' +
      'Check https://community.openai.com for community reports on actual limits.',
  },

  google: {
    provider: 'google',
    windows: [
      {
        id: 'rpm',
        label: 'rpm',
        type: 'fixed',
        windowMs: ONE_MINUTE_MS,
        defaultLimit: 60,  // Free tier: 60 RPM
        resetDescription: 'Fixed — resets every 60 seconds',
      },
      {
        id: 'daily',
        label: 'day',
        type: 'fixed',
        windowMs: ONE_DAY_MS,
        defaultLimit: 1000,  // Free tier: 1,000 RPD
        resetDescription: 'Fixed — resets at midnight Pacific Time',
      },
    ],
    notes:
      'Fixed RPM + RPD (requests per day). ' +
      'Free tier: 60 RPM, 1,000 RPD. Pro: 120 RPM, 1,500 RPD. Ultra: 120 RPM, 2,000 RPD. ' +
      'Daily resets at midnight PT. ' +
      'One agent-mode prompt may trigger multiple model requests. ' +
      'Gemini CLI limits are more generous than standard Gemini API limits.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    investigationMethod:
      'Check https://geminicli.com/docs/quota-and-pricing/ for CLI-specific limits. ' +
      'Check https://ai.google.dev/gemini-api/docs/rate-limits for API tier limits. ' +
      'Run `gemini --help` to see available flags.',
  },

  cursor: {
    provider: 'cursor',
    windows: [],  // No known programmatic rate limits for agent mode
    notes:
      'Cursor agent mode rate limits are not publicly documented for CLI/headless usage. ' +
      'The tool runs via the Cursor editor\'s agent protocol. ' +
      'Tracking is N/A until limits are better understood.',
    docsUrl: 'https://docs.cursor.com',
    investigationMethod:
      'Check https://docs.cursor.com for any published limits. ' +
      'Monitor Cursor community forums for rate limit reports.',
  },
};

/**
 * Get the limit definition for a provider.
 * Returns undefined for unknown providers.
 */
export function getProviderLimits(provider: string): ProviderLimitDef | undefined {
  return PROVIDER_LIMITS[provider];
}
