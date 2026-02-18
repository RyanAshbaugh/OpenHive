import { describe, it, expect } from 'vitest';
import {
  getPreset,
  resolvePermissions,
  presetFromAutoApprove,
  matchesCommandPattern,
  checkCommandPermission,
} from '../../src/agents/permissions.js';

describe('permissions', () => {
  describe('getPreset', () => {
    it('strict: fileRead allow, everything else restrictive', () => {
      const p = getPreset('strict');
      expect(p.fileRead).toBe('allow');
      expect(p.fileWrite).toBe('ask');
      expect(p.shellExec).toBe('deny');
      expect(p.network).toBe('deny');
      expect(p.packageInstall).toBe('deny');
      expect(p.git).toBe('ask');
    });

    it('standard: file ops allow, shell/network ask', () => {
      const p = getPreset('standard');
      expect(p.fileRead).toBe('allow');
      expect(p.fileWrite).toBe('allow');
      expect(p.shellExec).toBe('ask');
      expect(p.network).toBe('ask');
      expect(p.packageInstall).toBe('ask');
      expect(p.git).toBe('allow');
    });

    it('permissive: most allow, packageInstall ask', () => {
      const p = getPreset('permissive');
      expect(p.fileRead).toBe('allow');
      expect(p.fileWrite).toBe('allow');
      expect(p.shellExec).toBe('allow');
      expect(p.network).toBe('allow');
      expect(p.packageInstall).toBe('ask');
      expect(p.git).toBe('allow');
    });

    it('full-auto: everything allow', () => {
      const p = getPreset('full-auto');
      expect(p.fileRead).toBe('allow');
      expect(p.fileWrite).toBe('allow');
      expect(p.shellExec).toBe('allow');
      expect(p.network).toBe('allow');
      expect(p.packageInstall).toBe('allow');
      expect(p.git).toBe('allow');
    });

    it('returns a new object each time (not shared)', () => {
      const a = getPreset('standard');
      const b = getPreset('standard');
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      a.fileRead = 'deny';
      expect(b.fileRead).toBe('allow');
    });
  });

  describe('resolvePermissions', () => {
    it('returns preset when no overrides', () => {
      const p = resolvePermissions('standard');
      expect(p.shellExec).toBe('ask');
      expect(p.fileRead).toBe('allow');
    });

    it('overrides individual fields', () => {
      const p = resolvePermissions('standard', { shellExec: 'allow', network: 'deny' });
      expect(p.shellExec).toBe('allow');
      expect(p.network).toBe('deny');
      // Non-overridden fields remain from preset
      expect(p.fileRead).toBe('allow');
      expect(p.packageInstall).toBe('ask');
    });

    it('overrides command lists', () => {
      const p = resolvePermissions('standard', {
        allowedCommands: ['npm test'],
        deniedCommands: ['rm -rf'],
      });
      expect(p.allowedCommands).toEqual(['npm test']);
      expect(p.deniedCommands).toEqual(['rm -rf']);
    });

    it('preserves preset command lists when not overridden', () => {
      const p = resolvePermissions('standard');
      expect(p.allowedCommands).toEqual([]);
      expect(p.deniedCommands).toEqual([]);
    });
  });

  describe('presetFromAutoApprove', () => {
    it('true → full-auto', () => {
      expect(presetFromAutoApprove(true)).toBe('full-auto');
    });

    it('false → standard', () => {
      expect(presetFromAutoApprove(false)).toBe('standard');
    });
  });

  describe('matchesCommandPattern', () => {
    it('matches regex patterns', () => {
      expect(matchesCommandPattern('npm install express', ['npm install'])).toBe(true);
      expect(matchesCommandPattern('rm -rf /', ['rm -rf'])).toBe(true);
    });

    it('supports real regex', () => {
      expect(matchesCommandPattern('sudo apt-get install', ['^sudo'])).toBe(true);
      expect(matchesCommandPattern('echo sudo', ['^sudo'])).toBe(false);
    });

    it('returns false when no patterns match', () => {
      expect(matchesCommandPattern('git status', ['npm', 'pip'])).toBe(false);
    });

    it('handles invalid regex gracefully (literal match)', () => {
      expect(matchesCommandPattern('test [bracket', ['[bracket'])).toBe(true);
    });
  });

  describe('checkCommandPermission', () => {
    it('deniedCommands take priority over allowedCommands', () => {
      const p = resolvePermissions('full-auto', {
        allowedCommands: ['.*'],
        deniedCommands: ['rm -rf'],
      });
      expect(checkCommandPermission('rm -rf /', p)).toBe('deny');
    });

    it('allowedCommands override shellExec level', () => {
      const p = resolvePermissions('standard', {
        allowedCommands: ['npm test'],
      });
      // standard has shellExec: 'ask', but this specific command is allowed
      expect(checkCommandPermission('npm test', p)).toBe('allow');
    });

    it('falls back to shellExec when no command patterns match', () => {
      const p = resolvePermissions('standard');
      expect(checkCommandPermission('some-command', p)).toBe('ask');
    });

    it('full-auto allows everything', () => {
      const p = resolvePermissions('full-auto');
      expect(checkCommandPermission('rm -rf /', p)).toBe('allow');
    });
  });
});
