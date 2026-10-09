/**
 * Browser QA driver.
 *
 *   node tools/qa/run-qa.mjs [--url http://127.0.0.1:5174] [--out design/qa]
 *
 * Boots Chromium, exercises the real UI flow, captures screenshots at native
 * concept size (1024x768) plus a desktop working size, and fails the process on
 * any console error or uncaught page exception.
 *
 * Environment (optional) — when set, the driver also completes a live SSH
 * connection so the file browser, inspector, transfers and terminal are captured
 * with real data:
 *   SSH_QA_HOST, SSH_QA_PORT, SSH_QA_USER, SSH_QA_PASSWORD, SSH_QA_KEY
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = arg('url', process.env.SSH_QA_URL ?? 'http://127.0.0.1:5174');

/**
 * The API requires a shared secret by default. QA runs against a server started
 * with a known `SSH_EXPLORER_TOKEN`, and the app seeds the token from `?token=`
 * exactly as it does for the desktop shell.
 */
const TOKEN = process.env.SSH_EXPLORER_TOKEN ?? '';
const APP_URL = TOKEN ? `${BASE}/?token=${encodeURIComponent(TOKEN)}` : BASE;
const OUT = path.resolve(arg('out', 'design/qa'));
const CONCEPT_SIZE = { width: 1024, height: 768 };
const DESKTOP_SIZE = { width: 1512, height: 900 };

const problems = [];
/** Hoisted so the fatal handler can always shut it down. */
let browser = null;
const expected = [];
const log = (...parts) => console.log('[qa]', ...parts);

/**
 * A 409 from `POST /api/connections` is the designed host-key challenge flow, so
 * it is recorded as expected rather than as a defect.
 */
const isExpected = (text) =>
  /status of 409/.test(text) || /Failed to load resource.*409/.test(text);

async function shoot(page, name, size, clip) {
  if (size) await page.setViewportSize(size);
  await page.waitForTimeout(320);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, ...(clip ? { clip } : {}) });
  log('shot', path.relative(process.cwd(), file));
  return file;
}

