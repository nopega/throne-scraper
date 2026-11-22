// =====================================================================
//  scrape.js — ไฟล์เดียวที่คุณต้องแก้
//  ลำดับการทำงาน (index.js จัดการให้):
//    1. เปิดเบราว์เซอร์ headless
//    2. เปิด TARGET_URL (ส่วนที่ 1) แล้วรอให้ผ่าน Cloudflare
//    3. เรียก scrape(page) (ส่วนที่ 2) → ได้ data
//    4. บันทึก data ลง result.json + แคปจอ page.jpg
//    5. เอา data ไปทำเป็นข้อความผ่าน toDiscordEmbed(data) (ส่วนที่ 3) แล้วส่ง Discord
// =====================================================================

import { gotoWithCloudflare } from './lib/browser.js';


// ---------------------------------------------------------------------
//  ส่วนที่ 1: URL ที่จะเปิด
// ---------------------------------------------------------------------
//  ใส่ URL ตรงนี้ได้เลย หรือจะใส่ TARGET_URL ใน .env ก็ได้ (ถ้ามีใน .env จะใช้ใน .env ก่อน)
//  ลำดับที่ใช้จริง: URL ที่พิมพ์ตอนรัน (npm start -- https://...) > .env > ค่าตรงนี้
export const TARGET_URL = process.env.TARGET_URL || 'https://throne.com/mizucakes';


// ---------------------------------------------------------------------
//  ส่วนที่ 2: ดึงข้อมูล (เขียน Playwright ของคุณตรงนี้)
// ---------------------------------------------------------------------
//  - ตอนที่ฟังก์ชันนี้ถูกเรียก `page` เปิด TARGET_URL และผ่าน Cloudflare แล้ว
//  - return อะไรออกไป → จะถูกบันทึกลง result.json และส่งต่อให้ส่วนที่ 3
//
//  คำสั่งที่ใช้บ่อย:
//    await page.locator('css').allInnerTexts()            // ดึงข้อความทุกตัวที่ตรง selector
//    await page.$$eval('css', els => els.map(e => ...))   // ดึงหลาย field ต่อ element
//    await page.waitForSelector('css')                    // รอ element โหลด
//    await gotoWithCloudflare(page, 'https://...')        // ไปหน้าอื่น (ใช้แทน page.goto จะรอ CF ให้)

// selector ของการ์ดสินค้า 1 ใบ (Throne ใช้ data-slot ซึ่งเปลี่ยนน้อยกว่า class ของ Tailwind)
const CARD = '[data-slot="card"]';

