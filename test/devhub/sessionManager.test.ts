const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
import { SessionStore } from '../../src/devhub/storage/sessionStore';
import { SessionManager } from '../../src/devhub/sessions/sessionManager';

class FakeProvider {
  id:any='claude';
  async isAvailable(){return true;}
  async start(){
    let cancelled=false;
    return { getNativeSessionId:()=> 'native-1', cancel:async()=>{cancelled=true;}, events:(async function*(){ yield {type:'assistant_message',text:'ok',timestamp:1} as any; yield {type:'usage',usage:{inputTokens:10,outputTokens:2},timestamp:2} as any; yield {type:'turn_done',timestamp:3} as any; })() };
  }
  async resume(){return this.start();}
  async discoverHistory(){return [];}
  async loadTranscript(){return [];}
}

test('session manager transitions running to done and persists usage', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-'));
  const store=new SessionStore(dir);
  const manager=new SessionManager(store,{claude:new FakeProvider() as any},4);
  const session=await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',prompt:'hello'});
  assert.equal(session.status,'running');
  await manager.waitForIdle();
  const saved=(await store.list())[0];
  assert.equal(saved.status,'done'); assert.equal(saved.usage?.inputTokens,10);
});

test('cancelled session stays cancelled after provider process exits', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-cancel-'));
  const store=new SessionStore(dir);
  let release:any;
  const provider:any={id:'claude',isAvailable:async()=>true,start:async()=>({getNativeSessionId:()=> 'cancel-1',cancel:async()=>release?.(),events:(async function*(){await new Promise(r=>release=r);})()}),resume:async()=>{throw new Error('unused')},discoverHistory:async()=>[],loadTranscript:async()=>[]};
  const manager=new SessionManager(store,{claude:provider},4);
  const session=await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',prompt:'hello'});
  await manager.cancel('claude',session.nativeSessionId);
  await manager.waitForIdle();
  assert.equal((await store.list())[0].status,'cancelled');
});

test('recovery resolves stale running session from native transcript terminal record', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-recover-'));
  const store=new SessionStore(dir);
  const stale:any={provider:'claude',nativeSessionId:'stale-1',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',title:'stale',status:'running',createdAt:1,updatedAt:1};
  await store.upsert(stale);
  const provider:any={id:'claude',isAvailable:async()=>true,start:async()=>{throw new Error('unused')},resume:async()=>{throw new Error('unused')},discoverHistory:async()=>[],loadTranscript:async()=>[{type:'assistant_message',text:'ok',timestamp:1},{type:'turn_done',timestamp:2}]};
  const manager=new SessionManager(store,{claude:provider},4);
  await manager.recoverStaleSessions();
  assert.equal((await store.get('claude','stale-1'))?.status,'done');
});

