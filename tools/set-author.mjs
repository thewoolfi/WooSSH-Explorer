/**
 * Sets the author identity everywhere it is recorded: the git configuration, the
 * copyright line in the licence, and the `author` field of every manifest.
 *
 * Done from Node rather than the shell: the name contains Cyrillic, and PowerShell has
 * silently mangled non-ASCII arguments in this project more than once.
 *
 * Run once: node tools/set-author.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NAME = 'Andrew Woolfi | Андрей Павлов';
const EMAIL = 'zxcadsl@gmail.com';
/** The licence carries one name; both spellings keep it unambiguous in either language. */
const COPYRIGHT_HOLDER = 'Andrew Woolfi (Андрей Павлов)';
const YEAR = new Date().getFullYear();

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// --- the licence ------------------------------------------------------------
for (const file of ['LICENSE', 'LICENSE.txt']) {
  const full = path.join(ROOT, file);
  const text = readFileSync(full, 'utf8');
  const updated = text.replace(/^ {3}Copyright .*$/m, `   Copyright ${YEAR} ${COPYRIGHT_HOLDER}`);
  writeFileSync(full, updated, 'utf8');
  console.log(`${file}: ${/^ {3}Copyright .*$/m.exec(updated)?.[0].trim()}`);
}

// --- the manifests ----------------------------------------------------------
const author = `${NAME} <${EMAIL}>`;
for (const manifest of ['package.json', 'server/package.json', 'web/package.json', 'desktop/package.json']) {
  const full = path.join(ROOT, manifest);
  const json = JSON.parse(readFileSync(full, 'utf8'));
  json.author = author;
  writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`${manifest}: author set`);
}

// --- git --------------------------------------------------------------------
git('config', 'user.name', NAME);
git('config', 'user.email', EMAIL);
console.log(`git user.name  = ${git('config', 'user.name')}`);
console.log(`git user.email = ${git('config', 'user.email')}`);
