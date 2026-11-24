// 一次性清理：把 QQ 会话里旧版「按语义分段…最多八段」这条注入从历史消息里剥掉。
// 那条是我以前塞进用户消息里的说话口径，不是对方说的，留着会让模型继续学着拆句。
// 用法：node tools/_clean-legacy-qq-suffix.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DSAPP_DATA || path.join('dist', 'DeepSeek-win32-x64', 'data');
const dir = path.join(DATA, 'conversations');
const apply = process.argv.includes('--apply');
const LEGACY = /【这条回在手机上】按语义分段[^\n]*/g;

let files = 0, msgs = 0;
const backup = path.join(DATA, 'backups', 'conv-legacy-' + new Date().toISOString().replace(/[:.]/g, '-'));
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  const p = path.join(dir, name);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
  if (!raw.includes('按语义分段')) continue;
  files++;
  const conv = JSON.parse(raw);
  let touched = 0;
  for (const m of conv.messages || []) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (!m.content.includes('按语义分段')) continue;
    const next = m.content.replace(LEGACY, '').replace(/\s+$/, '');
    if (next !== m.content) { m.content = next; touched++; }
  }
  msgs += touched;
  console.log(`${name}: ${touched} 条清理${apply ? '（已写盘）' : '（演练）'}`);
  if (apply && touched) {
    fs.mkdirSync(backup, { recursive: true });
    fs.copyFileSync(p, path.join(backup, name));
    fs.writeFileSync(p, JSON.stringify(conv, null, 2));
  }
}
console.log(`\n共 ${files} 个会话、${msgs} 条消息${apply ? '' : '（未写盘，加 --apply 才改）'}`);
if (apply && msgs) console.log('备份在 ' + backup);
