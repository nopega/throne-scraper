// =====================================================================
//  scrape.js (เวอร์ชัน Cloudflare Worker) — ไฟล์ที่คุณแก้
//  เหมือนเวอร์ชันในเครื่องเกือบทุกอย่าง ต่างกันแค่:
//    - URL ตั้งใน wrangler.jsonc ("vars" > TARGET_URL)
//    - ไม่มี console.table (ดู log ผ่าน `npm run logs`)
// =====================================================================

const CARD = '[data-slot="card"]';

// ส่วนที่ 2: ดึงข้อมูล — `page` เปิด URL แล้ว
export async function scrape(page) {
  // ไม่ throw ถ้าไม่เจอ → ได้ 0 ชิ้น แล้ว Discord ขึ้นเตือนสีส้ม (selector อาจพัง)
  await page.waitForSelector(CARD, { timeout: 20000 }).catch(() =>
    console.log('[scrape] ⚠️ card selector not found — เว็บอาจเปลี่ยน layout'));

  // เลื่อนลงจนจำนวนการ์ดไม่เพิ่ม 2 รอบติด (กันเน็ตช้าแล้วหยุดเร็วเกิน)
  // จำกัด 10 รอบ × 0.8 วิ เพื่อประหยัดโควต้า browser 10 นาที/วัน
  let prev = -1, stable = 0;
  for (let i = 0; i < 10 && stable < 2; i++) {
    const count = await page.locator(CARD).count();
    stable = count === prev ? stable + 1 : 0;
    prev = count;
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(800);
  }

  const raw = await page.$$eval(CARD, cards => cards.map(card => {
    const text = sel => card.querySelector(sel)?.innerText.trim() || null;
    const link = card.querySelector('a[href*="/item/"]');
    const priceText = text('[data-slot="product-card-price-row"] span');
    // รองรับ "1,234.56" และ "1.234,56" / "5,00"
    let t = (priceText || '').replace(/[^\d.,]/g, '');
    t = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    const num = t ? Number(t) : NaN;
    return {
      id: link?.getAttribute('href')?.split('/item/')[1]?.split(/[?#]/)[0] || null,
      name: text('[data-slot="product-card-info"] span.truncate'),
      description: text('[data-slot="product-card-info"] span.line-clamp-2'),
      price_text: priceText,
      price: Number.isFinite(num) ? num : null,
      currency: priceText?.match(/^[^\d\s.,]+/)?.[0] || null,
      url: link?.href || null,
      image: card.querySelector('[data-slot="product-card-image"] img')?.src || null,
    };
  }).filter(x => x.name));

  // ตัดการ์ดซ้ำ (เว็บ re-render ระหว่าง scroll)
  const items = [...new Map(raw.map(i => [i.id ?? i.url ?? i.name, i])).values()];

  console.log(`[scrape] found ${items.length} items`, JSON.stringify(items[0] ?? null));
  return { title: await page.title(), url: page.url(), items };
}

// ส่วนที่ 3: หน้าตาข้อความใน Discord
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
