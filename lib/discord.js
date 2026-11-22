// Discord webhook helper. You normally don't need to edit this file.
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

export const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// embed: { title, url, description, color, fields: [{name, value, inline}] }
// files: paths to attach (images show inline if embed.image = 'attachment://<filename>')
export async function sendToDiscord(embed, files = []) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) { console.log('[discord] DISCORD_WEBHOOK_URL not set, skipping'); return; }

  const safe = {
    ...embed,
    title: clip(embed.title, 256),
    description: clip(embed.description, 4000),
    fields: (embed.fields || []).slice(0, 25).map(f => ({ ...f, name: clip(f.name, 256), value: clip(String(f.value), 1024) || '-' })),
    timestamp: new Date().toISOString(),
  };

  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'cf-scraper', embeds: [safe] }));
  files.filter(existsSync).forEach((f, i) => form.append(`files[${i}]`, new Blob([readFileSync(f)]), basename(f)));

  const res = await fetch(webhook, { method: 'POST', body: form });
  console.log(res.ok ? '[discord] sent' : `[discord] failed: ${res.status} ${await res.text()}`);
}