export async function scrape(page) {

  // ===== TODO: แก้ตรงนี้ =====
  // 1) รอให้การ์ดโผล่
  //    ไม่ throw — ถ้าไม่เจอจะได้ 0 ชิ้น แล้ว Discord ขึ้นเตือนให้ไปแก้ selector
  await page.waitForSelector(CARD, { timeout: 20000 }).catch(() =>
    console.log('[scrape] ⚠️ card selector not found — selector อาจพัง เว็บเปลี่ยน layout'));

  // 2) เลื่อนลงเรื่อยๆ จนจำนวนการ์ดไม่เพิ่ม 2 รอบติด (กันเน็ตช้าแล้วหยุดเร็วเกิน)
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 30 && stable < 2; i++) {
    const count = await page.locator(CARD).count();
    stable = count === prev ? stable + 1 : 0;
    prev = count;
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1200);
  }

  // 3) ดึงข้อมูลจากการ์ดแต่ละใบ → ได้เป็น array ของ object
  const raw = await page.$$eval(CARD, cards => cards.map(card => {
    const text = sel => card.querySelector(sel)?.innerText.trim() || null;
    const link = card.querySelector('a[href*="/item/"]');
    const priceText = text('[data-slot="product-card-price-row"] span');
    let t = (priceText || '').replace(/[^\d.,]/g, '');
    t = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    const num = t ? Number(t) : NaN;
    return {
      id: link?.getAttribute('href')?.split('/item/')[1]?.split(/[?#]/)[0] || null,
      name: text('[data-slot="product-card-info"] span.truncate'),
      description: text('[data-slot="product-card-info"] span.line-clamp-2'),
      price_text: priceText,                                                   // "$10.96"
      price: Number.isFinite(num) ? num : null,                                // 10.96
      currency: priceText?.match(/^[^\d\s.,]+/)?.[0] || null,                  // "$"
      url: link?.href || null,
      image: card.querySelector('[data-slot="product-card-image"] img')?.src || null,
    };
  }).filter(x => x.name));

  // ตัดการ์ดซ้ำ (เว็บ re-render ระหว่าง scroll) — ใช้ id ก่อน ถ้าไม่มีใช้ url/name
  const items = [...new Map(raw.map(i => [i.id ?? i.url ?? i.name, i])).values()];

  // 4) print ให้ดูหน้าตา
  console.log(`\n[scrape] found ${items.length} items`);
  console.log('[scrape] first item (full object):');
  console.dir(items[0], { depth: null });
  console.table(items.map(({ name, price_text, id }) => ({ name, price: price_text, id })));
  // ===== จบส่วนแก้ =====

  return {
    title: await page.title(),
    url: page.url(),
    items,              // ข้อมูลหลัก ส่วนที่ 3 ใช้ตัวนี้
  };
}


// ---------------------------------------------------------------------
//  ส่วนที่ 3: หน้าตาข้อความใน Discord
// ---------------------------------------------------------------------
//  รับ data (ที่ return จากส่วนที่ 2) แล้วแปลงเป็น embed
//  ข้อจำกัด Discord: title ≤ 256 ตัวอักษร, value ของแต่ละ field ≤ 1024, ไม่เกิน 25 fields
//  (lib/discord.js ตัดความยาวให้อัตโนมัติ)
export function toDiscordEmbed(data) {
  // ตัดข้อความให้สั้น (Discord จำกัดความยาว embed รวมไม่เกิน 6000 ตัวอักษร)
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const MAX_ITEMS = 15;          // จำนวนสินค้าสูงสุดที่โชว์ใน Discord (ทั้งหมดอยู่ใน result.json)
  const MAX_NAME = 100;          // ความยาวหัว field (ชื่อ — ราคา)
  const MAX_DESC = 150;          // ความยาว description ต่อชิ้น
  const BUDGET = 5500;           // เผื่อจากลิมิตรวม 6000 ของ Discord

  // ยอดรวม: รวมแยกตามสกุลเงิน กันกรณี $ ปน € แล้วบวกกันผิด
  const totals = {};
  for (const i of data.items) {
    if (i.price == null) continue;
    const c = i.currency || '?';
    totals[c] = (totals[c] || 0) + i.price;
  }
  const totalText = Object.entries(totals)
    .map(([c, v]) => `${c}${v.toFixed(2)}`).join(' + ') || '-';

  const title = cut(`✅ ${data.title || 'Scraped'}`, 256);
  const footerFields = [{ name: 'Total', value: totalText, inline: true }];
  let used = title.length + 140 /* description */ +
    footerFields.reduce((s, f) => s + f.name.length + f.value.length, 0);

  // 1 สินค้า = 1 field — เพิ่มทีละชิ้นจนกว่าจะชนงบความยาวรวม
  const itemFields = [];
  for (const i of data.items.slice(0, MAX_ITEMS)) {
    const f = {
      name: cut(`${i.name} — ${i.price_text ?? '-'}`, MAX_NAME),
      value: (cut(i.description, MAX_DESC) || '_ไม่มีคำอธิบาย_') +
        (i.url ? `\n[ดูสินค้า](${i.url})` : ''),
    };
    const size = f.name.length + f.value.length;
    if (used + size > BUDGET) break;
    used += size;
    itemFields.push(f);
  }

  const shown = itemFields.length;
  return {
    title,
    url: data.url,
    description: `Found **${data.items.length}** items` +
      (data.items.length === 0 ? '\n⚠️ ไม่เจอสินค้าเลย — selector อาจพัง (เว็บเปลี่ยน layout?) ดูจาก page.jpg' : '') +
      (data.items.length > shown ? ` (แสดง ${shown} รายการแรก)` : ''),
    color: data.items.length ? 0x2ecc71 : 0xe67e22,   // เขียว = ปกติ, ส้ม = 0 ชิ้น
    fields: [...itemFields, ...footerFields],
    image: { url: 'attachment://page.jpg' },
  };
}