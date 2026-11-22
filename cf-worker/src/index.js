// Cloudflare Worker: cron -> เปิดเบราว์เซอร์บน Browser Run -> scrape -> ส่ง Discord
// ไม่ต้องแก้ไฟล์นี้ (แก้ที่ src/scrape.js)
import { launch, limits, sessions, history } from '@cloudflare/playwright';
import { scrape, toDiscordEmbed } from './scrape.js';

const CHALLENGE_TITLES = ['just a moment', 'attention required', 'please wait', 'checking your browser', 'performing security verification'];
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

async function sendToDiscord(env, embed, files = []) {
  if (!env.DISCORD_WEBHOOK_URL) { console.log('[discord] DISCORD_WEBHOOK_URL not set'); return; }
  const safe = {
    ...embed,
    title: clip(embed.title, 256),
    description: clip(embed.description, 4000),
    fields: (embed.fields || []).slice(0, 25).map(f => ({ ...f, name: clip(f.name, 256), value: clip(String(f.value), 1024) || '-' })),
    timestamp: new Date().toISOString(),
  };
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'cf-scraper (Cloudflare)', embeds: [safe] }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
  const res = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
  console.log(res.ok ? '[discord] sent' : `[discord] failed: ${res.status} ${await res.text()}`);
}

// แพ็กเกจฟรี: เปิดเบราว์เซอร์ใหม่ได้ 1 ตัว / 20 วินาที และใช้รวมได้ 10 นาที/วัน (รีเซ็ต 07:00 ไทย)
// -> ถ้าโควต้ารายวันใกล้หมด: ข้ามรอบนี้เลย (return null) ไม่ต้อง retry
// -> ถ้าแค่โดน rate limit ชั่วคราว: รอแล้วลองใหม่
const DAILY_LIMIT_S = 600;   // Workers Free = 10 นาที/วัน
const MIN_LEFT_S = 60;       // เหลือน้อยกว่านี้ไม่เปิด (กันเปิดแล้วโดนตัดกลางทาง)

