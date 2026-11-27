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
    assert.equal(kids.filter((k:any)=>k.type==='session').length,3,'mặc định 3 session');
    const more=kids[kids.length-1];
    assert.equal(more.type,'more');
    assert.deepEqual({shown:more.data.shown,total:more.data.total},{shown:3,total:12});

    tree.showMore('p',12);
    kids=await tree.getChildren(node);
    assert.equal(kids.filter((k:any)=>k.type==='session').length,8,'bấm More => +5');

    tree.showMore('p',12);
    kids=await tree.getChildren(node);
    assert.equal(kids.filter((k:any)=>k.type==='session').length,12);
    assert.equal(kids.some((k:any)=>k.type==='more'),false,'hết session thì bỏ nút More');

    tree.showMore('p',12);
    kids=await tree.getChildren(node);
    assert.equal(kids.length,12,'không vượt quá tổng số');
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
    assert.ok(recent,'phải có node Recent');
    assert.ok(roots.indexOf(recent)>roots.findIndex((r:any)=>r.type==='workspace'),'Recent nằm sau workspace');
    assert.equal(recent.data.sessions.length,8,'giới hạn 8');
    assert.equal(recent.data.sessions[0].nativeSessionId,'s0','session đang chạy lên đầu');
    assert.equal(recent.data.sessions[1].nativeSessionId,'s24','còn lại theo updatedAt giảm dần');

    const ports=roots.find((r:any)=>r.type==='ports');
    assert.ok(ports,'phải có node Ports');
    assert.ok(roots.indexOf(ports)>roots.indexOf(recent),'Ports nằm dưới Recent');

    const kids=await tree.getChildren(recent);
    assert.equal(kids.length,8);
    assert.ok(kids.every((k:any)=>k.type==='session'));
    assert.equal(kids[0].project.name,'Proj','session trong Recent phải kèm project để biết thuộc đâu');
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
    assert.equal(roots.some((r:any)=>r.type==='recent'),false,'không session thì không có Recent');
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

    // Trong Recent: có project, không có workspace. Nhãn = emoji trạng thái + title (repo chỉ ở tooltip).
    const recentRow=tree.getTreeItem({type:'session',data:s('alo'),project:{name:'my-project'}});
    assert.equal(recentRow.label,'alo','Recent không còn tiền tố repo');
    assert.equal(recentRow.description,undefined,'imported là hàng bình thường: không có chữ nào');
    assert.ok(String(recentRow.tooltip).includes('my-project'),'repo vẫn có trong tooltip');

    // Dưới project: không lặp lại tên project
    const nested=tree.getTreeItem({type:'session',data:s('alo'),project:{name:'my-project'},workspace:{id:'w'}});
    assert.equal(nested.label,'alo','dưới project cũng chỉ còn title');
    assert.equal(nested.description,undefined,'repo đã là node cha nên description trống');
    assert.ok(String(nested.tooltip).startsWith('Claude'),'provider chuyển vào tooltip');

    // Title dính ký tự vẽ khung từ đoạn paste phải được dọn
    const messy=tree.getTreeItem({type:'session',data:s('games.code-workspace\n├── mong-giang-ho\n└── ascension-war'),project:{name:'p'},workspace:{id:'w'}});
    assert.equal(/[├└─│`]/.test(String(messy.label)),false,'không còn ký tự vẽ khung: '+messy.label);
    assert.equal(/\s{2,}|\n/.test(String(messy.label)),false,'không còn xuống dòng / khoảng trắng thừa');
    // Recent dọn title y hệt — giờ nó nằm trong nhãn
    const messyRecent=tree.getTreeItem({type:'session',data:s('a\n├── b'),project:{name:'p'}});
    assert.equal(/[├└─│`]|\n/.test(String(messyRecent.label)),false,'nhãn cũng phải dọn: '+messyRecent.label);

    // Title bị cắt trước khi vào nhãn; repo không còn trong nhãn
    const long=tree.getTreeItem({type:'session',data:s('x'.repeat(200)),project:{name:'a-very-long-service-name'}});
    assert.equal(String(long.label).includes('a-very-long'),false,'repo không vào nhãn: '+long.label);
    assert.ok(String(long.label).length<100,'nhãn phải ngắn, đang '+String(long.label).length);
    const nestedLong=tree.getTreeItem({type:'session',data:s('x'.repeat(200)),project:{name:'p'},workspace:{id:'w'}});
    assert.ok(String(nestedLong.label).length<100,'nhãn title phải ngắn, đang '+String(nestedLong.label).length);
    assert.equal(/^Claude/.test(String(nestedLong.label)),false,'nhãn không được bắt đầu bằng tên provider');
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
      assert.equal(icon(st).includes('spin'),false,st+' không được quay');
    // MỌI trạng thái giữ logo hãng — trạng thái đã nằm ở emoji nên không phải đánh đổi nữa.
    // (mock không có MEDIA nên rơi về codicon của provider)
    for(const st of ['running','done','imported','failed','cancelled','unavailable'])
      assert.equal(icon(st),'sparkle',st+' vẫn phải là logo hãng');
    const label=(st:string)=>String(tree.getTreeItem({type:'session',data:s(st),project:{name:'p'},workspace:{id:'w'}}).label||'');
    assert.ok(label('running').startsWith('\u23F3'),'running: '+label('running'));
    assert.ok(label('failed').startsWith('\u{1F534}'),'failed: '+label('failed'));
    assert.ok(label('done').startsWith('\u2705'),'done: '+label('done'));
    // `imported` KHÔNG đội glyph: chỗ trống là thứ phân biệt nó với hàng đã chạy xong.
    assert.equal(label('imported'),'t','imported là hàng Dev Hub chưa chạy lượt nào');

    // badge gọn thay cho chữ "1 running"
    const proj=tree.getTreeItem({type:'project',data:{project:{name:'x',id:'p'},sessions:[s('running'),s('done')]}});
    assert.equal(proj.description,'● 1','badge compact');
    const idle=tree.getTreeItem({type:'project',data:{project:{name:'x',id:'p'},sessions:[s('done')]}});
    assert.equal(idle.description,undefined,'không chạy thì không badge');

    // accent workspace phải ổn định, không đổi giữa các lần gọi
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
    // Hai hàng hành động đóng cây, dưới Agents: tạo chat, rồi mở nó trên điện thoại.
    assert.deepEqual(roots.slice(-2).map((n:any)=>n.type),['newchat','mobileapp'],'phải nằm CUỐI, dưới Agents');
    const item=withProjects.getTreeItem(roots[roots.length-2]);
    assert.equal(item.label,'New chat…');
    assert.equal(item.command.command,'devhub.searchProject');
    assert.equal(item.collapsibleState,0,'không được có mũi tên xổ');
    const phone=withProjects.getTreeItem(roots[roots.length-1]);
    assert.equal(phone.label,'Open on phone…');
    assert.equal(phone.command.command,'devhub.openMobileApp');

    const empty=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]});
    const bare=await empty.getChildren();
    assert.equal(bare.some((n:any)=>n.type==='newchat'),false,'chưa có project thì đừng mời tạo chat');
    // Hàng điện thoại KHÔNG phụ thuộc project: nó phục vụ cả cây, kể cả lúc chưa có gì.
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
    assert.ok(String(row('a').label).startsWith('\u2753'),'chờ duyệt: '+row('a').label);
    assert.ok(String(row('a').tooltip).includes('waiting for approval'));
    // Cùng status `running`, khác chỗ: session không bị hỏi vẫn là 🟢.
    assert.ok(String(row('b').label).startsWith('\u23F3'),'không bị hỏi: '+row('b').label);
    assert.ok(!String(row('b').tooltip).includes('waiting'));
    // Chờ duyệt thắng cả trạng thái bất thường — nó là hàng duy nhất cần tay người.
    assert.equal(statusGlyph('failed',true),'\u2753');
    assert.equal(statusGlyph('failed',false),'\u{1F534}');
  }finally{Module._load=original;}
});

