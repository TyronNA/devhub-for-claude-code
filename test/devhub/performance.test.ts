const test=require('node:test');const assert=require('node:assert/strict');const {performance}=require('node:perf_hooks');
import { buildTreeModel } from '../../src/devhub/views/treeModel';

test('tree model handles 3 workspaces 30 projects 1000 sessions without a multi-second stall',()=>{
  const workspaces=Array.from({length:3},(_,i)=>({id:`w${i}`,name:`W${i}`,createdAt:1,updatedAt:1} as any));
  const projects=Array.from({length:30},(_,i)=>({id:`p${i}`,workspaceId:`w${i%3}`,name:`P${i}`,rootPath:`/tmp/p${i}`,createdAt:1,updatedAt:1} as any));
  const sessions=Array.from({length:1000},(_,i)=>({provider:'claude',nativeSessionId:`s${i}`,workspaceId:`w${(i%30)%3}`,projectId:`p${i%30}`,cwd:`/tmp/p${i%30}`,title:`S${i}`,status:i<4?'running':'done',createdAt:i,updatedAt:i} as any));
  const start=performance.now();const model=buildTreeModel(workspaces,projects,sessions);const elapsed=performance.now()-start;
  assert.equal(model.reduce((n,w)=>n+w.runningCount,0),4);assert.equal(model.reduce((n,w)=>n+w.projects.reduce((m,p)=>m+p.sessions.length,0),0),1000);assert.ok(elapsed<250,`tree build took ${elapsed.toFixed(1)}ms`);
});

import { SessionStore } from '../../src/devhub/storage/sessionStore';
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');

test('bulk metadata import keeps 1000-session reconciliation comfortably sub-second', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-perf-store-'));
  const store=new SessionStore(dir);
  const sessions=Array.from({length:1000},(_,i)=>({provider:'claude',nativeSessionId:`s${i}`,workspaceId:`w${i%3}`,projectId:`p${i%30}`,cwd:`/tmp/p${i%30}`,title:`S${i}`,status:'imported',createdAt:i,updatedAt:i} as any));
  const start=performance.now();
  await store.upsertMany(sessions);
  const elapsed=performance.now()-start;
  assert.equal((await store.list()).length,1000);
  assert.ok(elapsed<500,`bulk import took ${elapsed.toFixed(1)}ms`);
});

test('tree model stays responsive at 1000 projects and 50000 sessions',()=>{
  const workspaces=Array.from({length:10},(_,i)=>({id:`W${i}`,name:`W${i}`,createdAt:1,updatedAt:1} as any));
  const projects=Array.from({length:1000},(_,i)=>({id:`P${i}`,workspaceId:`W${i%10}`,name:`P${i}`,rootPath:`/tmp/P${i}`,createdAt:1,updatedAt:1} as any));
  const sessions=Array.from({length:50000},(_,i)=>({provider:'claude',nativeSessionId:`S${i}`,workspaceId:`W${(i%1000)%10}`,projectId:`P${i%1000}`,cwd:`/tmp/P${i%1000}`,title:`S${i}`,status:'done',createdAt:i,updatedAt:i} as any));
  const start=performance.now();
  const model=buildTreeModel(workspaces,projects,sessions);
  const elapsed=performance.now()-start;
  assert.equal(model.reduce((n,w)=>n+w.projects.reduce((m,p)=>m+p.sessions.length,0),0),50000);
  assert.ok(elapsed<250,`large tree build took ${elapsed.toFixed(1)}ms`);
});
