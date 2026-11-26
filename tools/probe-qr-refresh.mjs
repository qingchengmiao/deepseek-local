// 临时探针：验证「敲 NapCat 要新码」这条链路通不通
// 只打印 code/message/hash，不打印 token
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const SHELL = 'D:\\NapCatDSL\\Shell';
const PORT = 6209;
const QR = path.join(SHELL, 'cache', 'qrcode.png');

function post(pathname, body, cred) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const headers = { 'content-type': 'application/json', 'content-length': payload.length };
    if (cred) headers.authorization = 'Bearer ' + cred;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch { resolve({ code: -1, message: text.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + pathname)));
    req.end(payload);
  });
}

const hashOf = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch { return ''; } };

const before = hashOf(QR);
console.log('qr before:', before || '(没有文件)');

const tokenFile = path.join(SHELL, 'config', 'webui.json');
let token = '';
try { token = String(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || ''); } catch { /* 无 token */ }
console.log('webui.json exists=', fs.existsSync(tokenFile), 'tokenLen=', token.length);
if (!token) { console.log('没有 token，后面跑不了'); process.exit(1); }

const loginHash = crypto.createHash('sha256').update(token + '.napcat').digest('hex');
const login = await post('/api/auth/login', { hash: loginHash }, '');
console.log('login:', JSON.stringify({ code: login.code, message: String(login.message || '').slice(0, 120), hasCred: !!(login.data && login.data.Credential) }));
const cred = (login.data && login.data.Credential) || '';
if (!cred) { console.log('登录失败，停止'); process.exit(1); }

const r = await post('/api/QQLogin/RefreshQRcode', {}, cred);
console.log('RefreshQRcode:', JSON.stringify({ code: r.code, message: String(r.message || '').slice(0, 200), data: r.data || null }).slice(0, 400));

const t0 = Date.now();
let cur = before;
while (Date.now() - t0 < 12000) {
  await new Promise(res => setTimeout(res, 600));
  cur = hashOf(QR);
  if (cur && cur !== before) break;
}
console.log('qr after :', cur || '(没有文件)', 'changed=', !!cur && cur !== before, 'waitedMs=', Date.now() - t0);
try { const st = fs.statSync(QR); console.log('mtime=', new Date(st.mtimeMs).toISOString(), 'size=', st.size); } catch { /* 无 */ }
