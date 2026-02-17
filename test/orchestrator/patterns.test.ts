import { describe, it, expect } from 'vitest';
import { buildProfile, supportedTools } from '../../src/orchestrator/patterns.js';

describe('patterns', () => {
  describe('supportedTools', () => {
    it('returns claude, codex, gemini', () => {
      expect(supportedTools()).toEqual(['claude', 'codex', 'gemini']);
    });
  });

  describe('buildProfile', () => {
    it('builds a profile for claude', () => {
      const profile = buildProfile('claude');
      expect(profile.toolControl.tool).toBe('claude');
      expect(profile.statePatterns.length).toBeGreaterThan(0);
      expect(profile.actionRules.length).toBeGreaterThan(0);
      expect(profile.stuckTimeoutMs).toBe(120_000);
      expect(profile.activityPatterns.length).toBeGreaterThan(0);
      expect(profile.completionPattern).toBeInstanceOf(RegExp);
    });

    it('builds a profile for codex', () => {
      const profile = buildProfile('codex');
      expect(profile.toolControl.tool).toBe('codex');
      expect(profile.statePatterns.length).toBeGreaterThan(0);
    });

    it('builds a profile for gemini', () => {
      const profile = buildProfile('gemini');
      expect(profile.toolControl.tool).toBe('gemini');
      expect(profile.statePatterns.length).toBeGreaterThan(0);
    });

    it('throws for unsupported tool', () => {
      expect(() => buildProfile('unknown')).toThrow('No tool control');
    });

    it('throws for cursor (no orchestration profile)', () => {
      expect(() => buildProfile('cursor')).toThrow('No orchestration profile');
    });

    it('passes autoApprove to action rules', () => {
      const profileApprove = buildProfile('claude', true);
      const profileNoApprove = buildProfile('claude', false);

      // Both should have action rules, but the approve rule condition differs
      const approveRule = profileApprove.actionRules.find(r => r.name === 'auto_approve');
      const noApproveRule = profileNoApprove.actionRules.find(r => r.name === 'auto_approve');

      expect(approveRule).toBeDefined();
      expect(noApproveRule).toBeDefined();

      // The auto_approve rule should have a condition that returns true when autoApprove=true
      expect(approveRule!.condition!({} as any)).toBe(true);
      expect(noApproveRule!.condition!({} as any)).toBe(false);
    });
  });

  describe('claude state patterns', () => {
    const profile = buildProfile('claude');
    const sorted = [...profile.statePatterns].sort((a, b) => b.priority - a.priority);

    function matchState(output: string): string | undefined {
      for (const sp of sorted) {
        if (sp.pattern.test(output)) return sp.state;
      }
      return undefined;
    }

    it('detects idle from prompt', () => {
      expect(matchState('some output\n> ')).toBe('idle');
      expect(matchState('text\n>  ')).toBe('idle');
    });

    it('detects working from timer', () => {
      expect(matchState('12s │ building...')).toBe('working');
      expect(matchState('$0.12')).toBe('working');
    });

    it('detects working from spinner/status', () => {
      expect(matchState('⠋ Thinking about the problem')).toBe('working');
      expect(matchState('Reading file.ts')).toBe('working');
      expect(matchState('Writing changes to disk')).toBe('working');
    });

    it('detects waiting_approval', () => {
      expect(matchState('Do you want to run this command?')).toBe('waiting_approval');
      expect(matchState('Allow file write to src/main.ts')).toBe('waiting_approval');
    });

    it('detects waiting_input from question mark', () => {
      expect(matchState('What file should I modify?')).toBe('waiting_input');
    });

    it('detects rate_limited', () => {
      expect(matchState('rate limit exceeded')).toBe('rate_limited');
      expect(matchState('Too many requests')).toBe('rate_limited');
    });

    it('detects error', () => {
      expect(matchState('Error: ENOENT: no such file')).toBe('error');
    });

    it('prioritizes rate_limited over idle', () => {
      // If both could match, rate_limited has higher priority
      expect(matchState('rate limited\n> ')).toBe('rate_limited');
    });

    it('prioritizes waiting_approval over working', () => {
      expect(matchState('Do you want to execute this? 12s │')).toBe('waiting_approval');
    });
  });

  describe('codex state patterns', () => {
    const profile = buildProfile('codex');
    const sorted = [...profile.statePatterns].sort((a, b) => b.priority - a.priority);

    function matchState(output: string): string | undefined {
      for (const sp of sorted) {
        if (sp.pattern.test(output)) return sp.state;
      }
      return undefined;
    }

    it('detects idle from welcome', () => {
      expect(matchState('OpenAI Codex ready')).toBe('idle');
    });

    it('detects waiting_approval from y/n', () => {
      expect(matchState('Run command? [y/n]')).toBe('waiting_approval');
    });

    it('does not false-positive on agent prose containing approval keywords', () => {
      // "confirmed" contains "confirm" but word boundary prevents match
      expect(matchState('I confirmed the workspace')).not.toBe('waiting_approval');
      // "allowed" contains "allow"
      expect(matchState('I allowed the file write and it worked')).not.toBe('waiting_approval');
      // "approved" contains "approve"
      expect(matchState('I approved of the changes and committed')).not.toBe('waiting_approval');
    });

    it('detects rate_limited', () => {
      expect(matchState('rate limited')).toBe('rate_limited');
    });
  });

  describe('gemini state patterns', () => {
    const profile = buildProfile('gemini');
    const sorted = [...profile.statePatterns].sort((a, b) => b.priority - a.priority);

    function matchState(output: string): string | undefined {
      for (const sp of sorted) {
        if (sp.pattern.test(output)) return sp.state;
      }
      return undefined;
    }

    it('detects idle from prompt', () => {
      expect(matchState('Type your message here')).toBe('idle');
    });

    it('detects rate_limited from quota', () => {
      expect(matchState('quota exceeded for model')).toBe('rate_limited');
      expect(matchState('RESOURCE_EXHAUSTED')).toBe('rate_limited');
    });
  });

  describe('activity patterns', () => {
    it('claude activity patterns match timer and cost', () => {
      const profile = buildProfile('claude');
      expect(profile.activityPatterns.some(p => p.test('12s │'))).toBe(true);
      expect(profile.activityPatterns.some(p => p.test('$0.42'))).toBe(true);
      expect(profile.activityPatterns.some(p => p.test('⠋'))).toBe(true);
    });
  });
});
