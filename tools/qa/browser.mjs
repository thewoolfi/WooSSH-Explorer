import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/**
 * Launches Chromium, preferring an already-installed Chrome/Edge over a
 * Playwright browser download so the QA driver works on a fresh checkout.
 */
export async function launchBrowser(options = {}) {
  const installed = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (installed) {
    try {
      return await chromium.launch({ ...options, executablePath: installed });
    } catch (error) {
      console.warn('[qa] falling back to the bundled Chromium:', error.message);
    }
  }
  return chromium.launch(options);
}
