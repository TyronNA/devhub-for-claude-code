import { plannerConversationId } from '../../src/devhub/sessions/plannerIdentity';
export {};
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

class EventEmitterMock { event=()=>{}; fire(){} }
class TreeItemMock { constructor(public label:any, public collapsibleState:any){} }
const vscodeMock={
  workspace:{getConfiguration:()=>({get:(_k:string,d:any)=>d})},EventEmitter:EventEmitterMock,TreeItem:TreeItemMock,TreeItemCollapsibleState:{Expanded:1,None:0},ThemeIcon:class{constructor(public id:string,public color?:any){}},ThemeColor:class{constructor(public id:string){}}};

test('tree provider only reads stores for root and reuses node data for expanded children', async()=>{
  const original=Module._load;
  Module._load=function(request:string,parent:any,isMain:boolean){if(request==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    let workspaceReads=0,sessionReads=0;
    const workspaces={snapshot:async()=>{workspaceReads++;return {workspaces:[{id:'w',name:'W'}],projects:[{id:'p',workspaceId:'w',name:'P',rootPath:'/tmp/p'}]};}};
    const sessions={list:async()=>{sessionReads++;return [{provider:'claude',nativeSessionId:'s',workspaceId:'w',projectId:'p',cwd:'/tmp/p',title:'S',status:'done',updatedAt:1}];}};
    const provider=new DevHubTreeProvider(workspaces,sessions);
    const roots=await provider.getChildren();
    const projects=await provider.getChildren(roots[0]);
    await provider.getChildren(projects[0]);
    assert.equal(workspaceReads,1);
    assert.equal(sessionReads,1);
  } finally { Module._load=original; }
});

test('a project shows three sessions then pages five at a time',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const sessions=Array.from({length:12},(_,i)=>({provider:'claude',nativeSessionId:'s'+i,workspaceId:'w',projectId:'p',
      cwd:'/tmp',title:'t'+i,status:'done',createdAt:i,updatedAt:i}));
    const project={id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp',createdAt:1,updatedAt:1};
    const tree=new DevHubTreeProvider(
      {snapshot:async()=>({workspaces:[{id:'w',name:'W',createdAt:1,updatedAt:1}],projects:[project]})},
      {list:async()=>sessions});
    const node={type:'project',data:{project,sessions},workspace:{id:'w'},project};

    let kids=await tree.getChildren(node);
    assert.equal(kids.filter((k:any)=>k.type==='session').length,3,'3 sessions by default');
    const more=kids[kids.length-1];
    assert.equal(more.type,'more');
    assert.deepEqual({shown:more.data.shown,total:more.data.total},{shown:3,total:12});

    tree.showMore('p',12);
    kids=await tree.getChildren(node);
    assert.equal(kids.filter((k:any)=>k.type==='session').length,8,'clicking More => +5');

    tree.showMore('p',12);
    kids=await tree.getChildren(node);
    assert.equal(kids.filter((k:any)=>k.type==='session').length,12);
    assert.equal(kids.some((k:any)=>k.type==='more'),false,'no more sessions drops the More button');

    tree.showMore('p',12);
    kids=await tree.getChildren(node);
    assert.equal(kids.length,12,'never more than the total');
  }finally{Module._load=original;}
});

test('a project with three or fewer sessions gets no More row',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const project={id:'p2',workspaceId:'w',name:'Small',rootPath:'/tmp',createdAt:1,updatedAt:1};
    const sessions=[{provider:'claude',nativeSessionId:'x',workspaceId:'w',projectId:'p2',cwd:'/tmp',title:'t',status:'done',createdAt:1,updatedAt:1}];
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[project]})},{list:async()=>sessions});
    const kids=await tree.getChildren({type:'project',data:{project,sessions},workspace:{id:'w'},project});
    assert.equal(kids.length,1);
    assert.equal(kids.some((k:any)=>k.type==='more'),false);
  }finally{Module._load=original;}
});

