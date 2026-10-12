#!/usr/bin/env node
/**
 * Cuts a release: builds, uploads, and makes sure it is actually visible.
 *
 * electron-builder's GitHub publisher creates the release as a **draft** and publishes it
 * afterwards — and if that second step fails, for instance because the tag does not exist
 * on the remote yet, the draft stays there with all the files uploaded and nothing
 * pointing at it. That happened on the first release, and the fix was a manual API call.
 * This script does that part, so a release is one command and ends up published.
 *
 * The token comes from the credential git already stores for github.com, so there is no
 * second place to keep it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const OWNER = 'thewoolfi';
const REPO = 'WooSSH-Explorer';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const filled = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const line = filled.split('\n').find((entry) => entry.startsWith('password='));
  if (!line) {
    console.error('No GitHub credential is stored for github.com. Set GH_TOKEN instead.');
    process.exit(1);
  }
  return line.slice('password='.length).trim();
}

async function github(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `token ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'woossh-release',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

const version = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

console.log(`[release] ${tag}`);

// 1. The tag has to exist before the release can be published; GitHub refuses to publish a
//    release whose tag it cannot resolve.
try {
  execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: repoRoot, stdio: 'pipe' });
  console.log(`[release] tag ${tag} exists`);
} catch {
  execFileSync('git', ['tag', tag], { cwd: repoRoot, stdio: 'inherit' });
  console.log(`[release] tag ${tag} created`);
}
execFileSync('git', ['push', 'origin', tag], { cwd: repoRoot, stdio: 'inherit' });

// 2. Build and upload. The publisher attaches the installers, `latest.yml` and the
//    blockmap; the last two are what makes an installed build able to update itself.
//
// `shell` because on Windows `npx` is a `.cmd`, which cannot be spawned as an executable.
execFileSync(
  'npx',
  ['electron-builder', '--win', '--config', 'electron-builder.yml', '--publish', 'always'],
  {
    cwd: resolve(repoRoot, 'desktop'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, GH_TOKEN: token() },
  },
);

// 3. Publish whatever came out as a draft.
const releases = await github('/releases?per_page=30');
const draft = releases.find((entry) => entry.tag_name === tag && entry.draft);
if (draft) {
  const published = await github(`/releases/${draft.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ draft: false, name: `WooSSH ${version}`, prerelease: false }),
  });
  console.log(`[release] published the draft: ${published.html_url}`);
} else {
  const existing = releases.find((entry) => entry.tag_name === tag);
  console.log(existing ? `[release] already published: ${existing.html_url}` : '[release] no release found');
}

const final = (await github('/releases?per_page=30')).find((entry) => entry.tag_name === tag);
if (!final) {
  console.error('[release] FAILED: no release for this tag');
  process.exit(1);
}
console.log(`[release] ${final.draft ? 'STILL A DRAFT' : 'published'} — ${final.html_url}`);
for (const asset of final.assets) {
  console.log(`  ${asset.name.padEnd(34)} ${asset.size.toLocaleString('en-US').padStart(12)} bytes`);
}
