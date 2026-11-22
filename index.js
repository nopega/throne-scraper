// Runner: launch browser -> pass Cloudflare -> scrape() -> save JSON -> post to Discord.
// Usage:  npm start
//         npm start -- --headed        (show the window, e.g. to tick a Turnstile checkbox once)
//         npm start -- https://other-url
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { launchBrowser, gotoWithCloudflare, BlockedError } from './lib/browser.js';
import { sendToDiscord, clip } from './lib/discord.js';
import { scrape, toDiscordEmbed, TARGET_URL } from './scrape.js';

const argv = process.argv.slice(2);
const url = argv.find(a => !a.startsWith('--')) || TARGET_URL;
const headed = argv.includes('--headed') || process.env.HEADLESS === 'false';
const chrome = argv.includes('--chrome');
const timeoutS = Number(process.env.CF_TIMEOUT || (headed ? 120 : 60));

if (!url) { console.error('Set TARGET_URL in .env or pass a URL'); process.exit(1); }

// ---------------------------------------------------------------------
//  แจ้ง Discord เฉพาะตอนมีการเปลี่ยนแปลง
//  - เก็บผลรอบก่อนไว้ใน state/last.json (บน GitHub ใช้ actions/cache พาข้ามรอบ)
//  - NOTIFY_ALWAYS=true → ส่งทุกรอบเหมือนเดิม
// ---------------------------------------------------------------------
const STATE_FILE = process.env.STATE_FILE || 'state/last.json';
const notifyAlways = process.env.NOTIFY_ALWAYS === 'true' || argv.includes('--always');

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return null; }
}
function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// เทียบรายการสินค้ารอบนี้กับรอบก่อน → เพิ่ม / หาย / ราคาเปลี่ยน
function diffItems(prevItems = [], items = []) {
  const key = i => i.id ?? i.url ?? i.name;
  const prev = new Map(prevItems.map(i => [key(i), i]));
  const now = new Map(items.map(i => [key(i), i]));
  const added = items.filter(i => !prev.has(key(i)));
  const removed = prevItems.filter(i => !now.has(key(i)));
  const priceChanged = items
    .filter(i => prev.has(key(i)) && prev.get(key(i)).price_text !== i.price_text)
    .map(i => ({ ...i, old_price_text: prev.get(key(i)).price_text }));
  return { added, removed, priceChanged, changed: added.length + removed.length + priceChanged.length > 0 };
}

function diffText(d) {
  const cut = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const lines = [
    ...d.added.slice(0, 5).map(i => `🆕 ${cut(i.name)} — ${i.price_text ?? '-'}`),
    ...d.removed.slice(0, 5).map(i => `❌ ${cut(i.name)} (หายไป)`),
    ...d.priceChanged.slice(0, 5).map(i => `💲 ${cut(i.name)}: ${i.old_price_text ?? '-'} → ${i.price_text ?? '-'}`),
  ];
  const more = d.added.length + d.removed.length + d.priceChanged.length - lines.length;
  return lines.join('\n') + (more > 0 ? `\n…และอีก ${more} รายการ` : '');
}

const prevState = loadState();
console.log(prevState ? `[state] loaded previous run from ${prevState.checked_at}` : '[state] no previous state (first run)');

const { context, page } = await launchBrowser({ headless: !headed, chrome });
let code = 0;
try {
  await gotoWithCloudflare(page, url, { timeoutS });
  const data = await scrape(page);
  data.scraped_at = new Date().toISOString();

  writeFileSync('result.json', JSON.stringify(data, null, 2), 'utf-8');
  await page.screenshot({ path: 'page.jpg', type: 'jpeg', quality: 70 });
  console.log(`[ok] saved result.json`);

  // ได้ 0 ชิ้น = selector น่าจะพัง → แจ้งครั้งเดียว ไม่ต้องแจ้งซ้ำทุกรอบ
  if (data.items.length === 0) {
    if (prevState?.status === 'empty' && !notifyAlways) console.log('[discord] still 0 items → skip');
    else await sendToDiscord(toDiscordEmbed(data), ['page.jpg', 'result.json']);
    saveState({ ...(prevState || {}), status: 'empty', checked_at: data.scraped_at });
    throw Object.assign(new Error('__handled_empty__'), { handled: true });
  }

  const firstRun = !prevState?.items;
  const recovered = prevState?.status === 'error' || prevState?.status === 'empty';
  const d = diffItems(prevState?.items, data.items);
  console.log(`[diff] +${d.added.length} -${d.removed.length} price:${d.priceChanged.length}`);

  if (notifyAlways || firstRun || recovered || d.changed) {
    const embed = toDiscordEmbed(data);
    const note = firstRun ? '📌 รอบแรก (เริ่มติดตาม)'
      : d.changed ? diffText(d)
      : recovered ? '✅ กลับมาใช้งานได้แล้ว (ไม่มีรายการเปลี่ยน)'
      : 'ไม่มีการเปลี่ยนแปลง';
    embed.description = clip(`${note}\n\n${embed.description || ''}`, 4000);
    await sendToDiscord(embed, ['page.jpg', 'result.json']);
  } else {
    console.log('[discord] no change since last run → skip');
  }
  // เก็บเฉพาะรอบที่ดึงได้จริง (ถ้าได้ 0 ชิ้นเพราะ selector พัง จะไม่ทับรายการเดิม)
  saveState({
    status: 'ok',
    checked_at: data.scraped_at,
    items: data.items,
  });
} catch (err) {
  if (err.handled) { /* 0 ชิ้น — จัดการไปแล้วข้างบน */ } else {
  code = err instanceof BlockedError ? 2 : 1;
  await page.screenshot({ path: 'error.jpg', type: 'jpeg', quality: 70 }).catch(() => {});
  console.error(`[error] ${err.message}`);
  // error เดิมซ้ำทุก 30 นาทีไม่ต้องแจ้งซ้ำ — แจ้งแค่ครั้งแรกที่เริ่มพัง
  const errKey = code === 2 ? 'blocked' : err.message.slice(0, 200);
  const sameError = prevState?.status === 'error' && prevState.error === errKey;
  saveState({ ...(prevState || {}), status: 'error', error: errKey, error_at: new Date().toISOString() });
  if (sameError && !notifyAlways) {
    console.log('[discord] same error as last run → skip');
  } else await sendToDiscord({
    title: code === 2 ? '⛔ Blocked by Cloudflare' : '❌ Scrape failed',
    url,
    description: code === 2 ? 'Challenge did not clear before timeout.' : '```' + err.message.slice(0, 1500) + '```',
    color: 0xe74c3c,
    fields: err.status ? [{ name: 'HTTP', value: err.status, inline: true }] : [],
    image: { url: 'attachment://error.jpg' },
  }, ['error.jpg']).catch(e => console.error('[discord]', e.message));
  }
} finally {
  await context.close();
}
process.exit(code);