async function launchWithRetry(binding, tries = 3) {
  for (let i = 1; ; i++) {
    // ถามโควต้าก่อน ถ้ายังเปิดใหม่ไม่ได้ ให้รอตามเวลาที่ Cloudflare บอก
    const lim = await limits(binding).catch(() => null);
    if (lim) console.log('[browser] limits', JSON.stringify(lim));
    if (lim && lim.usedBrowserTimeSeconds > DAILY_LIMIT_S - MIN_LEFT_S) {
      console.log(`[browser] daily quota used ${Math.round(lim.usedBrowserTimeSeconds)}/${DAILY_LIMIT_S}s -> skip until 07:00 (UTC midnight)`);
      return null;
    }
    if (lim && lim.allowedBrowserAcquisitions === 0 && lim.timeUntilNextAllowedBrowserAcquisition) {
      const wait = Math.min(lim.timeUntilNextAllowedBrowserAcquisition + 1000, 60000);
      console.log(`[browser] waiting ${Math.round(wait / 1000)}s for next allowed launch`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      return await launch(binding);
    } catch (err) {
      const msg = String(err?.message || err);
      const rateLimited = msg.includes('429') && !msg.toLowerCase().includes('time limit');
      if (!rateLimited || i >= tries) throw err;
      console.log(`[browser] rate limited, retry ${i}/${tries - 1} in 22s`);
      await new Promise(r => setTimeout(r, 22000));
    }
  }
}

async function run(env) {
  const url = env.TARGET_URL;
  const t0 = Date.now();
  const lap = label => console.log(`[time] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const before = await limits(env.BROWSER).catch(() => null);
  const browser = await launchWithRetry(env.BROWSER);
  if (!browser) return { ok: false, skipped: 'daily browser quota used up' };
  lap('launch');

  let page;
  try {
    page = await browser.newPage();   // อยู่ใน try → ถ้าพังก็ยังปิด browser ใน finally
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    lap('goto');
    const status = resp?.status();
    await page.waitForTimeout(3000);
    const title = (await page.title()).toLowerCase();
    if (CHALLENGE_TITLES.some(t => title.includes(t))) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 });
      await sendToDiscord(env, {
        title: '⛔ Blocked by Cloudflare (Browser Run)',
        url,
        description: 'Browser Run ถูกระบุว่าเป็นบอทเสมอ เว็บนี้เปิด challenge ไว้ จึงรันบน Cloudflare ไม่ได้',
        color: 0xe74c3c,
        fields: [{ name: 'HTTP', value: status ?? '?', inline: true }],
        image: { url: 'attachment://error.jpg' },
      }, [{ name: 'error.jpg', type: 'image/jpeg', data: shot }]);
      return { ok: false, blocked: true, status };
    }

    const data = await scrape(page);
    lap('scrape');
    data.scraped_at = new Date().toISOString();
    const shot = await page.screenshot({ type: 'jpeg', quality: 70 });
    await browser.close().catch(() => {});   // ปิดก่อนส่ง Discord -> ไม่เสียเวลา browser ตอนรอ upload
    lap('closed');
    await sendToDiscord(env, toDiscordEmbed(data), [
      { name: 'page.jpg', type: 'image/jpeg', data: shot },
      { name: 'result.json', type: 'application/json', data: JSON.stringify(data, null, 2) },
    ]);
    return { ok: true, count: data.items.length };
  } catch (err) {
    console.error('[error]', err);
    const shot = page ? await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null) : null;
    await sendToDiscord(env, {
      title: '❌ Scrape failed (Cloudflare)',
      url,
      description: '```' + String(err?.message || err).slice(0, 1500) + '```',
      color: 0xe74c3c,
      image: shot ? { url: 'attachment://error.jpg' } : undefined,
    }, shot ? [{ name: 'error.jpg', type: 'image/jpeg', data: shot }] : []);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    await browser.close().catch(() => {});   // ปิดซ้ำได้ ไม่ error
    lap('done');
    // ดูว่ารอบนี้กินโควต้าไปเท่าไหร่ (ตัวเลขอาจอัปเดตช้ากว่าจริงนิดหน่อย)
    const after = await limits(env.BROWSER).catch(() => null);
    if (before && after) {
      console.log(`[browser] quota used this run ≈ ${(after.usedBrowserTimeSeconds - before.usedBrowserTimeSeconds).toFixed(1)}s, total today ${Math.round(after.usedBrowserTimeSeconds)}/${DAILY_LIMIT_S}s`);
    }
  }
}

export default {
  // รันตาม cron ใน wrangler.jsonc
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      run(env)
        .then(r => console.log('[cron]', JSON.stringify(r)))
        .catch(err => console.error('[cron] failed:', String(err?.message || err))),
    );
  },

  // กดรันเอง: https://<worker>.workers.dev/run?token=<RUN_TOKEN>
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname !== '/run' && u.pathname !== '/status') return new Response('ok');
    if (!env.RUN_TOKEN || u.searchParams.get('token') !== env.RUN_TOKEN) {
      return new Response('unauthorized', { status: 401 });
    }
    // ดูโควต้า/เบราว์เซอร์ที่ค้างอยู่: /status?token=...
    if (u.pathname === '/status') {
      const safe = p => p.catch(e => ({ error: String(e.message || e) }));
      const [lim, active, hist] = await Promise.all([
        safe(limits(env.BROWSER)), safe(sessions(env.BROWSER)), safe(history(env.BROWSER)),
      ]);
      return Response.json({ limits: lim, active_sessions: active, recent_history: Array.isArray(hist) ? hist.slice(0, 15) : hist }, { headers: { 'content-type': 'application/json' } });
    }
    try {
      return Response.json(await run(env));
    } catch (err) {
      return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
    }
  },
};
