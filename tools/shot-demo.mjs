// 给演示沙盒拍几张图（对话页 / 导入页 / 设置-上下文）
import { writeFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8899';
const { cdp, ev, waitFor, close } = await launch({ width: 1360, height: 900, port: 9361 });
const shot = async (name) => {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`data/shots/${name}`, Buffer.from(s.data, 'base64'));
  console.log('shot', name);
};

try {
  await cdp('Page.navigate', { url: BASE });
  await waitFor("document.documentElement.dataset.ready === '1'", 20000);
  await sleep(600);

  // 1) 打开「演示 · 一次问十件事」
  await ev(`(() => {
    const items = [...document.querySelectorAll('.conv-item')];
    const hit = items.find(el => el.textContent.includes('一次问十件事'));
    if (hit) hit.click();
    return !!hit;
  })()`);
  await sleep(900);
  await shot('82-演示-对话页.png');

  // 2) 导入页
  await ev(`document.querySelector('#importNavBtn').click()`);
  await sleep(700);
  await shot('83-演示-导入页.png');

  // 3) 设置页：上下文与记忆 + 自动拉模型
  await ev(`document.querySelector('#settingsBtn').click()`);
  await sleep(800);
  const found = await ev(`(() => {
    const rows = [...document.querySelectorAll('.row, .field, .switch-row, label')];
    const hit = rows.find(el => el.textContent.includes('缺模型时自动拉'));
    if (hit) hit.scrollIntoView({ block: 'center' });
    return !!hit;
  })()`);
  await sleep(500);
  const pull = await ev(`(async () => (await (await fetch('/api/context/model-pull')).json()))()`);
  console.log('model-pull:', JSON.stringify({ mirrors: pull.mirrors, ok: pull.ok, running: pull.running }));
  await shot('84-演示-摘要模型自动拉取.png');
  console.log('found switch:', found);
} finally {
  await close();
}