test('root lists the workspaces then a Recent node capped at eight sessions, then Ports',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const projects=[{id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp',createdAt:1,updatedAt:1}];
    const sessions=Array.from({length:25},(_,i)=>({provider:'claude',nativeSessionId:'s'+i,workspaceId:'w',projectId:'p',
      cwd:'/tmp',title:'t'+i,status:i===0?'running':'done',createdAt:i,updatedAt:i}));
    const tree=new DevHubTreeProvider(
      {snapshot:async()=>({workspaces:[{id:'w',name:'W',createdAt:1,updatedAt:1}],projects})},
      {list:async()=>sessions});

    const roots=await tree.getChildren();
    assert.equal(roots[0].type,'workspace');
    const recent=roots.find((r:any)=>r.type==='recent');
    assert.ok(recent,'must have a Recent node');
    assert.ok(roots.indexOf(recent)>roots.findIndex((r:any)=>r.type==='workspace'),'Recent comes after the workspaces');
    assert.equal(recent.data.sessions.length,8,'capped at 8');
    assert.equal(recent.data.sessions[0].nativeSessionId,'s0','running sessions go first');
    assert.equal(recent.data.sessions[1].nativeSessionId,'s24','the rest by updatedAt descending');

    const ports=roots.find((r:any)=>r.type==='ports');
    assert.ok(ports,'must have a Ports node');
    assert.ok(roots.indexOf(ports)>roots.indexOf(recent),'Ports sits below Recent');

    const kids=await tree.getChildren(recent);
    assert.equal(kids.length,8);
    assert.ok(kids.every((k:any)=>k.type==='session'));
    assert.equal(kids[0].project.name,'Proj','sessions in Recent must carry their project to show where they belong');
  }finally{Module._load=original;}
});

test('Recent is omitted when there are no sessions at all',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const roots=await tree.getChildren();
    assert.equal(roots.some((r:any)=>r.type==='recent'),false,'no sessions means no Recent');
  }finally{Module._load=original;}
});

test('Recent rows show only the cleaned title, the repo moves to the tooltip',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const s=(title:string)=>({provider:'claude',nativeSessionId:'a',workspaceId:'w',projectId:'p',cwd:'/tmp',title,status:'imported',createdAt:1,updatedAt:1});

    // In Recent: has project, no workspace. Label = status emoji + title (repo only in the tooltip).
    const recentRow=tree.getTreeItem({type:'session',data:s('alo'),project:{name:'my-project'}});
    assert.equal(recentRow.label,'alo','Recent no longer has a repo prefix');
    assert.equal(recentRow.description,undefined,'imported is a normal row: no words at all');
    assert.ok(String(recentRow.tooltip).includes('my-project'),'the repo is still in the tooltip');

    // Under a project: don't repeat the project name
    const nested=tree.getTreeItem({type:'session',data:s('alo'),project:{name:'my-project'},workspace:{id:'w'}});
    assert.equal(nested.label,'alo','under a project it is also just the title');
    assert.equal(nested.description,undefined,'the repo is already the parent node so description is empty');
    assert.ok(String(nested.tooltip).startsWith('Claude'),'the provider moves into the tooltip');

    // Box-drawing characters stuck in a title from a paste must be cleaned
    const messy=tree.getTreeItem({type:'session',data:s('games.code-workspace\n├── mong-giang-ho\n└── ascension-war'),project:{name:'p'},workspace:{id:'w'}});
    assert.equal(/[├└─│`]/.test(String(messy.label)),false,'no box-drawing characters left: '+messy.label);
    assert.equal(/\s{2,}|\n/.test(String(messy.label)),false,'no newlines / extra whitespace left');
    // Recent cleans the title the same way — it now sits in the label
    const messyRecent=tree.getTreeItem({type:'session',data:s('a\n├── b'),project:{name:'p'}});
    assert.equal(/[├└─│`]|\n/.test(String(messyRecent.label)),false,'the label must be cleaned too: '+messyRecent.label);

    // The title is cut before going into the label; the repo is no longer in the label
    const long=tree.getTreeItem({type:'session',data:s('x'.repeat(200)),project:{name:'a-very-long-service-name'}});
    assert.equal(String(long.label).includes('a-very-long'),false,'the repo does not go into the label: '+long.label);
    assert.ok(String(long.label).length<100,'the label must be short, currently '+String(long.label).length);
    const nestedLong=tree.getTreeItem({type:'session',data:s('x'.repeat(200)),project:{name:'p'},workspace:{id:'w'}});
    assert.ok(String(nestedLong.label).length<100,'the title label must be short, currently '+String(nestedLong.label).length);
    assert.equal(/^Claude|^Codex/.test(String(nestedLong.label)),false,'the label must not start with the provider name');
  }finally{Module._load=original;}
});

