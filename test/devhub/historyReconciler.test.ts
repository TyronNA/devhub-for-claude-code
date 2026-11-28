export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { reconcileImportedSessions } from '../../src/devhub/sessions/historyReconciler';

test('history reconciliation preserves managed sessions and batches only changed metadata',()=>{
  const existing=[
    {provider:'claude',nativeSessionId:'keep',title:'Managed title',status:'done',updatedAt:50,workspaceId:'w',projectId:'p',cwd:'/p',createdAt:1},
    {provider:'codex',nativeSessionId:'old',title:'Old',status:'imported',updatedAt:10,workspaceId:'w',projectId:'p',cwd:'/p',createdAt:1},
  ] as any[];
  const imported=[
    {provider:'claude',nativeSessionId:'keep',title:'Imported title',status:'imported',updatedAt:100,workspaceId:'w',projectId:'p',cwd:'/p',createdAt:1},
    {provider:'codex',nativeSessionId:'old',title:'Fresh native',status:'imported',updatedAt:20,workspaceId:'w',projectId:'p',cwd:'/p',createdAt:1},
    {provider:'claude',nativeSessionId:'new',title:'New',status:'imported',updatedAt:30,workspaceId:'w',projectId:'p',cwd:'/p',createdAt:1},
  ] as any[];
  const changes=reconcileImportedSessions(existing as any, imported as any);
  assert.equal(changes.length,2);
  assert.equal(changes.find(s=>s.nativeSessionId==='old')?.title,'Old');
  assert.equal(changes.find(s=>s.nativeSessionId==='old')?.updatedAt,20);
  assert.equal(changes.find(s=>s.nativeSessionId==='new')?.title,'New');
  assert.equal(changes.some(s=>s.nativeSessionId==='keep'),false);
});
