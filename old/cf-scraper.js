// Headless Playwright scraper for Cloudflare-fronted sites -> Discord webhook.
//
// Default target: https://www.scrapingcourse.com/cloudflare-challenge
// (a practice page built for testing scrapers against Cloudflare).
//
// How it gets through Cloudflare's JS challenge in headless mode:
//   - Chromium "new headless" (channel: 'chromium'), the full browser rather than the
//     stripped-down headless shell.
//   - playwright-extra + stealth plugin: hides navigator.webdriver, the "HeadlessChrome"
//     user agent, missing plugins/WebGL quirks, etc.
//   - Persistent profile: the cf_clearance cookie is reused on later runs.
// It does NOT solve interactive Turnstile/CAPTCHA. If one appears, the run is reported
// as blocked (with a screenshot) to Discord, exit code 2.
//
// Setup:   npm install
//          copy .env.example to .env and set DISCORD_WEBHOOK_URL
// Usage:   npm run scrape
//          node --env-file=.env cf-scraper.js <url> --selector "h2.title"
//          node --env-file=.env cf-scraper.js <url> --headed   (show the window, for debugging)
//          node cf-scraper.js <url> --webhook https://discord.com/api/webhooks/...

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

chromium.use(stealth());

const DEFAULT_URL = 'https://www.scrapingcourse.com/cloudflare-challenge';
// Keep the browser profile on the Linux filesystem: a profile under /mnt/c (WSL) is slow
// and can hit file-locking errors. Override with PW_PROFILE_DIR in .env if needed.
const PROFILE_DIR = process.env.PW_PROFILE_DIR || join(homedir(), '.cf-scraper-profile');
const CHALLENGE_TITLES = ['just a moment', 'attention required', 'please wait', 'checking your browser'];
const CHALLENGE_MARKERS = ['cf-chl', 'challenge-platform', 'cf-turnstile', 'challenges.cloudflare.com'];

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL, selector: null, out: 'result.json', headed: false, chrome: false,
    timeout: 60, webhook: process.env.DISCORD_WEBHOOK_URL || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selector') args.selector = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--webhook') args.webhook = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (a === '--chrome') args.chrome = true;
    else if (!a.startsWith('--')) args.url = a;
  }
  return args;
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

async function waitForClearance(page, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    if (!(await isChallenge(page))) return true;
    if (!announced) { console.log('[cf] challenge detected, waiting...'); announced = true; }
    // small human-ish mouse movement; some challenges wait for any interaction signal
    await page.mouse.move(200 + Math.random() * 600, 200 + Math.random() * 400, { steps: 8 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  return !(await isChallenge(page));
}

async function extract(page, selector) {
  const data = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    headings: [...document.querySelectorAll('h1,h2,h3')]
      .map(h => h.innerText.trim()).filter(Boolean).slice(0, 50),
    paragraphs: [...document.querySelectorAll('p')]
      .map(p => p.innerText.trim()).filter(t => t.length > 20).slice(0, 30),
    links: [...document.querySelectorAll('a[href]')]
      .map(a => ({ text: a.innerText.trim(), href: a.href }))
      .filter(l => l.text).slice(0, 100),
  }));
  if (selector) data.selected = await page.locator(selector).allInnerTexts();
  return data;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

async function sendToDiscord(webhook, { ok, url, data, status, screenshot, jsonFile }) {
  if (!webhook) { console.log('[discord] no webhook set, skipping'); return; }

  const fields = [];
  if (ok) {
    if (data.headings.length) fields.push({ name: 'Headings', value: clip(data.headings.slice(0, 10).map(h => `• ${h}`).join('\n'), 1024) });
    if (data.selected?.length) fields.push({ name: 'Selected', value: clip(data.selected.slice(0, 15).map(s => `• ${s}`).join('\n'), 1024) });
    fields.push({ name: 'Links found', value: String(data.links.length), inline: true });
    fields.push({ name: 'cf_clearance', value: data.cf_clearance_cookie ? 'yes' : 'no', inline: true });
  }
  fields.push({ name: 'HTTP', value: String(status ?? '?'), inline: true });

  const embed = {
    title: clip(ok ? `✅ ${data.title || 'Scraped'}` : '⛔ Blocked by Cloudflare', 256),
    url,
    description: ok ? clip(data.paragraphs.slice(0, 3).join('\n\n'), 2000) : 'Challenge did not clear before timeout. See screenshot.',
    color: ok ? 0x2ecc71 : 0xe74c3c,
    fields,
    image: screenshot ? { url: 'attachment://screenshot.jpg' } : undefined,
    timestamp: new Date().toISOString(),
  };

  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'cf-scraper', embeds: [embed] }));
  let i = 0;
  if (screenshot) form.append(`files[${i++}]`, new Blob([readFileSync(screenshot)], { type: 'image/jpeg' }), 'screenshot.jpg');
  if (jsonFile) form.append(`files[${i++}]`, new Blob([readFileSync(jsonFile)], { type: 'application/json' }), 'result.json');

  const res = await fetch(webhook, { method: 'POST', body: form });
  if (res.ok) console.log('[discord] sent');
  else console.log(`[discord] failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: args.chrome ? 'chrome' : 'chromium', // 'chromium' = new headless (full browser)
    headless: !args.headed,
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    let resp;
    try {
      resp = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log('[error] page load failed:', e.message.split('\n')[0]);
      return 1;
    }
    const status = resp ? resp.status() : null;
    console.log(`[http] status ${status ?? '?'}`);

    if (!(await waitForClearance(page, args.timeout))) {
      await page.screenshot({ path: 'blocked.jpg', type: 'jpeg', quality: 70 });
      console.log('[cf] still blocked. Screenshot: blocked.jpg');
      await sendToDiscord(args.webhook, { ok: false, url: args.url, status, screenshot: 'blocked.jpg' });
      return 2;
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500 + Math.random() * 1000);

    const cookies = await ctx.cookies();
    const data = await extract(page, args.selector);
    data.scraped_at = new Date().toISOString();
    data.cf_clearance_cookie = cookies.some(c => c.name === 'cf_clearance');

    writeFileSync(args.out, JSON.stringify(data, null, 2), 'utf-8');
    await page.screenshot({ path: 'page.jpg', type: 'jpeg', quality: 70 });
    console.log(`[ok] "${data.title}" -> ${args.out}`);
    data.headings.slice(0, 5).forEach(h => console.log('   -', h));

    await sendToDiscord(args.webhook, { ok: true, url: page.url(), data, status, screenshot: 'page.jpg', jsonFile: args.out });
    return 0;
  } finally {
    await ctx.close();
  }
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