function attachDiagnostics(page, label) {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (/favicon|Download the React DevTools|React Router Future Flag/i.test(text)) return;
    if (isExpected(text)) {
      expected.push({ label, kind: `console.${message.type()}`, text });
      return;
    }
    problems.push({ label, kind: `console.${message.type()}`, text });
  });
  page.on('pageerror', (error) => {
    problems.push({ label, kind: 'pageerror', text: error.message });
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    if (!failure) return;
    if (/favicon/.test(request.url())) return;
    problems.push({ label, kind: 'requestfailed', text: `${request.url()} — ${failure.errorText}` });
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });

  browser = await launchBrowser({ headless: true });
  const context = await browser.newContext({
    viewport: DESKTOP_SIZE,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    // The UI follows the browser language. Pin it so the English selectors below
    // are stable on a machine with a Russian locale; the Russian pass is explicit.
    locale: 'en-US',
  });
  const page = await context.newPage();
  attachDiagnostics(page, 'main');

  log('opening', BASE);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app, .boot', { timeout: 20_000 });
  await page.waitForTimeout(700);

  const bootFailed = await page.locator('.boot__icon--error').count();
  if (bootFailed) {
    const text = await page.locator('.boot__card p').first().innerText();
    problems.push({ label: 'boot', kind: 'api-unreachable', text });
  }

  /* ---------------------------------------------------------- welcome --- */
  await shoot(page, '01-welcome-dark');

  const alreadyConnected = (await page.locator('.ftable').count()) > 0;
  if (alreadyConnected) {
    log('a connection was already open — skipping the connect flow');
    await shoot(page, '04-explorer-dark', CONCEPT_SIZE);
  }

  if (!alreadyConnected) {
    await page.locator('button:has-text("New connection")').first().click();
    await page.waitForSelector('.modal', { timeout: 8000 });
    await shoot(page, '02-connection-dialog-dark');

    const host = process.env.SSH_QA_HOST;
    if (host) {
      await page.fill('#conn-host', host);
      await page.fill('#conn-port', String(process.env.SSH_QA_PORT ?? 22));
      await page.fill('#conn-user', String(process.env.SSH_QA_USER ?? 'tester'));

      if (process.env.SSH_QA_KEY) {
        await page.click('.segmented__item:has-text("Private key")');
        await page.fill('#conn-key', process.env.SSH_QA_KEY);
      } else {
        await page.click('.segmented__item:has-text("Password")');
        await page.fill('#conn-pass', String(process.env.SSH_QA_PASSWORD ?? ''));
      }

      await page.click('.modal__foot button:has-text("Connect")');

      // A first contact raises the host-key dialog.
      await page.waitForTimeout(900);
      if (await page.locator('.modal:has-text("Unknown host key")').count()) {
        await shoot(page, '03-hostkey-dialog-dark');
        await page.click('button:has-text("Trust and continue")');
      }

      await page.waitForSelector('.ftable', { timeout: 25_000 });
      await page.waitForTimeout(900);
    }
  }

  if (process.env.SSH_QA_HOST && (await page.locator('.ftable').count())) {
    const dumpTabs = async (step) =>
      log(`tabs@${step}:`, (await page.locator('.tab').allInnerTexts()).join(' | ') || '(none)');

    await dumpTabs('connected');
    await shoot(page, '04-explorer-dark', CONCEPT_SIZE);
    await shoot(page, '05-explorer-desktop', DESKTOP_SIZE);
    await page.setViewportSize(CONCEPT_SIZE);

    // Selection + inspector
    const rows = page.locator('.frow:visible');
    const rowCount = await rows.count();
    log('rows', rowCount);
    if (rowCount > 2) {
      await rows.nth(2).click();
      await page.waitForTimeout(700);
      await shoot(page, '06-selection-inspector');
    }
    await dumpTabs('selection');

    // Context menu
    if (rowCount > 1) {
      await rows.nth(1).click({ button: 'right' });
      await page.waitForSelector('.menu', { timeout: 5000 });
      await shoot(page, '07-context-menu');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await dumpTabs('context-menu');

    // Grid view
    await page.click('.segmented--icons button[title="Grid view"]');
    await page.waitForTimeout(400);
    await shoot(page, '08-grid-view');
    await page.click('.segmented--icons button[title="List view"]');
    await page.waitForTimeout(200);
    await dumpTabs('grid');

    // Terminal tab
    const tabsBefore = await page.locator('.tab').count();
    await page.click('.tabstrip__actions button[aria-label="New terminal"]');
    await page.waitForSelector('.tpane', { timeout: 8000 });
    await page.waitForTimeout(1500);
    const tabsAfter = await page.locator('.tab').count();
    if (tabsAfter !== tabsBefore + 1) {
      problems.push({
        label: 'tabs',
        kind: 'duplicate-tabs',
        text: `clicking "New terminal" once changed the tab count from ${tabsBefore} to ${tabsAfter}`,
      });
    }
    await page.keyboard.type('echo ssh-explorer-ok\n');
    const echoed = await page
      .waitForFunction(
        () => (document.querySelector('.tpane__host')?.textContent ?? '').includes('ssh-explorer-ok'),
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!echoed) {
      problems.push({
        label: 'terminal',
        kind: 'no-echo',
        text: 'the PTY did not return the echoed command',
      });
    }
    await shoot(page, '09-terminal');
    log('tabs:', (await page.locator('.tab').allInnerTexts()).join(' | '));

    // Transfer dock
    await page.click('.tabstrip__actions button[aria-label="Transfer manager"]');
    await page.waitForTimeout(400);
    await shoot(page, '10-transfers');

    // Back to files, open the dock
    await page.click('.tab--files');
    await page.waitForTimeout(500);
    await page.click('.statusbar__toggle:has-text("Idle"), .statusbar__toggle.is-live');
    await page.waitForTimeout(400);
    await shoot(page, '11-transfer-dock');
    await page.click('.dock__head button[aria-label="Hide panel"]');
    await page.waitForTimeout(300);

    /* ------------------------------------------- file states and dialogs -- */
    const textRow = page.locator('.frow', { hasText: 'readme.txt' }).first();
    if (await textRow.count()) {
      await textRow.click();
      await page.waitForTimeout(900);
      await shoot(page, '17-text-preview');
      const previewLines = await page.locator('.code__line').count();
      log('preview lines', previewLines);
      if (previewLines === 0) {
        problems.push({
          label: 'preview',
          kind: 'no-preview',
          text: 'selecting a text file produced no preview lines',
        });
      }
    }

    // Multi-select
    const allRows = page.locator('.frow:visible');
    const total = await allRows.count();
    if (total >= 3) {
      await allRows.nth(0).click();
      await allRows.nth(2).click({ modifiers: ['Shift'] });
      await page.waitForTimeout(400);
      const selected = await page.locator('.frow.is-selected').count();
      if (selected < 2) {
        problems.push({
          label: 'selection',
          kind: 'shift-range',
          text: `shift-click selected ${selected} rows, expected at least 2`,
        });
      }
      await shoot(page, '18-multi-select');
    }

    // New-folder dialog
    await page.keyboard.press('Control+Shift+N');
    await page.waitForSelector('.modal:has-text("New folder")', { timeout: 5000 });
    await shoot(page, '19-new-folder-dialog');
    await page.click('.modal__foot button:has-text("Cancel")');
    await page.waitForTimeout(250);

    // Rename dialog
    await allRows.nth(0).click();
    await page.keyboard.press('F2');
    await page.waitForSelector('.modal:has-text("Rename")', { timeout: 5000 });
    await shoot(page, '20-rename-dialog');
    await page.click('.modal__foot button:has-text("Cancel")');
    await page.waitForTimeout(250);

    // Delete confirmation
    await allRows.nth(0).click();
    await page.keyboard.press('Delete');
    await page.waitForSelector('.modal:has-text("Delete")', { timeout: 5000 });
    await shoot(page, '21-delete-confirm');
    await page.click('.modal__foot button:has-text("Cancel")');
    await page.waitForTimeout(250);

    // Filter with no matches → empty state
    await page.fill('.toolbar__search input', 'zzz-no-match');
    await page.waitForTimeout(500);
    await shoot(page, '22-empty-filter');
    const emptyVisible = await page.locator('.empty__title').count();
    if (!emptyVisible) {
      problems.push({
        label: 'filter',
        kind: 'no-empty-state',
        text: 'a filter with no matches did not render the empty state',
      });
    }
    await page.fill('.toolbar__search input', '');
    await page.waitForTimeout(300);

    // Recursive search (Enter in the filter field)
    await page.fill('.toolbar__search input', 'txt');
    await page.press('.toolbar__search input', 'Enter');
    await page.waitForSelector('.searchbanner', { timeout: 10_000 });
    await page.waitForTimeout(1200);
    await shoot(page, '23-recursive-search');
    const hits = await page.locator('.frow:visible').count();
    log('search hits', hits);
    if (hits === 0) {
      problems.push({
        label: 'search',
        kind: 'no-results',
        text: 'the recursive search returned no rows for "txt"',
      });
    }
    await page.click('.searchbanner button');
    await page.waitForTimeout(400);
    if (await page.locator('.searchbanner').count()) {
      problems.push({
        label: 'search',
        kind: 'banner-stuck',
        text: 'the search banner did not clear when returning to the folder',
      });
    }

    // Keyboard navigation
    await allRows.nth(0).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const afterKeys = await page.locator('.frow.is-selected').count();
    if (afterKeys !== 1) {
      problems.push({
        label: 'keyboard',
        kind: 'arrow-nav',
        text: `arrow keys left ${afterKeys} rows selected, expected 1`,
      });
    }
    await page.keyboard.press('Escape');

    /* -------------------------------------- saved credentials in the dialog */
    // The connect above saves the credential by default, so reopening the dialog
    // for the same host must offer it instead of asking for the password again.
    await page.keyboard.press('Control+n');
    await page.waitForSelector('.modal', { timeout: 8000 });
    await page.fill('#conn-host', String(process.env.SSH_QA_HOST ?? ''));
    await page.fill('#conn-port', String(process.env.SSH_QA_PORT ?? 22));
    await page.fill('#conn-user', String(process.env.SSH_QA_USER ?? 'tester'));
    await page.waitForTimeout(600);
    const savedRow = await page.locator('.savedcred').count();
    if (!savedRow) {
      problems.push({
        label: 'credentials',
        kind: 'not-offered',
        text: 'reopening the dialog for a host with a saved credential did not offer it',
      });
    }
    await shoot(page, '25-saved-credentials');

    /* ------------------------------------------------------- saved hosts --- */
    // The same dialog must also offer the saved host itself, and picking it must
    // fill the form rather than leaving the user to retype it.
    const savedHosts = await page.locator('.savedhosts__row').count();
    if (savedHosts === 0) {
      problems.push({
        label: 'saved-hosts',
        kind: 'not-listed',
        text: 'the New connection dialog listed no saved hosts after a successful connect',
      });
    } else {
      // Captured before picking: the list is only offered while creating.
      await shoot(page, '31-saved-hosts');
      await page.fill('#conn-host', '');
      await page.fill('#conn-user', '');
      await page.locator('.savedhosts__row').first().click();
      await page.waitForTimeout(700);
      const host = await page.inputValue('#conn-host');
      const user = await page.inputValue('#conn-user');
      if (host !== String(process.env.SSH_QA_HOST ?? '') || user !== String(process.env.SSH_QA_USER ?? 'tester')) {
        problems.push({
          label: 'saved-hosts',
          kind: 'not-filled',
          text: `picking a saved host left host="${host}" user="${user}"`,
        });
      }
    }

    await page.click('.modal__head button[aria-label="Close"]');
    await page.waitForTimeout(300);

    /* ------------------------------------------------------ inspector resize */
    const before = await page.locator('.inspector').boundingBox();
    const handle = await page.locator('.inspector__resizer').boundingBox();
    if (before && handle) {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x - 140, handle.y + handle.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(350);
      const after = await page.locator('.inspector').boundingBox();
      if (!after || after.width <= before.width + 60) {
        problems.push({
          label: 'inspector',
          kind: 'resize-ineffective',
          text: `width went from ${before.width} to ${after?.width} after a 140px drag`,
        });
      }
      await shoot(page, '26-inspector-wide');
      // The handle travels with the edge it resizes, so re-measure before using it.
      const movedHandle = await page.locator('.inspector__resizer').boundingBox();
      if (movedHandle) {
        await page.mouse.dblclick(
          movedHandle.x + movedHandle.width / 2,
          movedHandle.y + movedHandle.height / 2,
        );
        await page.waitForTimeout(350);
        const restored = await page.locator('.inspector').boundingBox();
        if (!restored || Math.abs(restored.width - before.width) > 4) {
          problems.push({
            label: 'inspector',
            kind: 'reset-failed',
            text: `double-click left the width at ${restored?.width}, expected ${before.width}`,
          });
        }
      }
    } else {
      problems.push({ label: 'inspector', kind: 'missing', text: 'no resize handle in the DOM' });
    }

    /* ------------------------------------------------------ shift selection */
    // Earlier steps leave a filter or a recursive search active; start from a
    // clean folder listing so there is a real run to range over.
    if (await page.locator('.searchbanner button:has-text("Back to folder")').count()) {
      await page.click('.searchbanner button:has-text("Back to folder")');
      await page.waitForTimeout(500);
    }
    await page.fill('.toolbar__search input', '');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const rowsForRange = await page.locator('.frow:visible').count();
    if (rowsForRange >= 4) {
      const paths = await page.evaluate(() =>
        [...document.querySelectorAll('.frow:not([hidden])')].map((row) => row.getAttribute('data-path')),
      );
      await page.locator('.frow:visible').nth(0).click();
      await page.waitForTimeout(150);
      await page.locator('.frow:visible').nth(3).click({ modifiers: ['Shift'] });
      await page.waitForTimeout(300);
      const selected = await page.evaluate(() =>
        [...document.querySelectorAll('.frow.is-selected')].map((row) => row.getAttribute('data-path')),
      );
      const expected = paths.slice(0, 4);
      if (JSON.stringify(selected) !== JSON.stringify(expected)) {
        problems.push({
          label: 'selection',
          kind: 'range-mismatch',
          text: `shift-click selected ${JSON.stringify(selected)}, expected ${JSON.stringify(expected)}`,
        });
      }

      // Sorting rewrites the on-screen order; the run must follow it too.
      await page.click('.fhead:has-text("Size")');
      await page.waitForTimeout(400);
      const sortedPaths = await page.evaluate(() =>
        [...document.querySelectorAll('.frow:not([hidden])')].map((row) => row.getAttribute('data-path')),
      );
      await page.locator('.frow:visible').nth(0).click();
      await page.waitForTimeout(150);
      await page.locator('.frow:visible').nth(2).click({ modifiers: ['Shift'] });
      await page.waitForTimeout(300);
      const sortedSelected = await page.evaluate(() =>
        [...document.querySelectorAll('.frow.is-selected')].map((row) => row.getAttribute('data-path')),
      );
      if (JSON.stringify(sortedSelected) !== JSON.stringify(sortedPaths.slice(0, 3))) {
        problems.push({
          label: 'selection',
          kind: 'range-sorted-mismatch',
          text: `after sorting, shift-click selected ${JSON.stringify(sortedSelected)}`,
        });
      }
      await page.click('.fhead:has-text("Name")');
      await page.waitForTimeout(300);
    } else {
      problems.push({ label: 'selection', kind: 'too-few-rows', text: `only ${rowsForRange} rows to range over` });
    }

    /* --------------------------------------------------------- copy & paste */
    // Full round trip: copy a file, make a folder, paste into it, then check the
    // conflict prompt appears when the name is taken. The folder name is unique
    // per run so a leftover from an earlier run cannot make "Create folder" fail.
    {
      const folderName = `qa-paste-${Date.now().toString(36)}`;
      const folderPath = `/${folderName}`;
      const fileRow = page.locator('.frow:visible').filter({ has: page.locator('.fcell--size', { hasText: 'B' }) }).first();
      if (await fileRow.count()) {
        const sourcePath = await fileRow.getAttribute('data-path');
        const sourceName = sourcePath.split('/').pop();
        await fileRow.click();
        await page.waitForTimeout(200);
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(400);

        await page.click('.toolbar button[aria-label*="More actions"], .toolbar__more');
        await page.waitForTimeout(300);
        await page.click('.menu__item:has-text("New folder")');
        await page.waitForSelector('.modal', { timeout: 8000 });
        await page.fill('.modal input', folderName);
        await page.click('.modal__foot button:has-text("Create folder")');
        await page.waitForTimeout(2000);

        if (await page.locator('.modal').count()) {
          problems.push({
            label: 'clipboard',
            kind: 'new-folder-failed',
            text: (await page.locator('.modal').innerText()).split('\n').slice(0, 3).join(' | '),
          });
        } else {
          await page.locator(`.frow[data-path="${folderPath}"]`).dblclick();
          await page.waitForTimeout(1200);
          await page.keyboard.press('Control+v');
          await page.waitForTimeout(2500);

          const pasted = await page.evaluate(() =>
            [...document.querySelectorAll('.frow:not([hidden])')].map((row) => row.getAttribute('data-path')),
          );
          if (!pasted.includes(`${folderPath}/${sourceName}`)) {
            problems.push({
              label: 'clipboard',
              kind: 'paste-missing',
              text: `after Ctrl+C and Ctrl+V the folder holds ${JSON.stringify(pasted)}`,
            });
          }

          // Pasting the same name again must ask instead of silently replacing.
          await page.keyboard.press('Control+v');
          await page.waitForTimeout(2200);
          const prompt = await page.locator('.modal').innerText().catch(() => '');
          if (!/exist|существу/i.test(prompt)) {
            problems.push({
              label: 'clipboard',
              kind: 'no-conflict-prompt',
              text: `a second paste did not offer to skip or overwrite (modal: "${prompt.split('\n')[0] ?? ''}")`,
            });
          } else {
            await shoot(page, '29-paste-conflict');
            await page.click('.modal__foot button:has-text("Skip existing"), .modal__foot button:has-text("Оставить")');
            await page.waitForTimeout(800);
          }

          // Leave the fixture as it was found. Navigating with the toolbar button
          // rather than Backspace: focus sits outside the pane once a modal closes.
          await page.click('.toolbar button[aria-label="Parent folder"]');
          await page.waitForTimeout(1500);
          await page.locator(`.frow[data-path="${folderPath}"]`).click();
          await page.waitForTimeout(300);
          await page.keyboard.press('Delete');
          await page.waitForSelector('.modal', { timeout: 8000 });
          await page.click('.modal__foot button:has-text("Delete"), .modal__foot button:has-text("Удалить")');
          await page.waitForTimeout(2000);
        }
      } else {
        problems.push({ label: 'clipboard', kind: 'no-file-to-copy', text: 'the folder holds no file rows' });
      }
    }

    /* ------------------------------------------------------ new-tab chooser */
    // The "+" must ask which session to open in, and both answers must give a tab.
    {
      const before = await page.locator('.tab').count();
      await page.click('.tab__new');
      await page.waitForSelector('.menu', { timeout: 6000 });
      const entries = await page.locator('.menu__item').allInnerTexts();
      const joined = entries.join(' | ');
      if (!/this session|этой сессии/i.test(joined)) {
        problems.push({
          label: 'tabs',
          kind: 'no-session-choice',
          text: `the new-tab menu did not offer the current session: ${joined}`,
        });
      }
      await shoot(page, '30-new-tab-menu');
      await page.locator('.menu__item').first().click();
      await page.waitForTimeout(1500);
      const after = await page.locator('.tab').count();
      if (after <= before) {
        problems.push({
          label: 'tabs',
          kind: 'no-tab-added',
          text: `the tab count stayed at ${after} after choosing "this session"`,
        });
      }

      // Ctrl T asks the same question rather than opening a browser tab.
      await page.keyboard.press('Control+t');
      await page.waitForTimeout(600);
      if ((await page.locator('.menu').count()) === 0) {
        problems.push({ label: 'tabs', kind: 'hotkey-dead', text: 'Ctrl T did not open the chooser' });
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    /* -------------------------------------------------- folder sizes, stats */
    {
      // Sizes are on demand: the column reads "—" until the user asks for a measurement.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const folder = page.locator('.frow:visible').filter({ has: page.locator('.fcell--size', { hasText: '—' }) }).first();
      if (await folder.count()) {
        const path = await folder.getAttribute('data-path');
        await folder.click();
        await page.waitForTimeout(700);

        // Both tabs stay mounted, so the inspector must be scoped to the visible one.
        const measure = page.locator('.inspector:visible button:has-text("Measure folder sizes")');
        if ((await measure.count()) === 0) {
          problems.push({
            label: 'usage',
            kind: 'no-measure-button',
            text: `the inspector offered no measure action for ${path}`,
          });
        } else {
          await measure.first().click({ timeout: 15_000 });
          await page.waitForTimeout(3500);
          const cell = await page.locator('.frow:visible[data-path="' + path + '"] .fcell--size').innerText();
          if (cell.trim() === '—') {
            problems.push({
              label: 'usage',
              kind: 'not-measured',
              text: `measuring left ${path} at "—"`,
            });
          }
          await shoot(page, '32-folder-sizes');
        }
      } else {
        problems.push({ label: 'usage', kind: 'no-folder', text: 'no unmeasured folder to try' });
      }

      // Server status: one request, rendered defensively.
      await page.click('.topbar__host, .topbar__connection');
      await page.waitForTimeout(400);
      await page.click('.menu__item:has-text("Server status")');
      await page.waitForSelector('.modal:has-text("Server status")', { timeout: 8000 });
      await page.waitForTimeout(2500);
      const stats = await page.locator('.modal').innerText();
      if (!/uptime|kernel|memory/i.test(stats)) {
        problems.push({ label: 'stats', kind: 'empty', text: stats.split('\n').slice(0, 3).join(' | ') });
      }
      await shoot(page, '33-server-status');
      await page.click('.modal__foot button:has-text("Close")');
      await page.waitForTimeout(400);

      // Known hosts: the key trusted earlier in this run must be listed.
      await page.click('.topbar__host, .topbar__connection');
      await page.waitForTimeout(400);
      await page.click('.menu__item:has-text("Known hosts")');
      await page.waitForSelector('.modal:has-text("Known hosts")', { timeout: 8000 });
      await page.waitForTimeout(1500);
      const pinned = await page.locator('.known__row').count();
      if (pinned === 0) {
        problems.push({ label: 'known-hosts', kind: 'empty', text: 'no pinned key after trusting a host' });
      }
      await shoot(page, '34-known-hosts');
      await page.click('.modal__foot button:has-text("Close")');
      await page.waitForTimeout(400);
    }

    /* ------------------------------------------- status bar shows host vitals */
    {
      // The bottom bar carries load, memory and disk from the same cached answer the
      // panel uses — no second command, no polling storm.
      await page.waitForTimeout(2500);
      const bar = await page.locator('.statusbar').innerText();
      const vitals = await page.locator('.statusbar__item--action').count();
      if (vitals < 2) {
        problems.push({
          label: 'statusbar',
          kind: 'no-vitals',
          text: `expected clickable host vitals in the status bar, found ${vitals} (bar: ${bar.replace(/\s+/g, ' ').slice(0, 120)})`,
        });
      }
      await shoot(page, '36-status-bar-vitals');
    }

    /* -------------------------------------------------------- run on server */
    await allRows.nth(0).click();
    await page.click(
      '.inspector button:has-text("Run on server"), .inspector button:has-text("Run here")',
    );
    await page.waitForSelector('.modal:has-text("Run a command on the server")', { timeout: 8000 });
    await page.fill('#exec-command', 'uname -a');
    await page.click('.modal__foot button:has-text("Run")');
    await page.waitForSelector('.execout', { timeout: 20_000 });
    await page.waitForTimeout(700);
    const execOutput = (await page.locator('.execout__text').first().innerText()).trim();
    if (!execOutput) {
      problems.push({ label: 'exec', kind: 'no-output', text: 'the command returned nothing' });
    }
    await shoot(page, '27-run-on-server');
    await page.click('.modal__foot button:has-text("Close")');
    await page.waitForTimeout(250);
  }

  /* --------------------------------------------------- palette + theme --- */
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette', { timeout: 5000 });
  await page.waitForTimeout(250);
  await shoot(page, '12-command-palette');
  await page.keyboard.press('Escape');

  const toggle = page.locator('button[aria-label*="light theme"], button[aria-label*="dark theme"]').first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(400);
    await shoot(page, '13-light-theme', CONCEPT_SIZE);
    await toggle.click();
    await page.waitForTimeout(300);
  }

  /* ------------------------------------------------------- responsive --- */
  await shoot(page, '14-mobile', { width: 430, height: 860 });
  await shoot(page, '15-tablet', { width: 834, height: 1112 });

  /* ------------------------------------------- @2x detail for icon QA --- */
  if (process.env.SSH_QA_HOST) {
    const state = await context.storageState();
    const hi = await browser.newContext({
      viewport: DESKTOP_SIZE,
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      storageState: state,
    });
    const hiPage = await hi.newPage();
    attachDiagnostics(hiPage, 'detail');
    await hiPage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await hiPage.waitForSelector('.ftable', { timeout: 20_000 });
    await hiPage.waitForTimeout(700);
    await hiPage.locator('.frow').nth(1).click();
    await hiPage.waitForTimeout(500);
    const box = await hiPage.locator('.workbench__content').boundingBox();
    if (box) {
      await hiPage.screenshot({
        path: path.join(OUT, '16-table-detail@2x.png'),
        clip: { x: box.x, y: box.y, width: Math.min(box.width, 780), height: 420 },
      });
      log('shot design/qa/16-table-detail@2x.png');
    }
    await hi.close();
  }

  /* ------------------------------------------------- Russian localisation --- */
  // The dictionary is the only source of user-visible strings, so switching the
  // stored locale and reloading must translate the whole chrome.
  {
    // Earlier steps shrink the viewport; the sidebar is hidden below the tablet
    // breakpoint, so come back to the desktop size before sampling the chrome.
    await page.setViewportSize(DESKTOP_SIZE);
    await page.evaluate(() => window.localStorage.setItem('ssh-explorer.locale', 'ru'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app, .boot', { timeout: 20_000 });
    await page.waitForTimeout(900);

    const russian = await page.evaluate(() => {
      // `innerText` reflects `text-transform`, and the section labels are uppercased
      // in CSS — compare case-insensitively.
      const text = document.body.innerText.toLowerCase();
      const has = (needle) => text.includes(needle.toLowerCase());
      return {
        hasCyrillic: /[А-Яа-яЁё]/.test(text),
        // A handful of strings that must be translated, sampled across the chrome.
        samples: {
          connections: has('Подключения'),
          transfers: has('Передачи'),
          inspector: has('Инспектор'),
          name: has('Имя'),
          newConnection: has('Новое подключение'),
          commands: has('Команды'),
          connected: has('Подключено'),
        },
        htmlLang: document.documentElement.lang,
      };
    });

    if (!russian.hasCyrillic) {
      problems.push({ label: 'i18n', kind: 'not-translated', text: 'the Russian locale rendered an English UI' });
    }
    for (const [key, present] of Object.entries(russian.samples)) {
      if (!present) {
        problems.push({ label: 'i18n', kind: `missing-${key}`, text: `"${key}" was not translated` });
      }
    }
    if (russian.htmlLang !== 'ru') {
      problems.push({
        label: 'i18n',
        kind: 'wrong-lang',
        text: `<html lang> is "${russian.htmlLang}", expected "ru"`,
      });
    }

    await shoot(page, '28-russian');
    await page.evaluate(() => window.localStorage.removeItem('ssh-explorer.locale'));
  }

  await browser.close();

  const report = {
    url: BASE,
    capturedAt: new Date().toISOString(),
    problems,
    expected,
  };
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  if (expected.length) {
    log(`${expected.length} expected non-2xx response(s): host-key challenge`);
  }

  if (problems.length) {
    console.error('\n[qa] PROBLEMS');
    for (const problem of problems) {
      console.error(`  - [${problem.kind}] (${problem.label}) ${problem.text}`);
    }
    process.exitCode = 1;
  } else {
    log('no console errors, page exceptions or failed requests');
  }
}

main().catch(async (error) => {
  console.error('[qa] fatal:', error);
  // Without this the Playwright browser keeps the event loop alive and the command
  // never returns — a failure looked like a hang instead of a report.
  await browser?.close().catch(() => undefined);
  process.exitCode = 1;
});
