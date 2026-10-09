import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Guards against a class of damage this repository has actually suffered: a tool that
 * rewrites a file with the wrong code page turns an em dash into `\u0432\u0402\u201D`
 * and a middle dot into `\u0420\u2019\u0412\u00B7`. The result compiles, type-checks and
 * ships — it is only visible on screen, in a language nobody on the build machine reads.
 *
 * Catching it here costs a directory walk.
 */

const ROOTS = ['web/src', 'web/test', 'server/src', 'server/test', 'desktop/src', 'tools'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.mjs', '.md']);

/** The shapes mojibake takes: a Cyrillic letter followed by a punctuation mark it never pairs with. */
const PATTERNS: [RegExp, string][] = [
  [/[\u0432\u0420\u0421][\u0402\u2020\u2019]/, 'a Cyrillic letter glued to odd punctuation'],
  [/\u0420\u0402/, 'a broken sequence'],
];

function walk(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = path.join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

describe('source encoding', () => {
  const files = ROOTS.flatMap((root) => walk(path.resolve(process.cwd(), '..', root)));

  test('the walk found the sources it is meant to guard', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((file) => file.endsWith('systemStats.ts'))).toBe(true);
  });

  test('no file contains mojibake', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, description] of PATTERNS) {
        const match = pattern.exec(text);
        if (!match) continue;
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(path.resolve(process.cwd(), '..'), file)}:${line} — ${description}`);
        break;
      }
    }
    expect(offenders).toEqual([]);
  });
});
