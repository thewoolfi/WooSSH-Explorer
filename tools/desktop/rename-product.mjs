/**
 * Renames the product from "SSH Explorer" to "WooSSH Explorer".
 *
 * Only the name a person sees changes. Wire-level identifiers stay as they are:
 * the `x-ssh-explorer-token` header, the `SSH_EXPLORER_*` environment variables, the
 * `sshExplorerDesktop` bridge and the npm package names are a contract, and renaming
 * them would break saved state, scripts and anything already written against the API.
 *
 * Run once: node tools/desktop/rename-product.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OLD = 'SSH Explorer';
const NEW = 'WooSSH Explorer';

/** Files where the visible name appears. */
const FILES = [
  'package.json',
  'desktop/package.json',
  'desktop/src/main.ts',
  'desktop/src/menu.ts',
  'desktop/scripts/verify-package.mjs',
  'desktop/scripts/verify-desktop-e2e.mjs',
  'desktop/scripts/launch.mjs',
  'web/index.html',
  'web/src/i18n/index.ts',
  'web/src/components/shell/TopBar.tsx',
  'web/src/components/shell/AppShell.tsx',
  'tools/desktop/install.ps1',
  'tools/desktop/uninstall.ps1',
  'README.md',
  'docs/API.md',
  'docs/ARCHITECTURE.md',
  'docs/DESIGN.md',
];

/** Sequences that must survive untouched, whatever else the rename does. */
const PROTECTED = [
  'x-ssh-explorer-token',
  'sshExplorerDesktop',
  'SSH_EXPLORER_',
  'ssh-explorer-',
  '@ssh-explorer/',
  '"ssh-explorer"',
];

let changedFiles = 0;
let changedOccurrences = 0;

for (const relative of FILES) {
  const file = path.join(ROOT, relative);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.log(`  skip (absent): ${relative}`);
    continue;
  }

  // Replace on a copy where the protected sequences are masked out, then restore them.
  // A plain `replaceAll` would rewrite `x-ssh-explorer-token` inside prose as well.
  const masks = PROTECTED.map((token, index) => ({
    token,
    placeholder: `\u0000PROTECTED${index}\u0000`,
  }));
  let working = text;
  for (const { token, placeholder } of masks) working = working.split(token).join(placeholder);
  const before = working;
  working = working.split(OLD).join(NEW);
  for (const { token, placeholder } of masks) working = working.split(placeholder).join(token);

  if (working === before) continue;
  const count = before.split(OLD).length - 1;
  writeFileSync(file, working, 'utf8');
  changedFiles += 1;
  changedOccurrences += count;
  console.log(`  ${relative}: ${count}`);
}

console.log(`\nrenamed ${changedOccurrences} occurrence(s) in ${changedFiles} file(s)`);
