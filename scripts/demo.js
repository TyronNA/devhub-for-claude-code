#!/usr/bin/env node
// Runs Dev Hub with sample data to take README screenshots — spawns no CLI, never touches ~/.claude.
//   npm run compile && node scripts/demo.js
//   → http://127.0.0.1:7801/  the real mobile page (passcode 0000)
//   → http://127.0.0.1:7802/  the desktop chat panel: the webview's exact HTML/JS/CSS + the Dark Modern theme
// Ctrl+C to stop.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const DIST = path.resolve(__dirname, '../dist/src/devhub');
const MOBILE_PORT = 7801, DESKTOP_PORT = 7802;
const VSCODE = { ViewColumn: { Beside: 2 }, Uri: { file: (p) => p, joinPath: () => '' },
  commands: { executeCommand: async () => {} }, window: {},
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
const original = Module._load;
Module._load = function (r) { return r === 'vscode' ? VSCODE : original.apply(this, arguments); };

const now = Date.now(), min = 60000;
const workspaces = [
  { id: 'w1', name: 'Side projects', createdAt: 1, updatedAt: 1 },
  { id: 'w2', name: 'Work', createdAt: 1, updatedAt: 1 },
];
const projects = [
  { id: 'p1', workspaceId: 'w1', name: 'web-shop', rootPath: '/demo/web-shop', createdAt: 1, updatedAt: 1 },
  { id: 'p2', workspaceId: 'w1', name: 'recipe-api', rootPath: '/demo/recipe-api', createdAt: 1, updatedAt: 1 },
  { id: 'p3', workspaceId: 'w2', name: 'billing-service', rootPath: '/demo/billing-service', createdAt: 1, updatedAt: 1 },
  { id: 'p4', workspaceId: 'w2', name: 'mobile-app', rootPath: '/demo/mobile-app', createdAt: 1, updatedAt: 1 },
];
const usage = { inputTokens: 41200, outputTokens: 3800, cachedInputTokens: 38000, contextUsedTokens: 61000,
  contextWindowTokens: 200000, quota5hUsedPercentage: 34, quota5hResetsAt: now + 140 * min,
  quota7dUsedPercentage: 12, quota7dResetsAt: now + 4 * 24 * 60 * min, costUsd: 0.42, model: 'claude-opus-5-5' };
const S = (id, projectId, title, status, ago, extra) => ({ provider: 'claude', nativeSessionId: id, workspaceId:
  projects.find((p) => p.id === projectId).workspaceId, projectId, cwd: projects.find((p) => p.id === projectId).rootPath,
  title, status, createdAt: now - ago - 30 * min, updatedAt: now - ago, ...extra });
const sessions = [
  S('s1', 'p1', 'Fix the flaky checkout test', 'running', 0, { usage, model: 'opus', effort: 'high' }),
  S('s2', 'p3', 'Add idempotency keys to POST /invoices', 'done', 12 * min, { usage }),
  S('s3', 'p2', 'Paginate the search endpoint', 'done', 55 * min),
  S('s4', 'p4', 'Upgrade to React Native 0.80', 'failed', 3 * 60 * min),
  S('s5', 'p3', 'Explain the retry policy in worker.ts', 'done', 26 * 60 * min),
];

const t = (k) => now - 9 * min + k * 20000;
const transcript = [
  { type: 'user_message', text: 'The checkout test fails about 1 in 5 runs on CI. Find out why and fix it.', timestamp: t(0) },
  { type: 'assistant_message', text: "I'll reproduce it first, then look at how the cart total is awaited.", timestamp: t(1) },
  { type: 'tool_started', tool: 'Grep', label: 'Grep', summary: 'checkout.*total  in src/', callId: 'g1', timestamp: t(2) },
  { type: 'tool_completed', tool: 'Grep', label: 'Grep', summary: '3 matches', callId: 'g1', timestamp: t(2) },
  { type: 'tool_started', tool: 'Read', label: 'Read', summary: 'src/cart/checkout.ts', callId: 'r1', timestamp: t(3) },
  { type: 'tool_completed', tool: 'Read', label: 'Read', summary: 'src/cart/checkout.ts', callId: 'r1', timestamp: t(3) },
  { type: 'command_started', command: 'npm test -- checkout --repeat 20', callId: 'c1', timestamp: t(4) },
  { type: 'command_completed', command: 'npm test -- checkout --repeat 20', exitCode: 1, callId: 'c1',
    output: 'checkout › applies the coupon before tax\n  Expected: 90.00\n  Received: 100.00\n\nTests: 4 failed, 16 passed', timestamp: t(5) },
  { type: 'assistant_message', text: [
    'Found it. `applyCoupon()` is fired without `await`, so the total is sometimes read **before** the',
    'discount lands:', '',
    '```ts', '// src/cart/checkout.ts', 'cart.applyCoupon(code);        // ← not awaited', 'const total = cart.total();', '```', '',
    'Fixing it and re-running the test 50 times.'].join('\n'), timestamp: t(6) },
  { type: 'file_changed', path: 'src/cart/checkout.ts', change: 'modify', timestamp: t(7) },
  { type: 'command_started', command: 'npm test -- checkout --repeat 50', callId: 'c2', timestamp: t(8) },
  { type: 'command_completed', command: 'npm test -- checkout --repeat 50', exitCode: 0, callId: 'c2',
    output: 'Tests: 50 passed, 50 total', timestamp: t(9) },
  { type: 'assistant_message', text: [
    '| Run | Before | After |', '|---|---|---|', '| 20× checkout | 4 failed | — |', '| 50× checkout | — | **0 failed** |', '',
    'The race is gone. I\'d like to push the branch so CI confirms it.'].join('\n'), timestamp: t(10) },
  { type: 'usage', usage, timestamp: t(10) },
];
const permission = { requestId: 'demo-perm-1', toolName: 'Bash', displayName: 'Bash',
  description: 'Push the fix branch', input: { command: 'git push -u origin fix/checkout-race' } };

/* ---------- mobile: real server, fake manager ---------- */
const { MobileServer } = require(path.join(DIST, 'web/mobileServer.js'));
const em = new EventEmitter();
const manager = {
  on: (n, f) => { em.on(n, f); return () => em.off(n, f); }, isBusy: () => false,
  resume: async (s) => ({ ...s, status: 'running' }), start: async (i) => ({ ...sessions[0], title: i.prompt }),
  cancel: async () => {}, updateUsage: async (s, u) => ({ ...s, usage: { ...s.usage, ...u } }),
  withSessionLock: async (_s, f) => f(), setTurnOptions: async (s, o) => ({ ...s, ...o }),
};
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-demo-'));
const srv = new MobileServer({ manager, storageDir, passcode: () => '0000',
  providers: { claude: { id: 'claude', loadTranscript: async (s) => (s.nativeSessionId === 's1' ? transcript : []), slashCommands: () => ['compact', 'review'] } },
  lookup: async () => ({ workspaces, projects }), listSessions: async () => sessions,
  findSession: async (_p, id) => sessions.find((s) => s.nativeSessionId === id), answerPermission: () => {} });
// An approval card only reaches a client that has that session open, so keep retrying until someone is viewing.
const offer = setInterval(() => { if (srv.isAwaitingPermission('claude', 's1')) return; srv.showPermission('claude', 's1', permission); }, 1000);

/* ---------- desktop: the panel's exact html(), CSP stripped to inject the shim ---------- */
const { ChatPanelProvider } = require(path.join(DIST, 'views/chatPanelProvider.js'));
const html = new ChatPanelProvider({ on: () => () => {} }, {}, async () => ({ workspaces: [], projects: [] }),
  () => {}, () => {}, () => {}).html({});
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1];
const body = /<body>([\s\S]*)<script nonce=/.exec(html)[1];
// Dark Modern palette — the real webview receives these variables from VS Code.
const THEME = {
  'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'font-size': '13px',
  'editor-font-family': 'Menlo, Monaco, "Courier New", monospace', foreground: '#cccccc',
  'editor-background': '#1f1f1f', 'editor-foreground': '#cccccc', 'sideBar-background': '#181818',
  'panel-border': '#2b2b2b', descriptionForeground: '#9d9d9d', 'textCodeBlock-background': '#2b2b2b',
  'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c',
  'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c', 'textLink-foreground': '#4daafc',
  'gitDecoration-addedResourceForeground': '#81b88b', 'gitDecoration-deletedResourceForeground': '#c74e39',
  'editorWarning-foreground': '#cca700', 'editorError-foreground': '#f14c4c', errorForeground: '#f85149',
  'widget-shadow': 'rgba(0,0,0,.36)', 'editorHoverWidget-background': '#202020',
  'editorHoverWidget-foreground': '#cccccc', 'editorHoverWidget-border': '#454545',
  'charts-green': '#89d185', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8',
};
const vars = Object.entries(THEME).map(([k, v]) => `--vscode-${k}:${v}`).join(';');
const boot = `const post=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
post({type:'optionsChanged',model:'opus',effort:'high',slash:false});
post({type:'sessionSelected',session:${JSON.stringify(sessions[0])},events:${JSON.stringify(transcript)},
  workspace:{name:'Side projects'},project:{name:'web-shop'}});
post({type:'scm',status:{branch:'fix/checkout-race',ahead:1,behind:0,changed:1}});
post({type:'permission',request:${JSON.stringify(permission)}});`;
const desktopPage = `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}}body{background:#1f1f1f;color:#cccccc;` +
  `font-family:var(--vscode-font-family);font-size:13px;margin:0}</style><style>${css}</style></head><body>${body}` +
  `<script>window.acquireVsCodeApi=()=>({postMessage(){},setState(){},getState(){return null}});</script>` +
  `<script>${script}</script><script>${boot}</script></body></html>`;
const desktop = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(desktopPage); });

(async () => {
  await srv.start(MOBILE_PORT, false);
  await new Promise((ok) => desktop.listen(DESKTOP_PORT, '127.0.0.1', ok));
  console.log(`mobile  http://127.0.0.1:${MOBILE_PORT}/  (passcode 0000)`);
  console.log(`desktop http://127.0.0.1:${DESKTOP_PORT}/`);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
const stop = () => { clearInterval(offer); srv.dispose(); desktop.close(); fs.rmSync(storageDir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
