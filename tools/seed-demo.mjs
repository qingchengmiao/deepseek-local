// 给「演示沙盒」灌几组示例会话。用 app 自己的导入接口，不直接写 JSON（schema 才不会对不上）。
// 用法：node tools/seed-demo.mjs [BASE]   默认 http://127.0.0.1:8899
const BASE = process.argv[2] || 'http://127.0.0.1:8899';

// 演示沙盒不要自动把工作区里的导出文件导进来（那是真数据，不该出现在演示里）
const putInit = await fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ autoImport: false, adaptiveTurn: true }),
});
if (!putInit.ok) console.warn('（设置 autoImport=false 没成功，继续）');

// 清掉这份演示数据里已经自动导进来的真实会话（source 是文件路径的那些）
const stateNow = await (await fetch(`${BASE}/api/state`)).json();
for (const c of stateNow.conversations || []) {
  const src = String(c.source || '');
  if (c.source === '演示数据') {
    // 重复跑时先把上次灌的演示会话清掉，保证幂等
    await fetch(`${BASE}/api/conversations/${c.id}`, { method: 'DELETE' });
    continue;
  }
  if (/[\\/]/.test(src) || src.startsWith('导入')) {
    await fetch(`${BASE}/api/conversations/${c.id}`, { method: 'DELETE' });
    console.log(`（清掉自动导入的真实会话：${c.title}）`);
  }
}


const long = (text, times) => Array.from({ length: times }, (_, i) => `${text}（第 ${i + 1} 段）`).join('\n\n');

const conversations = [
  {
    title: '演示 · 一次问十件事',
    source: '演示数据',
    messages: [
      { role: 'user', content: '帮我把这十件事一次说清楚：1) 今天几号 2) 一公里等于多少米 3) 把「我饿了」翻译成日语 4) 写一行 Python 读取 CSV 5) 简述光合作用 6) 3 的 5 次方 7) 给这个产品起三个名字 8) 什么是索引失效 9) 提醒我晚上九点收衣服 10) 用一句话总结我们这轮对话' },
      { role: 'assistant', content: '1️⃣ 今天是 2026-11-22（周日）。\n2️⃣ 1 公里 = 1000 米。\n3️⃣ 日语：「お腹が空きました」。\n4️⃣ `import csv; rows = list(csv.DictReader(open("x.csv", encoding="utf-8")))`\n5️⃣ 光合作用是叶绿体把光能转成化学能：CO₂ + H₂O → 有机物 + O₂。\n6️⃣ 3⁵ = 243。\n7️⃣ 名字：摆渡、回声簿、本地眼。\n8️⃣ 索引失效＝查询写法让优化器用不上索引，退化成全表扫描。\n9️⃣ 晚上 21:00 已记下。\n🔟 你在用一个跑在自己机器上的客户端，把一堆杂事一次性问完。' },
      { role: 'user', content: '第 4 条再给一个不用 pandas 但能处理表头的写法' },
      { role: 'assistant', content: '```python\nimport csv\nwith open("x.csv", newline="", encoding="utf-8") as f:\n    reader = csv.DictReader(f)\n    for row in reader:\n        print(row["name"], row["age"])\n```\n`DictReader` 直接拿表头当 key，不需要 pandas。' },
    ],
  },
  {
    title: '演示 · 长对话如何不丢上下文',
    source: '演示数据',
    messages: [
      { role: 'user', content: '我们要在这个会话里反复聊同一批事：数据库迁移、备份、schema、导出脚本时区 bug、下周一的评审。请记住，后面我会抽查。' },
      { role: 'assistant', content: '记下了，四个要点：\n1. 数据库迁移顺序：先备份 → 再改 schema → 最后核对导出脚本。\n2. 备份放 `backup/2026-11-22/`，迁移前必须跑完并核对大小。\n3. 导出脚本的时区 bug：`new Date()` 被当成本地时间，改成统一按 UTC 存取。\n4. 评审在下周一上午，需要一份「改了什么、为什么、怎么回滚」的清单。' },
      { role: 'user', content: long('继续补充背景：这次迁移是因为旧表把时间戳存成字符串，跨时区会错位，所以顺手把导出脚本也一起改。', 6) },
      { role: 'assistant', content: '背景收下。结论没变：备份先行、schema 改动最小化、导出脚本按 UTC 统一、评审带清单。' },
      { role: 'user', content: long('再把这段重复的上下文补一遍，用来演示长对话会被压缩而不是被丢掉。', 10) },
      { role: 'assistant', content: '这段我按「历史片段」处理：原文会归档到 `data/archive/`，需要时还能翻出来；对话里保留的是摘要和关键词。' },
    ],
  },
  {
    title: '演示 · 拿来就能用的几件小事',
    source: '演示数据',
    messages: [
      { role: 'user', content: '帮我起一个批量重命名的脚本，把「IMG_001.jpg」改成「2026-11-22-001.jpg」这种' },
      { role: 'assistant', content: '```powershell\n$i = 1\nGet-ChildItem IMG_*.jpg | Sort-Object Name | ForEach-Object {\n  $new = "2026-11-22-{0:d3}.jpg" -f $i\n  Rename-Item $_.FullName $new\n  $i++\n}\n```\n先 `-WhatIf` 跑一遍确认再执行。' },
      { role: 'user', content: '再解释一下注意力机制，用一句话' },
      { role: 'assistant', content: '注意力＝让每个位置按相关度去「看」其他位置，而不是一视同仁地平均。' },
    ],
  },
];

const res = await fetch(`${BASE}/api/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: 'demo-bundle.json', conversations }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok || data.error) {
  console.error('灌演示数据失败：', res.status, data.error || '');
  process.exit(1);
}
const n = Array.isArray(data.imported) ? data.imported.length : conversations.length;
console.log(`演示数据已灌入：${n} 个会话`);