test('recovery marks missing stale transcript unavailable and incomplete transcript imported', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-recover-missing-'));
  const store=new SessionStore(dir);
  await store.upsert({provider:'claude',nativeSessionId:'missing',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',title:'missing',status:'running',createdAt:1,updatedAt:1} as any);
  await store.upsert({provider:'claude',nativeSessionId:'partial',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',title:'partial',status:'running',createdAt:1,updatedAt:1} as any);
  const providers:any={
    claude:{id:'claude',loadTranscript:async(s:any)=>{if(s.nativeSessionId==='missing')throw new Error('not found');return [{type:'assistant_message',text:'still going',timestamp:1}];}}
  };
  const manager=new SessionManager(store,providers,4);
  await manager.recoverStaleSessions();
  assert.equal((await store.get('claude','missing'))?.status,'unavailable');
  assert.equal((await store.get('claude','partial'))?.status,'imported');
});

test('resuming a session accumulates token usage across turns', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-usage-total-'));
  const store=new SessionStore(dir);let turn=0;
  const makeHandle=()=>({getNativeSessionId:()=> 'total-1',cancel:async()=>{},events:(async function*(){turn++;yield {type:'usage',usage:{inputTokens:turn===1?10:20,outputTokens:turn===1?2:3},timestamp:Date.now()} as any;yield {type:'turn_done',timestamp:Date.now()} as any;})()});
  const provider:any={id:'claude',isAvailable:async()=>true,start:async()=>makeHandle(),resume:async()=>makeHandle(),discoverHistory:async()=>[],loadTranscript:async()=>[]};
  const manager=new SessionManager(store,{claude:provider},4);
  let session=await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',prompt:'one'});await manager.waitForIdle();
  session=(await store.get('claude','total-1'))!;await manager.resume(session,'two');await manager.waitForIdle();
  const saved=await store.get('claude','total-1');assert.equal(saved?.usage?.inputTokens,30);assert.equal(saved?.usage?.outputTokens,5);
});

test('markUnavailable persists unavailable state for a missing transcript', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-unavailable-'));const store=new SessionStore(dir);
  const session:any={provider:'claude',nativeSessionId:'gone',workspaceId:'w',projectId:'p',cwd:'/tmp/repo',title:'gone',status:'imported',createdAt:1,updatedAt:1};await store.upsert(session);
  const manager=new SessionManager(store,{},4);await manager.markUnavailable(session);
  assert.equal((await store.get('claude','gone'))?.status,'unavailable');
});

test('streaming deltas do not persist session metadata on every token', async()=>{
  let writes=0;let saved:any;
  const store:any={upsert:async(s:any)=>{writes++;saved={...s};return s;},rekey:async()=>{},list:async()=>saved?[saved]:[],get:async()=>saved};
  const provider:any={id:'claude',isAvailable:async()=>true,start:async()=>({getNativeSessionId:()=> 'stream-1',cancel:async()=>{},events:(async function*(){for(let i=0;i<100;i++)yield {type:'assistant_delta',text:'x',timestamp:i};yield {type:'usage',usage:{inputTokens:10},timestamp:101};yield {type:'turn_done',timestamp:102};})()}),resume:async()=>{throw new Error('unused')},discoverHistory:async()=>[],loadTranscript:async()=>[]};
  const manager=new SessionManager(store,{claude:provider},4);await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp',prompt:'go'});await manager.waitForIdle();
  assert.ok(writes<=3,`expected at most start + usage + final writes, got ${writes}`);
});

test('three concurrent sessions keep events isolated by native session id',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-concurrent-'));const store=new SessionStore(dir);let seq=0;
  const makeProvider=(id:string)=>({id,isAvailable:async()=>true,start:async()=>{const sid=`${id}-${++seq}`;return {getNativeSessionId:()=>sid,cancel:async()=>{},events:(async function*(){yield {type:'assistant_message',text:sid,timestamp:Date.now()} as any;await new Promise(r=>setTimeout(r,15));yield {type:'turn_done',timestamp:Date.now()} as any;})()};},resume:async()=>{throw new Error('unused')},discoverHistory:async()=>[],loadTranscript:async()=>[]});
  const manager=new SessionManager(store,{claude:makeProvider('claude') as any},4);const seen:any[]=[];manager.on('event',(x:any)=>{if(x.event.type==='assistant_message')seen.push([x.sessionId,x.event.text]);});
  await Promise.all([manager.start({provider:'claude',workspaceId:'w',projectId:'p1',cwd:'/tmp',prompt:'1'}),manager.start({provider:'claude',workspaceId:'w',projectId:'p2',cwd:'/tmp',prompt:'2'}),manager.start({provider:'claude',workspaceId:'w',projectId:'p3',cwd:'/tmp',prompt:'3'})]);assert.equal(manager.runningCount(),3);await manager.waitForIdle();
  assert.equal(seen.length,3);assert.equal(seen.every(([id,text])=>id===text),true);
});

test('resume refuses unavailable provider before changing session state',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-manager-resume-unavailable-'));const store=new SessionStore(dir);const session:any={provider:'claude',nativeSessionId:'x',workspaceId:'w',projectId:'p',cwd:'/tmp',title:'x',status:'done',createdAt:1,updatedAt:1};await store.upsert(session);
  const provider:any={id:'claude',isAvailable:async()=>false,resume:async()=>{throw new Error('must not spawn')}};const manager=new SessionManager(store,{claude:provider},4);
  await assert.rejects(()=>manager.resume(session,'again'),/executable not found/);assert.equal((await store.get('claude','x'))?.status,'done');
});

test('a turn cut off mid-stream is not marked done by an older turn_done',async()=>{
  const store=new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(),'devhub-recover-')));
  await store.upsert({provider:'claude',nativeSessionId:'s1',workspaceId:'w',projectId:'p',cwd:'/tmp',
    title:'t',status:'running',createdAt:1,updatedAt:2} as any);
  // The old turn finished, the new one died midway: scanning the whole file would pick up the old turn's turn_done.
  const transcript=[{type:'user_message',text:'old',timestamp:1},{type:'turn_done',timestamp:2},
                    {type:'user_message',text:'new',timestamp:3},{type:'assistant_delta',text:'partial',timestamp:4}];
  const m=new SessionManager(store,{claude:{loadTranscript:async()=>transcript}} as any,4);
  await m.recoverStaleSessions();
  assert.equal((await store.get('claude','s1'))!.status,'imported','unfinished means imported, not done');

  const finished=[...transcript,{type:'turn_done',timestamp:5}];
  await store.upsert({...(await store.get('claude','s1'))!,status:'running'});
  const m2=new SessionManager(store,{claude:{loadTranscript:async()=>finished}} as any,4);
  await m2.recoverStaleSessions();
  assert.equal((await store.get('claude','s1'))!.status,'done','a last turn that really finished is still done');
});
