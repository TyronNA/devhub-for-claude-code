#!/usr/bin/env node
// Đo CPU/heap phần việc extension host thực sự làm, trên ~/.claude thật.
//   node scripts/measure-host.js
// Cần `npm run compile` trước. Chạy ngoài VS Code để số không lẫn với extension khác:
// extension host là process CHUNG cho mọi extension, RSS của nó không quy được cho một cái.
const path = require('node:path');
const REPO = path.resolve(__dirname, '..');
const D = path.join(REPO, 'dist/src/devhub');

const { ProcessRunner } = require(path.join(D, 'providers/processRunner'));
const { ClaudeProvider } = require(path.join(D, 'providers/claude/claudeProvider'));
const { reconcileImportedSessions } = require(path.join(D, 'sessions/historyReconciler'));
const { buildTreeModel } = require(path.join(D, 'views/treeModel'));

const mb = (n) => +(n / 1048576).toFixed(1);

/**
 * `alloc` là heap tăng ngay sau khi chạy (gồm cả rác chưa dọn) — nó nói lên áp lực GC.
 * `giữ` là phần còn lại SAU khi gc, tức bộ nhớ thật sự bị giữ. Hai số này khác nhau rất
 * nhiều ở đây nên báo cáo một mình `alloc` là phóng đại.
 */
async function timed(label, fn) {
  global.gc && global.gc();
  const h0 = process.memoryUsage(), c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const c1 = process.cpuUsage(), alloc = process.memoryUsage().heapUsed - h0.heapUsed;
  global.gc && global.gc();
  const h2 = process.memoryUsage();
  console.log(`${label.padEnd(34)} wall=${ms.toFixed(0).padStart(6)}ms ` +
    `cpu=${((c1.user - c0.user + c1.system - c0.system) / 1000).toFixed(0).padStart(6)}ms ` +
    `alloc=${mb(alloc).toFixed(1).padStart(6)}MB giữ=${mb(h2.heapUsed - h0.heapUsed).toFixed(1).padStart(6)}MB ` +
    `rss=${mb(h2.rss).toFixed(0).padStart(4)}MB`);
  return out;
}

(async () => {
  // Project giả trải khắp home: `projectForCwd` khớp theo tiền tố nên mọi session đều vào.
  const projects = [{ id: 'p', workspaceId: 'w', name: 'home', rootPath: require('node:os').homedir(),
    createdAt: 1, updatedAt: 1 }];
  const runner = new ProcessRunner();
  const claude = new ClaudeProvider(runner, 'claude', 1500);

  console.log(`node ${process.version} · baseline rss=${mb(process.memoryUsage().rss)}MB\n`);

  const c1 = await timed('discoverHistory claude (lần 1)', () => claude.discoverHistory(projects));
  await timed('discoverHistory claude (cache)', () => claude.discoverHistory(projects));

  const all = c1;
  console.log(`\nquét được ${all.length} session claude\n`);

  await timed('reconcile 0 -> N', () => reconcileImportedSessions([], all));
  await timed('buildTreeModel', () =>
    buildTreeModel([{ id: 'w', name: 'w', createdAt: 1, updatedAt: 1 }], projects, all));

  // Transcript to nhất: đường nặng nhất khi mở một tab.
  const biggest = [];
  for (const [p, list] of [[claude, c1]]) {
    let worst, size = 0;
    for (const s of list.slice(0, 400)) {
      try { const f = await p.loadTranscript(s); if (f.length > size) { size = f.length; worst = s; } } catch {}
    }
    if (worst) biggest.push([p, worst, size]);
  }
  console.log();
  for (const [p, s, size] of biggest)
    await timed(`loadTranscript ${s.provider} (${size} event)`, () => p.loadTranscript(s));

  claude.dispose && claude.dispose();
  console.log(`\nrss cuối = ${mb(process.memoryUsage().rss)}MB`);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