test('every row keeps its vendor logo and carries its status as an emoji in the label',()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider,workspaceAccent}=require('../../src/devhub/views/devHubTreeProvider');
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const s=(status:string)=>({provider:'claude',nativeSessionId:'a',workspaceId:'w',projectId:'p',cwd:'/tmp',title:'t',status,createdAt:1,updatedAt:1});
    const icon=(st:string)=>String(tree.getTreeItem({type:'session',data:s(st),project:{name:'p'},workspace:{id:'w'}}).iconPath?.id||'');
    for(const st of ['running','done','imported','failed'])
      assert.equal(icon(st).includes('spin'),false,st+' must not spin');
    // EVERY state keeps the brand logo — the state is in the emoji so there is no trade-off any more.
    // (the mock has no MEDIA so it falls back to the provider codicon)
    for(const st of ['running','done','imported','failed','cancelled','unavailable'])
      assert.equal(icon(st),'sparkle',st+' must still be the brand logo');
    const label=(st:string)=>String(tree.getTreeItem({type:'session',data:s(st),project:{name:'p'},workspace:{id:'w'}}).label||'');
    assert.ok(label('running').startsWith('\u23F3'),'running: '+label('running'));
    assert.ok(label('failed').startsWith('\u{1F534}'),'failed: '+label('failed'));
    assert.ok(label('done').startsWith('\u2705'),'done: '+label('done'));
    // `imported` carries NO glyph: the empty space is what tells it apart from a finished row.
    assert.equal(label('imported'),'t','imported is a row Dev Hub has not run a turn on');

    // a compact badge instead of the words "1 running"
    const proj=tree.getTreeItem({type:'project',data:{project:{name:'x',id:'p'},sessions:[s('running'),s('done')]}});
    assert.equal(proj.description,'● 1','badge compact');
    const idle=tree.getTreeItem({type:'project',data:{project:{name:'x',id:'p'},sessions:[s('done')]}});
    assert.equal(idle.description,undefined,'not running means no badge');

    // the workspace accent must be stable, not change between calls
    assert.equal(workspaceAccent('Client Work'),workspaceAccent('Client Work'));
    assert.notEqual(workspaceAccent('Game'),workspaceAccent('Client Work'));
  }finally{Module._load=original;}
});

test('a New chat row closes the tree, and only when there is a project to chat about',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const project={id:'p',workspaceId:'w',name:'P',rootPath:'/tmp',createdAt:1,updatedAt:1};

    const withProjects=new DevHubTreeProvider(
      {snapshot:async()=>({workspaces:[{id:'w',name:'W',createdAt:1,updatedAt:1}],projects:[project]})},{list:async()=>[]});
    const roots=await withProjects.getChildren();
    // Two action rows close the tree, below Agents: create a chat, then open it on the phone.
    assert.deepEqual(roots.slice(-2).map((n:any)=>n.type),['newchat','mobileapp'],'must be LAST, below Agents');
    const item=withProjects.getTreeItem(roots[roots.length-2]);
    assert.equal(item.label,'New chat…');
    assert.equal(item.command.command,'devhub.searchProject');
    assert.equal(item.collapsibleState,0,'must have no expand arrow');
    const phone=withProjects.getTreeItem(roots[roots.length-1]);
    assert.equal(phone.label,'Open on phone…');
    assert.equal(phone.command.command,'devhub.openMobileApp');

    const empty=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const bare=await empty.getChildren();
    assert.equal(bare.some((n:any)=>n.type==='newchat'),false,'no project yet means do not offer to create a chat');
    // The phone row does NOT depend on projects: it serves the whole tree, even when there is nothing yet.
    assert.equal(bare.some((n:any)=>n.type==='mobileapp'),true);
  }finally{Module._load=original;}
});

