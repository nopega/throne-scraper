// Runner: launch browser -> pass Cloudflare -> scrape() -> save JSON -> post to Discord.
// Usage:  npm start
//         npm start -- --headed        (show the window, e.g. to tick a Turnstile checkbox once)
//         npm start -- https://other-url
import { writeFileSync } from 'node:fs';
import { launchBrowser, gotoWithCloudflare, BlockedError } from './lib/browser.js';
import { sendToDiscord } from './lib/discord.js';
import { scrape, toDiscordEmbed, TARGET_URL } from './scrape.js';

const argv = process.argv.slice(2);
const url = argv.find(a => !a.startsWith('--')) || TARGET_URL;
const headed = argv.includes('--headed') || process.env.HEADLESS === 'false';
const chrome = argv.includes('--chrome');
const timeoutS = Number(process.env.CF_TIMEOUT || (headed ? 120 : 60));

if (!url) { console.error('Set TARGET_URL in .env or pass a URL'); process.exit(1); }

const { context, page } = await launchBrowser({ headless: !headed, chrome });
let code = 0;
try {
  await gotoWithCloudflare(page, url, { timeoutS });
  const data = await scrape(page);
  data.scraped_at = new Date().toISOString();

  writeFileSync('result.json', JSON.stringify(data, null, 2), 'utf-8');
  await page.screenshot({ path: 'page.jpg', type: 'jpeg', quality: 70 });
  console.log(`[ok] saved result.json`);
  await sendToDiscord(toDiscordEmbed(data), ['page.jpg', 'result.json']);
} catch (err) {
  code = err instanceof BlockedError ? 2 : 1;
  await page.screenshot({ path: 'error.jpg', type: 'jpeg', quality: 70 }).catch(() => {});
  console.error(`[error] ${err.message}`);
  await sendToDiscord({
    title: code === 2 ? '⛔ Blocked by Cloudflare' : '❌ Scrape failed',
    url,
    description: code === 2 ? 'Challenge did not clear before timeout.' : '```' + err.message.slice(0, 1500) + '```',
    color: 0xe74c3c,
    fields: err.status ? [{ name: 'HTTP', value: err.status, inline: true }] : [],
    image: { url: 'attachment://error.jpg' },
  }, ['error.jpg']).catch(e => console.error('[discord]', e.message));
} finally {
  await context.close();
}
process.exit(code);
