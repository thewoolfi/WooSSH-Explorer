/**
 * Renames the visible product name across the repository. The product is called WooSSH;
 * the defaults below match the change that produced that name.
 *
 * Only the name a person sees changes. Wire-level identifiers stay as they are:
 * the `x-ssh-explorer-token` header, the `SSH_EXPLORER_*` environment variables, the
 * `sshExplorerDesktop` bridge and the npm package names are a contract, and renaming
 * them would break saved state, scripts and anything already written against the API.
 *
 * A rename moves Electron's user-data directory, so the old names must be added to
 * LEGACY_PRODUCT_NAMES in desktop/src/main.ts or saved hosts are left behind.
 *
 * Usage: RENAME_FROM="Old Name" RENAME_TO="New Name" node tools/desktop/rename-product.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OLD = process.env.RENAME_FROM ?? 'WooSSH Explorer';
const NEW = process.env.RENAME_TO ?? 'WooSSH';

/** Files where the visible name appears. */
const FILES = [
  'package.json',
  'desktop/package.json',
  'desktop/electron-builder.yml',
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
  '.github/workflows/ci.yml',
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
