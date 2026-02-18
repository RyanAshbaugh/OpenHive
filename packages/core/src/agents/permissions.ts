/**
 * Permission presets and resolution for agent permissions.
 *
 * Four presets map to default AgentPermissions:
 *   strict     — read-only, everything else ask/deny
 *   standard   — file ops allow, shell/network ask
 *   permissive — most things allow, packageInstall ask
 *   full-auto  — everything allow
 *
 * resolvePermissions() merges a preset with per-agent overrides.
 */

import type {
  PermissionLevel,
  PermissionPreset,
  AgentPermissions,
} from '../config/schema.js';

export interface ResolvedPermissions {
  fileRead: PermissionLevel;
  fileWrite: PermissionLevel;
  shellExec: PermissionLevel;
  network: PermissionLevel;
  packageInstall: PermissionLevel;
  git: PermissionLevel;
  allowedCommands: string[];
  deniedCommands: string[];
}

const PRESETS: Record<PermissionPreset, ResolvedPermissions> = {
  strict: {
    fileRead: 'allow',
    fileWrite: 'ask',
    shellExec: 'deny',
    network: 'deny',
    packageInstall: 'deny',
    git: 'ask',
    allowedCommands: [],
    deniedCommands: [],
  },
  standard: {
    fileRead: 'allow',
    fileWrite: 'allow',
    shellExec: 'ask',
    network: 'ask',
    packageInstall: 'ask',
    git: 'allow',
    allowedCommands: [],
    deniedCommands: [],
  },
  permissive: {
    fileRead: 'allow',
    fileWrite: 'allow',
    shellExec: 'allow',
    network: 'allow',
    packageInstall: 'ask',
    git: 'allow',
    allowedCommands: [],
    deniedCommands: [],
  },
  'full-auto': {
    fileRead: 'allow',
    fileWrite: 'allow',
    shellExec: 'allow',
    network: 'allow',
    packageInstall: 'allow',
    git: 'allow',
    allowedCommands: [],
    deniedCommands: [],
  },
};

/**
 * Get the default permissions for a preset.
 */
export function getPreset(preset: PermissionPreset): ResolvedPermissions {
  return { ...PRESETS[preset], allowedCommands: [...PRESETS[preset].allowedCommands], deniedCommands: [...PRESETS[preset].deniedCommands] };
}

/**
 * Resolve permissions by merging a preset with per-agent overrides.
 * Overrides take precedence over preset defaults.
 */
export function resolvePermissions(
  preset: PermissionPreset,
  overrides?: AgentPermissions,
): ResolvedPermissions {
  const base = getPreset(preset);

  if (!overrides) return base;

  return {
    fileRead: overrides.fileRead ?? base.fileRead,
    fileWrite: overrides.fileWrite ?? base.fileWrite,
    shellExec: overrides.shellExec ?? base.shellExec,
    network: overrides.network ?? base.network,
    packageInstall: overrides.packageInstall ?? base.packageInstall,
    git: overrides.git ?? base.git,
    allowedCommands: overrides.allowedCommands ?? base.allowedCommands,
    deniedCommands: overrides.deniedCommands ?? base.deniedCommands,
  };
}

/**
 * Map legacy autoApprove boolean to a permission preset.
 */
export function presetFromAutoApprove(autoApprove: boolean): PermissionPreset {
  return autoApprove ? 'full-auto' : 'standard';
}

/**
 * Check if a command matches any pattern in a list (regex patterns).
 */
export function matchesCommandPattern(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      // Invalid regex — fall back to literal match
      return command.includes(pattern);
    }
  });
}

/**
 * Determine whether a specific command should be allowed, denied, or needs asking.
 * deniedCommands takes priority over allowedCommands.
 */
export function checkCommandPermission(
  command: string,
  permissions: ResolvedPermissions,
): PermissionLevel {
  if (matchesCommandPattern(command, permissions.deniedCommands)) {
    return 'deny';
  }
  if (matchesCommandPattern(command, permissions.allowedCommands)) {
    return 'allow';
  }
  return permissions.shellExec;
}
