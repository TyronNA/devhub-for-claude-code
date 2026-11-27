const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
import { SessionStore } from '../../src/devhub/storage/sessionStore';

test('session store upserts by provider plus native id and preserves managed state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-sessions-'));
  const store = new SessionStore(dir);
  await store.upsert({ provider:'claude', nativeSessionId:'abc', workspaceId:'w', projectId:'p', cwd:'/tmp/p', title:'first', status:'imported', createdAt:1, updatedAt:1 });
  await store.upsert({ provider:'claude', nativeSessionId:'abc', workspaceId:'w', projectId:'p', cwd:'/tmp/p', title:'managed', status:'done', createdAt:1, updatedAt:2 });
  const sessions = await store.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'managed');
  assert.equal(sessions[0].status, 'done');
});

test('session store bulk upsert imports 1000 sessions in one operation and deduplicates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-sessions-bulk-'));
  const store = new SessionStore(dir);
  const sessions = Array.from({length:1000}, (_,i) => ({
    provider: 'claude',
    nativeSessionId: `s-${i}`,
    workspaceId: `w-${i%3}`,
    projectId: `p-${i%30}`,
    cwd: `/tmp/p-${i%30}`,
    title: `Session ${i}`,
    status: 'imported',
    createdAt: i,
    updatedAt: i,
  } as any));
  await store.upsertMany(sessions);
  await store.upsertMany([{...sessions[42], title:'updated', updatedAt:2000}]);
  const actual = await store.list();
  assert.equal(actual.length, 1000);
  assert.equal(actual.find(s=>s.nativeSessionId==='s-42')?.title, 'updated');
});

test('session store caches metadata after first load instead of rereading disk on every list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-sessions-cache-'));
  const store = new SessionStore(dir);
  await store.upsert({ provider:'claude', nativeSessionId:'abc', workspaceId:'w', projectId:'p', cwd:'/tmp/p', title:'cached', status:'done', createdAt:1, updatedAt:1 } as any);
  assert.equal((await store.list())[0].title, 'cached');
  const file = path.join(dir, 'devhub', 'sessions.json');
  await fs.writeFile(file, JSON.stringify({version:1,sessions:[]}), 'utf8');
  assert.equal((await store.list()).length, 1);
});

test('legacy codex rows are dropped on load and gone from the file after the next write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-sessions-legacy-'));
  const file = path.join(dir, 'devhub', 'sessions.json');
  const row = (provider:string, id:string) => ({provider, nativeSessionId:id, workspaceId:'w', projectId:'p', cwd:'/tmp', title:id, status:'done', createdAt:1, updatedAt:1});
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, JSON.stringify({version:1, sessions:[row('claude','a'), row('codex','b')]}));
  const store = new SessionStore(dir);
  assert.deepEqual((await store.list()).map((s:any)=>s.provider), ['claude'], 'Codex đã gỡ: hàng cũ không được hiện thành hàng chết');
  await store.upsert(row('claude','c') as any);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8')).sessions.map((s:any)=>s.provider);
  assert.equal(onDisk.includes('codex'), false);
});

test('a hand-set name survives a turn writing back the session it captured before the rename', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-sessions-rename-'));
  const store = new SessionStore(dir);
  const captured = { provider:'claude', nativeSessionId:'abc', workspaceId:'w', projectId:'p', cwd:'/tmp/p', title:'first prompt', status:'running', createdAt:1, updatedAt:1 } as any;
  await store.upsert(captured);
  await store.rename('claude', 'abc', '  Queue   bug ');
  // Lượt đang chạy ghi lại bản chụp cũ (không có name / name cũ) khi kết thúc.
  await store.upsert({ ...captured, status:'done', updatedAt:2 });
  await store.upsert({ ...captured, name:'stale', status:'done', updatedAt:3 });
  let s = (await new SessionStore(dir).list())[0];
  assert.equal(s.name, 'Queue bug');
  assert.equal(s.title, 'first prompt', 'title gốc không bị đụng');
  assert.equal(s.status, 'done');
  await store.rename('claude', 'abc', '   ');
  s = (await new SessionStore(dir).list())[0];
  assert.equal(s.name, undefined, 'tên rỗng = quay về prompt đầu');
});
