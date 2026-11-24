// 对话页拖入 = 加附件；zip = 转去导入页（与导入隔离）；导入页拖入 = 整理成对话
import { launch, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || process.env.BASE || 'http://127.0.0.1:8799').replace(/\/+$/, '');
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const convCount = async () => (await (await fetch(BASE + '/api/state')).json()).conversations.length;

console.log(`目标: ${BASE}`);
const before = await convCount();
// 附件接口要求已填 Key；无 Key 的隔离实例自己塞一个假 Key（有真 Key 的实例绝不动）
{
  const st = await (await fetch(BASE + '/api/state')).json();
  if (!st.settings?.apiKey) {
    await fetch(BASE + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-local-test-key' }),
    });
    console.log('（实例没 Key，测试临时塞了一个假 Key）');
  }
}

const { cdp, ev, waitFor, close } = await launch({ width: 1360, height: 900, port: 9353 });
try {
  await cdp('Page.navigate', { url: `${BASE}/` });
  await waitFor("document.documentElement.dataset.ready === '1'", 15000);

  // 1) 对话页：拖入一个 txt → 加附件，不导入
  console.log('\n1) 对话页拖入文本 = 加附件');
  const hover = await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['拖进来的文本内容'], 'drop-note.txt', { type: 'text/plain' }));
    window.__dt = dt;
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const z = document.querySelector('#dropZone');
    return { shown: z && !z.classList.contains('hidden'), title: document.querySelector('#dropTitle')?.textContent || '', mode: z?.dataset.mode || '' };
  })()`);
  check('拖拽层浮出', hover.shown === true);
  check('文案是「加进这条消息」', /加进这条消息/.test(hover.title), hover.title);
  check('拖拽层标记为 attach 模式', hover.mode === 'attach', hover.mode);
  await sleep(420);
  {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync('data/shots/94-对话页-拖入浮层.png', Buffer.from(shot.data, 'base64'));
  }

  // 拖入后附件条是「立刻」出来的：先在本地挂一个 uploading 的 chip，再去 /api/upload。
  // 隔离实例塞的是假 Key，上传会被拒、代码故意把 chip 撤掉（见 addAttachment 的 catch），
  // 所以断言必须和派发在同一个 evaluate 里读——等 1.6s 再读就只剩「已撤掉」了。
  const dropped = await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['拖进来的文本内容'], 'drop-note.txt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const bar = document.querySelector('#attachBar');
    return {
      barHidden: bar?.classList.contains('hidden'),
      text: bar?.textContent || '',
      chat: !document.querySelector('#chatView')?.classList.contains('hidden'),
      dz: document.querySelector('#dropZone')?.classList.contains('hidden'),
    };
  })()`);
  check('附件条出现且带文件名', dropped.barHidden === false && /drop-note\.txt/.test(dropped.text), dropped.text.trim().replace(/\s+/g, ' ').slice(0, 30));
  check('还在对话页（没被导去导入页）', dropped.chat === true);
  check('拖拽层收起', dropped.dz === true);
  await sleep(600);
  check('会话数没变（没落库）', (await convCount()) === before, `${before} → ${await convCount()}`);

  // 2) 对话页拖入 zip → 转去导入页，且只有它进列表
  console.log('\n2) 对话页拖入 zip = 转去导入页');
  const zipDrop = await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['PK\\u0003\\u0004fake'], 'export.zip', { type: 'application/zip' }));
    window.__dt2 = dt;
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return 1;
  })()`);
  await sleep(1800);
  const imp = await ev(`(() => ({
    title: document.querySelector('#pageTitle')?.textContent || '',
    items: document.querySelectorAll('#impList .imp-item').length,
    names: [...document.querySelectorAll('#impList .imp-name')].map(n => n.textContent.trim()).join('|'),
    title2: document.querySelector('#dropTitle')?.textContent || '',
  }))()`);
  check('跳到了「导入对话」页', imp.title === '导入对话', imp.title);
  check('zip 进了导入列表', imp.items === 1 && /export\.zip/.test(imp.names), imp.names);
  check('会话数仍然没变', (await convCount()) === before, `${before} → ${await convCount()}`);

  // 3) 导入页的拖拽文案是「整理成对话」
  const impHover = await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'b.json', { type: 'application/json' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const z = document.querySelector('#dropZone');
    return { shown: z && !z.classList.contains('hidden'), title: document.querySelector('#dropTitle')?.textContent || '', mode: z?.dataset.mode || '' };
  })()`);
  check('导入页拖拽文案是「整理成对话」', impHover.shown === true && impHover.mode === 'import' && /整理成对话/.test(impHover.title), impHover.title);

  await sleep(420);
  {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync('data/shots/95-导入页-拖入浮层.png', Buffer.from(shot.data, 'base64'));
  }
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
} finally {
  await close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
