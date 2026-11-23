// gh-trigger: ใช้ cron ของ Cloudflare (ตรงเวลา) กดปุ่ม "Run workflow" บน GitHub ให้
// ไม่เปิด browser → ไม่กินโควต้า Browser Run 10 นาที/วัน, ใช้ CPU ไม่กี่ ms
//
// ค่าที่ต้องตั้ง:
//   vars (wrangler.jsonc): GH_REPO, GH_WORKFLOW, GH_REF
//   secret:                npx wrangler secret put GITHUB_TOKEN
//   (ไม่บังคับ) secret:    npx wrangler secret put RUN_TOKEN   → กดยิงเองที่ /run?token=...

async function dispatch(env) {
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'throne-gh-trigger',          // GitHub API บังคับต้องมี
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GH_REF || 'main' }),
  });
  // สำเร็จ = 204 No Content
  const body = res.status === 204 ? '' : (await res.text()).slice(0, 300);
  const result = { ok: res.status === 204, status: res.status, body };
  console.log('[dispatch]', JSON.stringify(result));
  return result;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) { console.log('[dispatch] GITHUB_TOKEN not set'); return; }
    ctx.waitUntil(dispatch(env));
  },

  // ยิงเองเพื่อเทส: https://<worker>.workers.dev/run?token=<RUN_TOKEN>
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname !== '/run') return new Response('ok');
    if (!env.RUN_TOKEN || u.searchParams.get('token') !== env.RUN_TOKEN) {
      return new Response('unauthorized', { status: 401 });
    }
    return Response.json(await dispatch(env));
  },
};