test('a row waiting for approval says so, even though the store still calls it running',()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider,statusGlyph}=require('../../src/devhub/views/devHubTreeProvider');
    const asking=new Set(['claude\u0000a']);
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]},
      undefined,(prov:string,id:string)=>asking.has(prov+'\u0000'+id));
    const row=(id:string)=>tree.getTreeItem({type:'session',workspace:{id:'w'},project:{name:'p'},
      data:{provider:'claude',nativeSessionId:id,workspaceId:'w',projectId:'p',cwd:'/tmp',title:'t',
            status:'running',createdAt:1,updatedAt:1}});
    assert.ok(String(row('a').label).startsWith('\u2753'),'awaiting approval: '+row('a').label);
    assert.ok(String(row('a').tooltip).includes('waiting for approval'));
    // Same `running` status, different place: a session not being asked is still 🟢.
    assert.ok(String(row('b').label).startsWith('\u23F3'),'not asked: '+row('b').label);
    assert.ok(!String(row('b').tooltip).includes('waiting'));
    // Awaiting approval beats even abnormal states — it is the only row that needs a human hand.
    assert.equal(statusGlyph('failed',true),'\u2753');
    assert.equal(statusGlyph('failed',false),'\u{1F534}');
  }finally{Module._load=original;}
});

test('a session row shows its hand-set name over the first prompt, and spends words only on an abnormal status',()=>{
  const {sessionNote,sessionLabel}=require('../../src/devhub/views/devHubTreeProvider');
  assert.equal(sessionLabel({title:'fix the queue'}),'fix the queue');
  // Once renamed the hand-set name wins; no repo prefix any more.
  assert.equal(sessionLabel({title:'fix the queue',name:'Queue bug'}),'Queue bug');
  // Recent is already sorted newest first so time is noise; `imported` is the default — printing it is just jargon.
  assert.equal(sessionNote('imported'),undefined);
  // `running`/`done` do NOT become words: ⏳/✅ in the label already say it.
  assert.equal(sessionNote('running'),undefined);
  assert.equal(sessionNote('done'),undefined);
  // failed/cancelled/unavailable show nowhere else: the icon of a non-running row is the brand logo.
  assert.equal(sessionNote('failed'),'failed');
  assert.equal(sessionNote('cancelled'),'cancelled');
});

