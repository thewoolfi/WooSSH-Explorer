import { describe, expect, test } from 'vitest';
import { COMMAND_DEFINITIONS, type PkgManager } from '../../src/components/terminal/TerminalInspector';

describe('TerminalInspector commands', () => {
  test('has exactly 10 defined commands', () => {
    expect(COMMAND_DEFINITIONS).toHaveLength(10);
  });

  test('all commands return non-empty strings for all package managers', () => {
    const pkgManagers: PkgManager[] = ['apt', 'dnf', 'pacman', 'apk', 'auto'];
    for (const cmd of COMMAND_DEFINITIONS) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.titleKey).toBeTruthy();
      expect(cmd.descKey).toBeTruthy();
      for (const pkg of pkgManagers) {
        const text = cmd.getCommand(pkg);
        expect(text).toBeTruthy();
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('covers all four expected categories', () => {
    const categories = new Set(COMMAND_DEFINITIONS.map((c) => c.category));
    expect(categories).toEqual(new Set(['updates', 'monitor', 'network', 'system']));
  });
});
