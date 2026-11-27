const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
import { WorkspaceStore } from '../../src/devhub/storage/workspaceStore';

async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'devhub-store-')); }

test('workspace store creates, renames, persists workspaces and projects', async () => {
  const dir = await tempDir();
  const store = new WorkspaceStore(dir);
  const ws = await store.createWorkspace('SideProject');
  assert.equal(ws.name, 'SideProject');
  await store.renameWorkspace(ws.id, 'Games');
  const project = await store.addProject(ws.id, { name: 'game', rootPath: path.join(dir, 'game') });
  assert.equal(project.workspaceId, ws.id);

  const reloaded = new WorkspaceStore(dir);
  const snapshot = await reloaded.snapshot();
  assert.equal(snapshot.workspaces[0].name, 'Games');
  assert.equal(snapshot.projects[0].name, 'game');
});

test('workspace store deduplicates normalized project path and allows move', async () => {
  const dir = await tempDir();
  const store = new WorkspaceStore(dir);
  const a = await store.createWorkspace('A');
  const b = await store.createWorkspace('B');
  const projectPath = path.join(dir, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  await store.addProject(a.id, { name: 'repo', rootPath: projectPath });
  await assert.rejects(() => store.addProject(a.id, { name: 'repo2', rootPath: projectPath + path.sep }), /already exists/i);
  await store.moveProject(projectPath, b.id);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].workspaceId, b.id);
});

test('workspace store keeps a lightweight in-memory snapshot after first load', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-workspace-cache-'));
  const store=new WorkspaceStore(dir);
  await store.createWorkspace('Game');
  assert.equal((await store.snapshot()).workspaces.length,1);
  await fs.writeFile(path.join(dir,'devhub','workspaces.json'),JSON.stringify({version:1,workspaces:[],projects:[]}), 'utf8');
  assert.equal((await store.snapshot()).workspaces.length,1);
});

test('two concurrent adds of the same path cannot both slip through the dedupe', async () => {
  const dir = await tempDir();
  const store = new WorkspaceStore(dir);
  const ws = await store.createWorkspace('WS');
  // A project must ALREADY exist: the dedupe loop only awaits `normalizeProjectPath` when there is something to compare,
  // and that very await gap sits between the duplicate check and the push.
  await store.addProject(ws.id, {name:'seed', rootPath:dir});
  const results = await Promise.allSettled([
    store.addProject(ws.id, {name:'a', rootPath:os.tmpdir()}),
    store.addProject(ws.id, {name:'b', rootPath:os.tmpdir()}),
  ]);
  const ok = results.filter((r:any)=>r.status==='fulfilled');
  assert.equal(ok.length, 1, 'exactly one command is added, the other must be refused');
  assert.match(String((results.find((r:any)=>r.status==='rejected') as any).reason?.message), /already exists/);
  assert.equal((await store.snapshot()).projects.length, 2, 'on disk there must be only the seed + exactly one new project');
});
