import { describe, it, expect } from 'vitest';
import { StateDetector } from '../../src/orchestrator/state.js';
import { buildProfile } from '../../src/orchestrator/patterns.js';

describe('StateDetector', () => {
  const profile = buildProfile('claude');
  const detector = new StateDetector(profile);

  describe('detectFromOutput', () => {
    it('detects idle state from prompt', () => {
      const output = 'Hello! I can help you with that.\n\n> ';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('idle');
      expect(snapshot.matchedPattern).toBe('claude:idle');
      expect(snapshot.paneOutput).toBe(output);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it('detects working state from timer', () => {
      const output = 'Reading src/main.ts\n12s │ analyzing code...';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('working');
      expect(snapshot.matchedPattern).toMatch(/claude:working/);
    });

    it('detects working state from spinner', () => {
      const output = '⠋ Thinking about the problem';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('working');
    });

    it('detects waiting_approval state', () => {
      const output = 'I need to write to this file.\nDo you want to allow this?';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('waiting_approval');
    });

    it('detects waiting_input state', () => {
      const output = 'I have a few options. Which approach would you prefer?';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('waiting_input');
    });

    it('detects rate_limited state', () => {
      const output = 'Sorry, rate limit exceeded. Please wait.';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('rate_limited');
    });

    it('detects error state', () => {
      const output = 'Error: ENOENT: no such file or directory';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('error');
    });

    it('returns starting for empty output', () => {
      const snapshot = detector.detectFromOutput('');
      expect(snapshot.state).toBe('starting');
    });

    it('returns working for unrecognized non-empty output', () => {
      const output = 'some random text that matches no pattern';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('working');
    });

    it('uses last 30 lines for detection', () => {
      // Rate limit message 50 lines ago shouldn't trigger rate_limited
      // if the recent output shows idle
      const oldLines = Array(50).fill('some old output').join('\n');
      const output = `rate limit exceeded\n${oldLines}\n> `;
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('idle');
    });

    it('respects per-pattern windowSize for approval detection', () => {
      // Simulate codex: agent prose with "confirmed" 20+ lines above the idle prompt
      // Without windowSize, "confirmed" would match waiting_approval (priority 9 > idle 1)
      // With windowSize: 15, approval patterns only check last 15 lines
      const codexProfile = buildProfile('codex');
      const codexDetector = new StateDetector(codexProfile);

      const proseLines = [
        'I confirmed the workspace and will create the file.',
        ...Array(15).fill('building out the data store module'),
        'Created src/model.js with the required functions.',
        '',
        '? for shortcuts                                         97% context left',
      ];
      const output = proseLines.join('\n');
      const snapshot = codexDetector.detectFromOutput(output);
      // Should detect idle, NOT waiting_approval
      expect(snapshot.state).toBe('idle');
    });

    it('detects gemini approval dialog within windowSize', () => {
      // Gemini's approval dialog is tall (box with options + spinner below).
      // "Allow" keywords appear ~10-12 lines from bottom. windowSize must be
      // large enough to capture them despite the spinner matching "working".
      const geminiProfile = buildProfile('gemini');
      const geminiDetector = new StateDetector(geminiProfile);

      const dialogLines = [
        '╭───────────────────────────────────╮',
        '│ Action Required                   │',
        '│                                   │',
        '│ ?  Shell find . -maxdepth 3       │',
        '│                                   │',
        '│ find . -maxdepth 3                │',
        '│ Allow execution of: \'find\'?       │',
        '│                                   │',
        '│ ● 1. Allow once                   │',
        '│   2. Allow for this session       │',
        '│   3. No, suggest changes (esc)    │',
        '│                                   │',
        '╰───────────────────────────────────╯',
        '',
        '⠏ Waiting for user confirmation...',
      ];
      const output = dialogLines.join('\n');
      const snapshot = geminiDetector.detectFromOutput(output);
      // Should detect waiting_approval (priority 9), NOT working from spinner (priority 5)
      expect(snapshot.state).toBe('waiting_approval');
    });

    it('prioritizes higher priority patterns', () => {
      // Both rate_limited (priority 10) and idle (priority 1) could match
      const output = 'rate limit exceeded\n> ';
      const snapshot = detector.detectFromOutput(output);
      expect(snapshot.state).toBe('rate_limited');
    });
  });

  describe('hasActivity', () => {
    it('returns true when activity patterns match', () => {
      expect(detector.hasActivity('12s │ working...')).toBe(true);
      expect(detector.hasActivity('$0.15 cost so far')).toBe(true);
      expect(detector.hasActivity('⠋ loading')).toBe(true);
    });

    it('returns false for idle output', () => {
      expect(detector.hasActivity('> ')).toBe(false);
      expect(detector.hasActivity('some static text')).toBe(false);
    });
  });

  describe('isComplete', () => {
    it('returns true when completion pattern matches', () => {
      expect(detector.isComplete('Done!\n> ')).toBe(true);
    });

    it('returns false when not at prompt', () => {
      expect(detector.isComplete('Still working...')).toBe(false);
    });
  });

  describe('refineState', () => {
    it('marks working as stuck after timeout', () => {
      const snapshot = detector.detectFromOutput('12s │ working...');
      expect(snapshot.state).toBe('working');

      const refined = detector.refineState(
        snapshot,
        snapshot.timestamp - 130_000, // 130s ago
        120_000, // 2min timeout
      );
      expect(refined.state).toBe('stuck');
      expect(refined.matchedPattern).toMatch(/stuck:no_output_change/);
    });

    it('does not mark working as stuck before timeout', () => {
      const snapshot = detector.detectFromOutput('12s │ working...');
      const refined = detector.refineState(
        snapshot,
        snapshot.timestamp - 60_000, // 60s ago (under 120s timeout)
        120_000,
      );
      expect(refined.state).toBe('working');
    });

    it('does not affect non-working states', () => {
      const snapshot = detector.detectFromOutput('> ');
      expect(snapshot.state).toBe('idle');

      const refined = detector.refineState(
        snapshot,
        snapshot.timestamp - 300_000, // 5 min ago
        120_000,
      );
      expect(refined.state).toBe('idle');
    });
  });
});
