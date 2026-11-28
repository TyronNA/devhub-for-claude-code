const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
import { SessionManager } from '../../src/devhub/sessions/sessionManager';
import { SessionStore } from '../../src/devhub/storage/sessionStore';
import { plannerSessionId, plannerConversationId } from '../../src/devhub/sessions/plannerIdentity';
import { taskSession } from '../../src/devhub/agents/plannerTasks';
import { PlannerProvider } from '../../src/devhub/providers/planner/plannerProvider';
import { parseCodexHistoryRecord, codexSnapshot } from '../../src/devhub/providers/codex/codexHistoryParser';
import { loadCodexContext } from '../../src/devhub/providers/codex/codexHistory';

const session=(id:string,provider='claude'):any=>({provider,nativeSessionId:id,workspaceId:'w',projectId:'p',cwd:'/tmp',title:id,status:'running',createdAt:1,updatedAt:1});
async function tempStore(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-audit-fix-'));return {dir,store:new SessionStore(dir)};}

test('recovery leaves an active turn running and does not read its transcript',async()=>{
  const {store}=await tempStore();let end:any;let reads=0;
  const provider:any={isAvailable:async()=>true,start:async()=>({getNativeSessionId:()=> 'live',cancel:async()=>end(),events:(async function*(){await new Promise(r=>end=r);})()}),loadTranscript:async()=>{reads++;return []}};
  const manager=new SessionManager(store,{claude:provider});
  await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp',prompt:'go'});
  await manager.recoverStaleSessions();
  assert.equal(reads,0);assert.equal((await store.get('claude','live'))!.status,'running');
  assert.equal(manager.isBusy('claude','live'),true);
  end();await manager.waitForIdle();
});

test('recovery holds the session claim until the stale snapshot is saved',async()=>{
  const {store}=await tempStore();const old=session('old');await store.upsert(old);
  let release:any;let entered:any;const reading=new Promise(r=>entered=r);
  const manager=new SessionManager(store,{claude:{loadTranscript:async()=>{entered();await new Promise(r=>release=r);return []}} as any});
  const recovering=manager.recoverStaleSessions();await reading;
  await assert.rejects(manager.resume(old,'new turn'),/already running/);
  release();await recovering;
  assert.equal(manager.isBusy('claude','old'),false);
  assert.equal((await store.get('claude','old'))!.status,'imported');
});

test('same ticket on different daemons has isolated store identities and legacy restoration is unambiguous',async()=>{
  const {dir,store}=await tempStore();
  const a=taskSession({name:'same',cwd:'/a',endpoint:'http://localhost:7341'} as any,{jira_key:'DEV-1'} as any,[]);
  const b=taskSession({name:'same',cwd:'/b',endpoint:'http://localhost:7342'} as any,{jira_key:'DEV-1'} as any,[]);
  assert.notEqual(a.nativeSessionId,b.nativeSessionId);
  await store.upsert(a);await store.upsert(b);
  assert.equal((await store.list()).length,2);
  assert.equal((await store.get('planner',a.nativeSessionId))!.cwd,'/a');
  assert.equal(await store.get('planner','task:DEV-1'),undefined);
  const old=session('task:OLD','planner');old.plannerEndpoint='http://localhost:7342';
  await fs.writeFile(path.join(dir,'devhub','sessions.json'),JSON.stringify({version:1,sessions:[old]}));
  const reloaded=new SessionStore(dir);const restored=await reloaded.get('planner','task:OLD');
  assert.equal(restored!.nativeSessionId,plannerSessionId(old.plannerEndpoint,'task:OLD'));
  assert.equal(restored!.plannerEndpoint,old.plannerEndpoint);
});

test('scoped planner turns and history send only the native conversation to the right daemon',async()=>{
  const p:any=new PlannerProvider();const ep='http://localhost:7342';const ids:string[]=[];
  p.clients.set(ep,{stream:(_chunk:any,ready:any)=>{ready();return {destroy(){}}},
    json:async(_method:any,_route:any,body:any)=>{ids.push(body.conversation_id);return {reply:'ok'}},
    messages:async(id:string)=>{ids.push(id);return []},events:async()=>[],plan:async()=>({plan_markdown:'ok'})});
  const s=session(plannerSessionId(ep,'task:DEV-1'),'planner');
  const h=await p.resume({session:s,prompt:'hello'});
  for await(const _ of h.events){}
  await p.loadTranscript(s);
  assert.deepEqual(ids,['task:DEV-1','task:DEV-1']);
  assert.equal(h.getNativeSessionId(),s.nativeSessionId);
  assert.equal(plannerConversationId(s.nativeSessionId),'task:DEV-1');
});

const record=(primary:any,secondary:any,info:any=null):any=>({type:'event_msg',timestamp:'2026-09-09T01:00:00Z',payload:{type:'token_count',info,rate_limits:{limit_id:'codex',primary,secondary}}});
test('Codex quota uses actual window durations and retains observation time without inventing absent values',()=>{
  const usage=codexSnapshot(parseCodexHistoryRecord(record(
    {used_percent:35,window_minutes:10080,resets_at:1789445836},
    {used_percent:0,window_minutes:300,resets_at:1788952707})));
  assert.equal(usage.quota5hUsedPercentage,0);assert.equal(usage.quota7dUsedPercentage,35);
  assert.equal(usage.quota5hResetsAt,1788952707000);
  assert.equal(usage.quota7dObservedAt,Date.parse('2026-09-09T01:00:00Z'));
  assert.equal(usage.contextUsedTokens,undefined);
  assert.deepEqual(codexSnapshot(parseCodexHistoryRecord(record({used_percent:25,window_minutes:15},{used_percent:null,window_minutes:300}))),{});
  const foreign=record({used_percent:25,window_minutes:300},null);foreign.payload.rate_limits.limit_id='other';
  assert.deepEqual(codexSnapshot(parseCodexHistoryRecord(foreign)),{});
});

test('Codex tail combines latest context with a later quota-only record and excludes billing totals',async()=>{
  const {dir}=await tempStore();const file=path.join(dir,'rollout.jsonl');
  const context=record(null,null,{last_token_usage:{total_tokens:123},total_token_usage:{total_tokens:999999},model_context_window:258400});
  await fs.writeFile(file,[context,record({used_percent:27,window_minutes:300},null)].map(r=>JSON.stringify(r)).join('\n'));
  const u=await loadCodexContext(file);
  assert.equal(u!.contextUsedTokens,123);assert.equal(u!.quota5hUsedPercentage,27);
  assert.equal(u!.inputTokens,undefined);
});

test('row refresh keeps port and task results until explicit invalidation',()=>{
  const Module=require('node:module');const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return {};return original.apply(this,arguments as any);};
  try{
    const Tree=require('../../src/devhub/views/devHubTreeProvider').DevHubTreeProvider;
    const tree:any=Object.create(Tree.prototype);let renders=0;
    const ports={at:Date.now(),groups:[]};const tasks=new Map([['endpoint',{at:Date.now(),tasks:[]}]]);
    Object.assign(tree,{portsCache:ports,tasksCache:tasks,emitter:{fire:()=>renders++}});
    tree.refreshRows();tree.refreshRows();
    assert.equal(renders,2);assert.equal(tree.portsCache,ports);assert.equal(tasks.size,1);
    tree.refresh();assert.equal(tree.portsCache,undefined);assert.equal(tasks.size,0);
  }finally{Module._load=original;}
});
