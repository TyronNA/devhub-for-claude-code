#!/usr/bin/env node
// Đo layout/style/heap của script webview trong Chrome thật qua CDP (không cần playwright).
//   node scripts/measure-webview.js [HEAD] [<rev>...]
// LayoutCount là số cần đọc: đọc scrollHeight ngay sau khi sửa DOM ép browser tính lại
// layout, nên "N event -> N layout" chính là thrash.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** css/script mà html() nhúng, cho một revision bất kỳ ('WORKTREE' = cây làm việc). */
function assets(rev) {
  const src = rev === 'WORKTREE'
    ? fs.readFileSync(path.join(REPO, 'src/devhub/views/chatPanelProvider.ts'), 'utf8')
    : cp.execFileSync('git', ['show', `${rev}:src/devhub/views/chatPanelProvider.ts`],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
  const ts = require(path.join(REPO, 'node_modules/typescript'));
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Phải nằm cạnh các module đã build, nếu không import tương đối không resolve được.
  const file = path.join(REPO, 'dist/src/devhub/views', `__measure-${rev.replace(/[^a-z0-9]/gi, '')}.js`);
  fs.writeFileSync(file, js);
  const Module = require('node:module');
  const mock = { ViewColumn: { Beside: 2 }, Uri: { file: (p) => p, joinPath: () => '' },
    commands: { executeCommand: async () => {} }, window: {},
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
  const original = Module._load;
  Module._load = function (r) { return r === 'vscode' ? mock : original.apply(this, arguments); };
  let html;
  try {
    delete require.cache[file];
    const { ChatPanelProvider } = require(file);
    html = new ChatPanelProvider({ on: () => () => {} }, {}, async () => ({ workspaces: [], projects: [] }),
      () => {}, () => {}, () => {}).html({});
  } finally { Module._load = original; fs.rmSync(file, { force: true }); }
  return {
    css: /<style>([\s\S]*?)<\/style>/.exec(html)[1],
    script: /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1],
    body: /<body>([\s\S]*)<script nonce=/.exec(html)[1],
  };
}

async function launch(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-chrome-'));
  const child = cp.spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { child, dir }; } catch {}
    await sleep(125);
  }
  child.kill('SIGKILL');
  throw new Error(`Chrome không mở được CDP (CHROME_PATH=${CHROME})`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  return new CDP(ws);
}

/** Trang thật: body + css + script y như webview, cộng shim acquireVsCodeApi. */
const pageHtml = (a) => `<!doctype html><html><head><meta charset="utf-8"><style>${a.css}</style></head>` +
  `<body>${a.body}<script>window.__posted=[];` +
  `window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m),setState(){},getState(){return null}});</script>` +
  `<script>${a.script}</script></body></html>`;
const metricsOf = (r) => Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));

async function probe(cdp, a, label, expression) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(pageHtml(a)).toString('base64') });
  await sleep(600);
  await cdp.send('Performance.enable');
  const before = metricsOf(await cdp.send('Performance.getMetrics'));
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`${label}: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
  const inner = JSON.parse(res.result.value);
  await sleep(400);
  const after = metricsOf(await cdp.send('Performance.getMetrics'));
  const d = (k) => (after[k] || 0) - (before[k] || 0);
  return { label, nodes: inner.nodes, renderMs: +inner.ms.toFixed(1),
    LayoutCount: d('LayoutCount'), RecalcStyleCount: d('RecalcStyleCount'),
    LayoutMs: +(d('LayoutDuration') * 1000).toFixed(1),
    ScriptMs: +(d('ScriptDuration') * 1000).toFixed(1),
    HeapMB: +((after.JSHeapUsedSize || 0) / 1048576).toFixed(2) };
}

const SESSION = `{provider:'claude',nativeSessionId:'a',status:'done',usage:{contextUsedTokens:100,contextWindowTokens:1000}}`;
/** Mở transcript: một lần sessionSelected dựng hết. */
const openExpr = (n) => `(()=>{
  const evs=Array.from({length:${n}},(_,i)=>({type:i%4===0?'user_message':'assistant_message',
    text:'dòng '+i+' — '+'x'.repeat(80)}));
  const t0=performance.now();
  window.dispatchEvent(new MessageEvent('message',{data:{type:'sessionSelected',session:${SESSION},
    events:evs,workspace:{name:'W'},project:{name:'P'}}}));
  return JSON.stringify({ms:performance.now()-t0,nodes:document.getElementById('messages').children.length});
})()`;
/** Streaming: mỗi event một message, giống lúc agent đang trả lời. */
const streamExpr = (n) => `(()=>{
  window.dispatchEvent(new MessageEvent('message',{data:{type:'sessionSelected',
    session:{provider:'claude',nativeSessionId:'a',status:'running',usage:{}},events:[],
    workspace:{name:'W'},project:{name:'P'}}}));
  const t0=performance.now();
  for(let i=0;i<${n};i++)window.dispatchEvent(new MessageEvent('message',{data:{type:'event',sessionId:'a',
    event:{type:'assistant_message',text:'dòng '+i+' — '+'x'.repeat(80)}}}));
  return JSON.stringify({ms:performance.now()-t0,nodes:document.getElementById('messages').children.length});
})()`;

(async () => {
  const revs = (process.argv.slice(2).length ? process.argv.slice(2) : ['HEAD'])
    .map((r) => (r === 'HEAD' ? 'WORKTREE' : r));
  const port = 9333 + Math.floor(Math.random() * 200);
  const { child, dir } = await launch(port);
  try {
    const cdp = await connect(port);
    const rows = [];
    for (const n of [300, 1500])
      for (const rev of revs) rows.push(await probe(cdp, assets(rev), `${rev} · open ${n}`, openExpr(n)));
    for (const rev of revs) rows.push(await probe(cdp, assets(rev), `${rev} · stream 1000`, streamExpr(1000)));
    const cols = [['label', 26], ['nodes', 7], ['renderMs', 10], ['LayoutCount', 13],
      ['RecalcStyleCount', 18], ['LayoutMs', 10], ['ScriptMs', 10], ['HeapMB', 8]];
    console.log(cols.map(([k, w]) => k.padEnd(w)).join(''));
    for (const r of rows) console.log(cols.map(([k, w]) => String(r[k]).padEnd(w)).join(''));
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