test('a session row shows its hand-set name over the first prompt, and spends words only on an abnormal status',()=>{
  const {sessionNote,sessionLabel}=require('../../src/devhub/views/devHubTreeProvider');
  assert.equal(sessionLabel({title:'fix the queue'}),'fix the queue');
  // Đã rename thì tên đặt tay thắng; không còn tiền tố repo.
  assert.equal(sessionLabel({title:'fix the queue',name:'Queue bug'}),'Queue bug');
  // Recent đã xếp theo mới nhất nên thời gian là nhiễu; `imported` là mặc định — in ra chỉ là jargon.
  assert.equal(sessionNote('imported'),undefined);
  // `running`/`done` KHÔNG thành chữ: ⏳/✅ trong nhãn đã nói điều đó.
  assert.equal(sessionNote('running'),undefined);
  assert.equal(sessionNote('done'),undefined);
  // failed/cancelled/unavailable không lộ ra chỗ nào khác: icon hàng không chạy là logo hãng.
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
    assert.deepEqual(kids.map((k:any)=>k.data.task.jira_key),['A-1','A-2'],'chờ duyệt lên trước');
    assert.equal(plannerConversationId(kids[0].data.session.nativeSessionId),'task:A-1');

    const item=tree.getTreeItem(kids[0]);
    assert.equal(item.contextValue,'devhubPlannerTaskWaiting');
    assert.equal(item.description,'WAITING_APPROVAL · v1 · 0.90');
    assert.equal(item.command.command,'devhub.openPlannerSession');

    await tree.getChildren(node);
    assert.equal(hits,1,'TTL cache: refresh cây không được bắn thêm request');
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
    // Cổng 1 không ai nghe: một inbox rỗng và một daemon chết trông giống hệt nhau nếu im lặng.
    const spec={name:'my-planner',cwd:'/tmp/my-planner',kind:'http',endpoint:'http://127.0.0.1:1'};
    const kids=await tree.getChildren({type:'agent',data:{spec,running:false,detail:''}});
    assert.equal(kids[0].type,'plannerOffline');
    assert.ok(tree.getTreeItem(kids[0]).description,'phải nói lý do');
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
    assert.equal(kids[0].type,'plannerEmpty','inbox rỗng phải có hàng riêng, khác hẳn daemon chết');
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
    assert.equal(chat.length,1,'chỉ bot kind:http mới có hàng hỏi');
    assert.equal(plannerConversationId(chat[0].data.session.nativeSessionId),'chat:my-planner');
    // Đứng trước "Open on phone…" nhưng sau Agents: hàng hay dùng nhất không nằm cuối cùng.
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

    // Chưa đo xong: chỉ có số session, không bịa ra 0MB.
    const tree=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]},undefined,undefined,()=>[]);
    let fires=0;Object.assign(tree,{emitter:{fire:()=>fires++}});
    assert.equal(tree.getTreeItem(node).description,'8');
    await new Promise(r=>setTimeout(r,0));
    assert.equal(fires,1,'đo xong phải vẽ lại đúng một lần');
    // Không pid nào sống thì không có `ps` nào chạy và không có số nào hiện.
    assert.equal(tree.getTreeItem(node).description,'8');
    assert.equal(fires,1,'lần vẽ sau nằm trong TTL: không đo lại, không vòng lặp render');

    const hot=new DevHubTreeProvider({snapshot:async()=>({workspaces:[],projects:[]})},{list:async()=>[]},undefined,undefined,()=>[1]);
    Object.assign(hot,{memCache:{at:Date.now(),totalMB:744},portsCache:{at:Date.now(),groups:[]}});
    assert.equal(hot.getTreeItem(node).description,'8 · 744MB');
    assert.ok(String(hot.getTreeItem(node).tooltip).includes('744MB'));
    // `refresh()` chạy mỗi lần status session đổi; nó xoá ports/tasks nhưng không được xoá
    // cache RAM, nếu không mỗi delta của một lượt đang chạy là một lần `ps`.
    hot.refresh();
    assert.equal(hot.getTreeItem(node).description,'8 · 744MB');
    assert.equal((hot as any).portsCache,undefined);
  }finally{Module._load=original;}
});
