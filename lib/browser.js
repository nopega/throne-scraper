// Browser setup + Cloudflare wait. You normally don't need to edit this file.
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { homedir } from 'node:os';
import { join } from 'node:path';

chromium.use(stealth());

const CHALLENGE_TITLES = ['just a moment', 'attention required', 'please wait', 'checking your browser', 'performing security verification'];
const CHALLENGE_MARKERS = ['cf-chl', 'challenge-platform', 'cf-turnstile', 'challenges.cloudflare.com'];

export class BlockedError extends Error {
  constructor(status) { super('Blocked by Cloudflare'); this.status = status; }
}

export async function launchBrowser({ headless = true, chrome = false } = {}) {
  // Profile lives on the Linux filesystem (faster, no lock issues under /mnt/c) and keeps cf_clearance.
  const profileDir = process.env.PW_PROFILE_DIR || join(homedir(), '.cf-scraper-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: chrome ? 'chrome' : 'chromium', // 'chromium' = new headless (full browser)
    headless,
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

async function isChallenge(page) {
  try {
    const title = (await page.title()).toLowerCase();
    const html = (await page.content()).toLowerCase();
    if (CHALLENGE_TITLES.some(t => title.includes(t))) return true;
    return CHALLENGE_MARKERS.some(m => html.includes(m)) && html.length < 20000;
  } catch {
    return true; // mid-navigation, usually during the challenge redirect
  }
}

// Navigate and wait until Cloudflare's challenge page is gone.
// Throws BlockedError if it doesn't clear within timeoutS (e.g. an interactive checkbox in headless mode).
export async function gotoWithCloudflare(page, url, { timeoutS = 60 } = {}) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const status = resp ? resp.status() : null;
  console.log(`[http] ${status ?? '?'} ${url}`);

  const deadline = Date.now() + timeoutS * 1000;
  let announced = false;
  while (await isChallenge(page)) {
    if (Date.now() > deadline) throw new BlockedError(status);
    if (!announced) { console.log('[cf] challenge detected, waiting...'); announced = true; }
    await page.mouse.move(200 + Math.random() * 600, 200 + Math.random() * 400, { steps: 8 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return status;
}
