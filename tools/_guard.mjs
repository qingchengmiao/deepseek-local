// 测试脚本的「别动真实配置」守卫。
//
// 背景：2026-11-22 这些脚本默认打 http://127.0.0.1:8787（用户正在用的实例），
// 会临时 PUT { apiKey: 'sk-mock-…', baseUrl: mock } 进去。还原时又从 GET /api/settings
// 里拿 apiKey —— 但服务端返回的是掩码（sk-mo…-k），于是「还原」把真 Key 覆盖没了。
// 现在统一在这里拦：目标实例已存真实 Key 时，除非 ALLOW_LIVE_KEY=1，直接拒绝执行。

export async function liveGuard(base, name = 'test') {
  if (process.env.ALLOW_LIVE_KEY === '1') return;
  let hasKey = false;
  let masked = '';
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/api/settings');
    const body = await r.json();
    const s = body.data || body || {};
    hasKey = !!(s.hasKey || s.apiKeyMasked);
    masked = s.apiKeyMasked || (typeof s.apiKey === 'string' ? s.apiKey : '');
  } catch {
    return; // 服务没起或不是本应用，交给脚本自己报错
  }
  if (!hasKey) return;
  console.error(
    `\n[${name}] 拒绝在「已存真实 API Key」的实例上跑（${base}${masked ? '，当前 ' + masked : ''}）。\n` +
    `这类脚本会临时把 apiKey/baseUrl 换成 mock 值，还原时拿不回真 Key。\n` +
    `请起一个隔离实例再跑：\n` +
    `  $env:PORT="8790"; $env:DSAPP_DATA="data\\_ttest"; node server.mjs\n` +
    `  $env:BASE="http://127.0.0.1:8790"; node tools\\<脚本>.mjs\n` +
    `确认要在真实实例上跑（脚本已改成不再覆盖 apiKey），再设 ALLOW_LIVE_KEY=1。\n`
  );
  process.exit(2);
}

// 需要临时改成 mock 上游时调用：只写 baseUrl 等非敏感字段，apiKey 仅在原本为空时补一个假值。
export async function patchUpstream(base, { apiKey = 'sk-mock', ...rest } = {}) {
  const st = await (await fetch(base.replace(/\/$/, '') + '/api/settings')).json();
  const s = st.data || st || {};
  const patch = { ...rest };
  if (!(s.hasKey || s.apiKeyMasked)) patch.apiKey = apiKey; // 没有真 Key 才补假值
  const r = await fetch(base.replace(/\/$/, '') + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return await r.json();
}