test('an http agent lists its tasks over the API instead of reading SQLite',async()=>{
  const http=require('node:http');
  let hits=0;
  const server=http.createServer((req:any,res:any)=>{
    hits++;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({tasks:[
      {jira_key:'A-2',status:'DONE',updated_at:2},
      {jira_key:'A-1',status:'WAITING_APPROVAL',plan_version:1,confidence:0.9,updated_at:1}]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  let tree:any;
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    tree=new DevHubTreeProvider(
      {snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const spec={name:'my-planner',cwd:'/tmp/my-planner',kind:'http',endpoint};
    const node={type:'agent',data:{spec,running:true,detail:'running'}};

    const kids=await tree.getChildren(node);
    assert.deepEqual(kids.map((k:any)=>k.data.task.jira_key),['A-1','A-2'],'awaiting approval goes first');
    assert.equal(plannerConversationId(kids[0].data.session.nativeSessionId),'task:A-1');

    const item=tree.getTreeItem(kids[0]);
    assert.equal(item.contextValue,'devhubPlannerTaskWaiting');
    assert.equal(item.description,'WAITING_APPROVAL · v1 · 0.90');
    assert.equal(item.command.command,'devhub.openPlannerSession');

    await tree.getChildren(node);
    assert.equal(hits,1,'TTL cache: refreshing the tree must not fire extra requests');
  } finally {
    tree?.dispose?.();Module._load=original;await new Promise<void>(r=>server.close(()=>r()));
  }
});

test('an unreachable daemon says so instead of showing an empty inbox',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  let tree:any;
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    // Nobody listens on port 1: an empty inbox and a dead daemon look identical if silent.
    const spec={name:'my-planner',cwd:'/tmp/my-planner',kind:'http',endpoint:'http://127.0.0.1:1'};
    const kids=await tree.getChildren({type:'agent',data:{spec,running:false,detail:''}});
    assert.equal(kids[0].type,'plannerOffline');
    assert.ok(tree.getTreeItem(kids[0]).description,'must give the reason');
  } finally { tree?.dispose?.();Module._load=original; }
});

test('a live daemon with nothing in the inbox says that, not nothing',async()=>{
  const http=require('node:http');
  const server=http.createServer((_req:any,res:any)=>{
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({tasks:[]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  let tree:any;
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const spec={name:'my-planner',cwd:'/tmp/my-planner',kind:'http',endpoint};
    const kids=await tree.getChildren({type:'agent',data:{spec,running:true,detail:'running'}});
    assert.equal(kids.length,1);
    assert.equal(kids[0].type,'plannerEmpty','an empty inbox must have its own row, clearly different from a dead daemon');
    assert.equal(tree.getTreeItem(kids[0]).description,endpoint);
  } finally {
    tree?.dispose?.();Module._load=original;await new Promise<void>(r=>server.close(()=>r()));
  }
});

test('the free-chat row sits at the root so asking never needs a click into the tree',async()=>{
  const original=Module._load;
  const cfg={agents:[{name:'my-planner',cwd:'/tmp/my-planner',kind:'http'},{name:'my-bot',cwd:'/tmp/my-bot'}]};
  const mock={...vscodeMock,workspace:{getConfiguration:()=>({get:(k:string,d:any)=>(cfg as any)[k]??d})}};
  Module._load=function(r:string){if(r==='vscode')return mock;return original.apply(this,arguments as any);};
  let tree:any;
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const roots=await tree.getChildren();
    const chat=roots.filter((n:any)=>n.type==='plannerChat');
    assert.equal(chat.length,1,'only kind:http bots get an ask row');
    assert.equal(plannerConversationId(chat[0].data.session.nativeSessionId),'chat:my-planner');
    // Before "Open on phone…" but after Agents: the most-used row isn't the very last one.
    assert.ok(roots.indexOf(chat[0])<roots.findIndex((n:any)=>n.type==='mobileapp'));
  } finally { tree?.dispose?.();Module._load=original; }
});

test('Recent carries the RAM its live CLI processes are holding',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    const node={type:'recent',data:{sessions:new Array(8),projects:[]}};

    // Not measured yet: only the session count, no made-up 0MB.
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]},undefined,undefined,()=>[]);
    let fires=0;Object.assign(tree,{emitter:{fire:()=>fires++}});
    assert.equal(tree.getTreeItem(node).description,'8');
    await new Promise(r=>setTimeout(r,0));
    assert.equal(fires,1,'once measured it must redraw exactly once');
    // No live pid means no `ps` runs and no number shows.
    assert.equal(tree.getTreeItem(node).description,'8');
    assert.equal(fires,1,'the next draw is within TTL: no re-measure, no render loop');

    const hot=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]},undefined,undefined,()=>[1]);
    Object.assign(hot,{memCache:{at:Date.now(),totalMB:744},portsCache:{at:Date.now(),groups:[]}});
    assert.equal(hot.getTreeItem(node).description,'8 · 744MB');
    assert.ok(String(hot.getTreeItem(node).tooltip).includes('744MB'));
    // `refresh()` runs every time a session status changes; it clears ports/tasks but must not clear
    // the RAM cache, or every delta of a running turn is one `ps`.
    hot.refresh();
    assert.equal(hot.getTreeItem(node).description,'8 · 744MB');
    assert.equal((hot as any).portsCache,undefined);
  }finally{Module._load=original;}
});

test('first run: one setup row on top, walking install → log in → add project, then gone',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/devHubTreeProvider')];
    const {DevHubTreeProvider}=require('../../src/devhub/views/devHubTreeProvider');
    let projects:any[]=[];
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects})},{list:async()=>[]});
    const top=async()=>{const r=await tree.getChildren();return r[0].type==='setup'?r[0].data.step:undefined;};
    // Not probed yet: no warning flash for a machine that is already set up, only the missing project.
    assert.equal(await top(),'project');
    tree.setClaudeSetup('missing');assert.equal(await top(),'missing');
    const row=tree.getTreeItem((await tree.getChildren())[0]);
    assert.equal(row.label,'Install Claude Code…');assert.equal(row.command.command,'devhub.getStarted');
    tree.setClaudeSetup('loggedOut');assert.equal(await top(),'loggedOut');
    tree.setClaudeSetup('ready');assert.equal(await top(),'project');
    projects=[{id:'p',workspaceId:'w',name:'P',rootPath:'/tmp/p'}];
    assert.equal(await top(),undefined,'a working setup has no setup row');
  } finally { Module._load=original; }
});
