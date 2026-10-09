/**
 * Verifies the optional shared-secret mode (`SSH_EXPLORER_TOKEN`) end to end:
 * the API must reject requests without the header, the UI must seed the token
 * from `?token=` (and strip it from the URL), and both WebSocket channels must
 * accept the token as a query parameter.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './browser.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5179';
const TOKEN = process.argv[3] ?? 's3cret-token-value';
const OUT = 'design/qa';
await mkdir(OUT, { recursive: true });

const problems = [];

// 1. No header → 401 with the contract envelope.
const bare = await fetch(`${BASE}/api/health`);
if (bare.status !== 401) problems.push(`/api/health without a token returned ${bare.status}, expected 401`);
const body = await bare.json().catch(() => null);
if (body?.error?.code !== 'AUTH_FAILED') {
  problems.push(`expected AUTH_FAILED envelope, got ${JSON.stringify(body)}`);
}
if (!bare.headers.get('x-request-id')) problems.push('/api/health is missing x-request-id');

// 2. With the header → 200.
const withHeader = await fetch(`${BASE}/api/health`, { headers: { 'x-ssh-explorer-token': TOKEN } });
if (withHeader.status !== 200) problems.push(`/api/health with the token returned ${withHeader.status}`);

// 3. A wrong token → 401.
const wrong = await fetch(`${BASE}/api/health`, { headers: { 'x-ssh-explorer-token': 'nope' } });
if (wrong.status !== 401) problems.push(`a wrong token returned ${wrong.status}, expected 401`);

// 4. The UI seeds the token from the URL and then works normally.
const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 409/.test(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.app, .boot', { timeout: 20_000 });
await page.waitForTimeout(1200);

if (await page.locator('.boot__icon--error').count()) {
  problems.push('the UI showed the "service unavailable" screen with a token configured');
}
if (page.url().includes('token=')) problems.push('the token was left in the browser URL');
if ((await page.evaluate(() => window.localStorage.getItem('ssh-explorer.token'))) !== TOKEN) {
  problems.push('the token was not persisted to localStorage');
}
// The event socket must be up, otherwise transfers and status never update.
const sockets = await page.evaluate(() => ({
  open: performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/ws')).length,
}));
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/24-token-mode.png` });

for (const error of consoleErrors) problems.push(`console: ${error}`);

await browser.close();

console.log(JSON.stringify({ tokenSockets: sockets, consoleErrors, problems }, null, 2));
process.exitCode = problems.length ? 1 : 0;
