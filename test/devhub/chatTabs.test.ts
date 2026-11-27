export {};
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
import { parseWebviewMessage } from '../../src/devhub/views/webviewProtocol';

function mockVscode(){
  const panels:any[]=[];const warnings:string[]=[];
  const settings:Record<string,any>={'claude.model':'opus','claude.effort':'medium','claude.models':['opus','sonnet']};
  const commands:string[]=[];const serializers:any[]=[];
  return {panels,settings,warnings,commands,serializers,mock:{
    ViewColumn:{Beside:2},Uri:{file:(p:string)=>p},
    commands:{executeCommand:(id:string)=>{commands.push(id);return Promise.resolve(undefined)}},
    workspace:{getConfiguration:()=>({get:(k:string,d:any)=>settings[k]!==undefined?settings[k]:d})},
    window:{showWarningMessage:(m:string)=>{warnings.push(m);return Promise.resolve(undefined)},
      registerWebviewPanelSerializer:(_id:string,ser:any)=>{serializers.push(ser);return {dispose(){}}},
      createWebviewPanel:(id:string,title:string,where:any)=>{
      const requested=typeof where==='object'&&where?where.viewColumn:where;
      // VS Code chốt viewColumn thật sau khi panel hiện; Beside(2) hoá thành cột 2.
      const p:any={id,title,requested,viewColumn:requested,revealedIn:[] as any[],disposed:false,posted:[],handler:null,
        webview:{html:'',cspSource:'vscode-webview://x',postMessage:(m:any)=>{p.posted.push(m);return true},
          onDidReceiveMessage:(h:any)=>{p.handler=h},asWebviewUri:(u:any)=>'https://file+.vscode-resource/'+String(u)},
        reveal(c:any){p.revealedIn.push(c)},dispose(){p.disposed=true;p.onDispose&&p.onDispose()},
        onDidDispose:(f:any)=>{p.onDispose=f},onDidChangeViewState:()=>{}};
      panels.push(p);return p;}}}};
}
// `const vscode=require('vscode')` chạy một lần lúc nạp module, nên phải xoá cache
// giữa các test — nếu không mọi panel đều rơi vào mock của test đầu tiên.
function freshProvider(){delete require.cache[require.resolve('../../src/devhub/views/chatPanelProvider')];
  return require('../../src/devhub/views/chatPanelProvider').ChatPanelProvider;}
async function withVscode(fn:(v:any,C:any)=>Promise<void>){
  const v=mockVscode();const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{await fn(v,freshProvider());}finally{Module._load=original;}
}
const SESSION=(id:string)=>({provider:'claude',nativeSessionId:id,workspaceId:'w',projectId:'p',cwd:'/tmp',title:'t',status:'done',createdAt:1,updatedAt:1});
/** Đính kèm chỉ hợp lệ khi nằm trong thư mục Dev Hub tự ghi ra; host từ chối path khác. */
const ATT=(name:string)=>path.join(os.tmpdir(),'devhub','attachments',name);
const LOOKUP=async()=>({workspaces:[{id:'w',name:'WS',createdAt:1,updatedAt:1}],projects:[{id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp',createdAt:1,updatedAt:1}]});
// VS Code cho phép nhiều listener; panel giả phải giữ đủ để mô phỏng dispose giữa các await.
function serializerPanel(){
  const listeners:Array<()=>void>=[];const p:any={id:'devHub.chat',title:'',viewColumn:2,posted:[],handler:null,disposed:false};
  p.webview={html:'',cspSource:'x',postMessage:(m:any)=>{if(p.disposed)throw new Error('Webview is disposed');p.posted.push(m);return true},
    onDidReceiveMessage:(h:any)=>{p.handler=h},asWebviewUri:(u:any)=>String(u)};
  p.reveal=()=>{};p.dispose=()=>{if(p.disposed)return;p.disposed=true;for(const f of listeners.splice(0))f();};
  p.onDidDispose=(f:any)=>{listeners.push(f);return {dispose(){const i=listeners.indexOf(f);if(i>=0)listeners.splice(i,1);}}};
  p.onDidChangeViewState=()=>{};return p;
}

test('each session opens its own tab and re-opening reuses it',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    await c.openSession(SESSION('b'));
    assert.equal(v.panels.length,2,'hai session khác nhau => hai tab');
    await c.openSession(SESSION('a'));
    assert.equal(v.panels.length,2,'mở lại session cũ => tái dùng tab, không tạo thêm');
    c.dispose();
  });
});

test('tabs are no longer capped — every session keeps its own panel',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    for(let i=0;i<12;i++) await c.openSession(SESSION('s'+i));
    const alive=v.panels.filter((p:any)=>!p.disposed);
    assert.equal(alive.length,12,'không cap nữa, thấy '+alive.length);
    c.dispose();
  });
});

test('pasted image is written to disk and its path is sent back to the webview',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-att-'));
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},dir);
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    const png=Buffer.from('89504e470d0a1a0a','hex').toString('base64');
    await panel.handler({type:'pasteImage',mime:'image/png',data:png});
    const msg=panel.posted.find((m:any)=>m.type==='attachment');
    assert.ok(msg,'phải gửi lại đường dẫn cho webview');
    assert.equal(path.extname(msg.path),'.png');
    assert.deepEqual(await fs.readFile(msg.path),Buffer.from(png,'base64'),'nội dung file phải khớp ảnh dán');
    c.dispose();
  });
});

test('image paste messages are validated before touching disk',()=>{
  const ok=parseWebviewMessage({type:'pasteImage',mime:'image/png',data:'aGk='});
  assert.deepEqual(ok,{type:'pasteImage',mime:'image/png',data:'aGk='});
  assert.equal(parseWebviewMessage({type:'pasteImage',mime:'text/html',data:'aGk='}),undefined,'chặn mime lạ');
  assert.equal(parseWebviewMessage({type:'pasteImage',mime:'image/png',data:'not base64!'}),undefined,'chặn base64 hỏng');
  assert.equal(parseWebviewMessage({type:'pasteImage',mime:'image/png',data:'A'.repeat(13*1024*1024)}),undefined,'chặn quá cỡ');
  assert.deepEqual(parseWebviewMessage({type:'pickProvider'}),{type:'pickProvider'});
  assert.deepEqual(parseWebviewMessage({type:'pickProject'}),{type:'pickProject'});
  assert.deepEqual(parseWebviewMessage({type:'newTab'}),{type:'newTab'});
});

test('webview renders content without innerHTML',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const ChatPanelProvider=freshProvider();
    const c=new ChatPanelProvider({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{});
    const html=(c as any).html({});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(script),false,'không được dựng nội dung bằng innerHTML');
    assert.ok(script.includes("type:'pasteImage'"),'phải có handler paste ảnh');
    assert.ok(html.includes('img-src  data:'),'không có cspSource thì chỉ còn data:, không được in undefined');
    assert.equal(/img-src[^;]*undefined/.test(html),false,'CSP không được chứa chữ undefined');
    const withSource=(c as any).html({cspSource:'vscode-resource://x'});
    assert.ok(withSource.includes("img-src vscode-resource://x data:;"),'ảnh nạp từ đĩa qua nguồn của webview');
    assert.equal(/default-src 'none'/.test(withSource),true,'phần còn lại của CSP không đổi');
    c.dispose();
  }finally{Module._load=original;}
});

test('webview themes Claude and planner differently and exposes the composer controls',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const ChatPanelProvider=freshProvider();
    const c=new ChatPanelProvider({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{});
    const html=(c as any).html({});
    assert.ok(/body\[data-provider="claude"\]\{--accent:#d97757/.test(html),'Claude phải có accent riêng');
    assert.ok(/body\[data-provider="planner"\]\{--accent:#8b7cf8/.test(html),'Planner phải có accent riêng');
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes("setAttribute('data-provider'"),'script phải gắn data-provider theo provider');
    for(const id of ['model','effort','donut','arc','ctxtext','ctxtokens','ctxwrap','q5wrap','q5arc','q5text','q7wrap','q7arc','q7text','q5tip','q7tip','ctxtip'])assert.ok(html.includes('id="'+id+'"'),'thiếu control: '+id);
    // Nút `‹` chỉ từng hiện trên điện thoại — đúng việc ngăn kéo mép trái đang làm.
    assert.ok(!html.includes('id="back"'),'nút back đã bỏ, không được quay lại');
    assert.equal(html.includes('id="usage"'),false,'hàng usage cũ lặp với composerbar — đã bỏ');
    // Ở bề ngang điện thoại: nhãn quota và % context nhường chỗ, % của hai vòng limit thì ở lại.
    assert.ok(/#q5lab,#q7lab,#ctxtext,#ctxtokens\{display:none\}/.test(html),'màn hình hẹp phải ẩn nhãn quota và % context');
    assert.ok(html.includes('id="q5lab"')&&html.includes('id="q7lab"'),'nhãn quota phải là span riêng mới ẩn được');
    // Một hàng ở 390px chỉ vừa khi mỗi chip khác model bị chốt `flex:none` — `.chip` có
    // `overflow:hidden` nên min-width của flex item là 0 và cả hàng cùng bị bóp.
    assert.equal(/\.composerbar\{[^}]*flex-wrap/.test(html),false,'composerbar phải là một hàng trên điện thoại');
    assert.ok(/\.composerbar>\*\{flex:none\}/.test(html),'các chip phải giữ nguyên bề rộng');
    assert.ok(/#model\{flex:0 1 auto;min-width:0\}/.test(html),'tên model là chỗ DUY NHẤT được co');
    // `height` cố định cho textarea + grow() đo `height:auto` = ô bị nới giữa lúc bàn phím trồi
    // lên, và WebKit hủy present. Cỡ nghỉ do min-height quyết, grow() đo nội dung từ 0.
    assert.equal(/textarea\{min-height:32px;height:/.test(html),false,'ô nhập trên điện thoại không được có `height` cố định');
    assert.equal(script.includes("style.height='auto'"),false,'grow() không được đo bằng `auto` — đó là rows="3", không phải nội dung');
    assert.ok(script.includes("t.style.height='0px';contentH=t.scrollHeight"),'grow() phải đo nội dung từ 0');
    assert.equal(html.includes('id="compact"'),false,'không cần nút compact riêng — vòng context đã là nút');
    for(const t of ['pickModel','pickEffort'])assert.ok(script.includes("type:'"+t+"'"),'thiếu message '+t);
    c.dispose();
  }finally{Module._load=original;}
});

test('extra chat tabs land in the same editor group instead of splitting again',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    await c.openSession(SESSION('b'));
    await c.openSession(SESSION('c'));
    const cols=v.panels.map((p:any)=>p.requested);
    assert.equal(cols.length,3);
    assert.equal(new Set(cols).size,1,'ba tab phải cùng một cột, thấy: '+JSON.stringify(cols));
    assert.ok(v.panels.every((p:any)=>p.revealedIn.every((x:any)=>x===cols[0])),'reveal cũng phải trỏ đúng cột đó');
    c.dispose();
  });
});

test('new chats start from the configured per-provider model and effort',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const started:any[]=[];
    const manager={on:()=>()=>{},async start(i:any){started.push(i);return {...SESSION('new'),provider:i.provider};}};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    const snap=await LOOKUP();
    await c.newChat(snap.workspaces[0],snap.projects[0],'claude');
    await v.panels[0].handler({type:'sendPrompt',text:'hi'});
    assert.equal(started[0].model,'opus');
    assert.equal(started[0].effort,'medium');
    c.dispose();
  });
});

test('model/effort đã chọn thuộc về session: đóng tab mở lại không rơi về mặc định',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    v.mock.window.showQuickPick=async(items:any[])=>items.find((i:any)=>i.value==='sonnet');
    let stored:any={...SESSION('c'),provider:'claude'};
    const manager:any={on:()=>()=>{},isBusy:()=>false,
      setTurnOptions:async(sess:any,o:any)=>{stored={...sess,...o};return stored;}};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(stored);
    await v.panels[0].handler({type:'pickModel'});
    assert.equal(stored.model,'sonnet','picker phải ghi lựa chọn vào session, không chỉ vào tab');
    // Đóng tab rồi mở lại chính session đó: tab mới phải đọc lựa chọn của session.
    v.panels[0].dispose();
    await c.openSession(stored);
    const opts=v.panels[v.panels.length-1].posted.filter((m:any)=>m.type==='optionsChanged').pop();
    assert.equal(opts.model,'sonnet','mở lại không được rơi về devHub.claude.model');
    c.dispose();
  });
});

test('effort choices stay within what each CLI accepts',()=>{
  const pkg=JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.cwd(),'package.json'),'utf8'));
  const claude=pkg.contributes.configuration.properties['devHub.claude.effort'].enum;
  assert.ok(claude.includes('max'),'Claude có --effort max');
  assert.equal(pkg.contributes.configuration.properties['devHub.claude.model'].default,'opus');
  assert.equal(pkg.contributes.configuration.properties['devHub.claude.effort'].default,'medium');
});

test('composer chips never show the word Default and carry model and effort',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const ChatPanelProvider=freshProvider();
    const c=new ChatPanelProvider({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{});
    const html=(c as any).html({});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.equal(/Default model|Default effort/.test(script),false,'không được hiện chữ Default');
    assert.ok(script.includes("state.model||'auto'"),'rỗng thì hiện auto');
    assert.ok(html.includes('title="Thinking effort"'),'chip effort phải tự giải thích bằng tooltip');
    assert.ok(html.includes('title="Model"'),'chip model phải tự giải thích bằng tooltip');
    assert.equal(/\\u[0-9a-f]{4}[0-9]/.test(script),false,'không được có escape unicode ngoài BMP viết sai');
    c.dispose();
  }finally{Module._load=original;}
});

test('optionsChanged always lands after the state-replacing messages',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    await panel.handler({type:'ready'});
    const kinds=panel.posted.map((m:any)=>m.type);
    const lastState=Math.max(kinds.lastIndexOf('sessionSelected'),kinds.lastIndexOf('draftSelected'),kinds.lastIndexOf('empty'));
    const lastOpts=kinds.lastIndexOf('optionsChanged');
    assert.ok(lastState>=0&&lastOpts>lastState,
      'optionsChanged phải sau sessionSelected, nếu không model/effort bị ghi đè: '+kinds.join(','));
    const opts=panel.posted[lastOpts];
    assert.equal(opts.model,'opus');
    assert.equal(opts.effort,'medium');
    c.dispose();
  });
});

test('the webview keeps model and effort when a state-replacing message arrives',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const ChatPanelProvider=freshProvider();
    const c=new ChatPanelProvider({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{});
    const script=(c as any).html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    for(const kind of ['sessionSelected','draftSelected','empty']){
      const i=script.indexOf("x.type==='"+kind+"'");
      assert.ok(i>0,'thiếu nhánh '+kind);
      const branch=script.slice(i,i+260);
      assert.ok(branch.includes('model:state.model')&&branch.includes('effort:state.effort'),
        kind+' phải giữ lại model/effort thay vì ghi đè state');
    }
    c.dispose();
  }finally{Module._load=original;}
});

test('the provider chip draws the brand mark inline instead of loading a file',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const ChatPanelProvider=freshProvider();
    const c=new ChatPanelProvider({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{});
    const html=(c as any).html({});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes('createElementNS'),'phải dựng SVG inline');
    assert.ok(/MARK=\{claude:'M[^']{200,}'/.test(script),'path logo Claude phải được nhúng');
    // localResourceRoots rỗng => mọi tham chiếu file trong webview đều chết
    assert.equal(/media\/[a-z-]+\.svg/.test(html),false,'webview không được trỏ tới file svg');
    assert.equal(/<img/.test(html),false,'không dùng <img>');
    c.dispose();
  }finally{Module._load=original;}
});

test('chat turns carry no You/Claude label — border and colour say who spoke',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=freshProvider()&&new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.equal(/label='You'/.test(script),false,'không còn nhãn You');
    const ua=script.slice(script.indexOf("e.type==='user_message'"),script.indexOf("e.type==='tool_started'"));
    assert.equal(/label=providerName/.test(ua),false,'user/assistant không gán nhãn provider');
    // Nhãn của tool/command/error vẫn phải còn — đó là thông tin, không phải xưng danh.
    assert.ok(script.includes("label='Error'")&&script.includes("label='Warning'"),'giữ nhãn cho warning/error');
    assert.ok(script.includes("el('span','tname'"),'tool/command dùng hàng một dòng thay cho nhãn');
    assert.ok(script.includes('if(label)d.insertBefore'),'chỉ chèn meta khi có nhãn');
  }finally{Module._load=original;}
});

test('a chat tab is titled by project alone and carries the brand icon',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','/MEDIA');
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    await panel.handler({type:'ready'});
    assert.equal(panel.title,'Proj','tiêu đề chỉ còn tên project');
    assert.equal(/Claude/.test(panel.title),false,'không được có tên provider trong tiêu đề');
    assert.ok(panel.iconPath&&panel.iconPath.light&&panel.iconPath.dark,'phải gắn iconPath');
    assert.ok(String(panel.iconPath.dark).includes('claude-dark.svg'),'sai file: '+panel.iconPath.dark);
    c.dispose();
  });
});

test('a running turn shows a spinning brand mark, a rotating verb and an elapsed clock',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const c=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{});
    const html=(c as any).html({});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];

    for(const id of ['thinking','spinner','thinkword','thinktime'])
      assert.ok(html.includes('id="'+id+'"'),'thiếu '+id);
    assert.ok(/@keyframes spin/.test(html),'phải có animation xoay');
    assert.ok(/prefers-reduced-motion/.test(html),'phải tôn trọng reduced-motion');
    assert.ok(/WORDS=\['Cooking','Vibing'/.test(script),'phải có danh sách động từ');
    assert.ok(script.includes('startThinking()')&&script.includes('stopThinking()'),'phải bật/tắt theo status');
    assert.ok(/if\(running\)startThinking\(\);else stopThinking\(\)/.test(script),'gắn vào status running');
    assert.ok(script.includes("sp.appendChild(mark(p))"),'spinner dùng logo hãng');

    // Composer phải là MỘT khung bọc cả attachment, ô nhập và toolbar
    const box=html.indexOf('class="composer-box"');
    assert.ok(box>0,'thiếu composer-box');
    for(const id of ['attachments','input','model','effort','send'])
      assert.ok(html.indexOf('id="'+id+'"')>box,id+' phải nằm trong composer-box');
    assert.ok(/\.composer-box:focus-within\{border-color:var\(--accent\)/.test(html),'focus phải sáng viền accent');
    c.dispose();
  }finally{Module._load=original;}
});

test('a permission request renders Allow/Deny and the answer reaches the provider',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const answered:any[]=[];
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,(prov:string,sid:string,rid:string,allow:boolean)=>answered.push({prov,sid,rid,allow}));
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    c.showPermission('claude','a',{requestId:'r1',toolName:'Bash',input:{command:'rm -rf /'}});
    const msg=panel.posted.find((m:any)=>m.type==='permission');
    assert.ok(msg,'phải đẩy yêu cầu sang webview');
    assert.equal(msg.request.requestId,'r1');

    await panel.handler({type:'permissionResponse',requestId:'r1',allow:false});
    assert.deepEqual(answered.pop(),{prov:'claude',sid:'a',rid:'r1',allow:false});

    // Không có tab nào mở -> phải deny ngay, không để CLI treo vô hạn
    c.showPermission('claude','ghost',{requestId:'r9'});
    assert.deepEqual(answered.pop(),{prov:'claude',sid:'ghost',rid:'r9',allow:false});
    c.dispose();
  });
});

test('the webview builds a permission card with both buttons',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const html=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{}).html({});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes("x.type==='permission'"),'phải nhận message permission');
    assert.ok(script.includes("el('button','allow','Allow')")&&script.includes("el('button','deny','Deny')"));
    assert.ok(script.includes("type:'permissionResponse'"),'phải gửi lại quyết định');
    assert.ok(/\.perm\.answered \.pacts\{display:none\}/.test(html),'trả lời xong phải khoá nút');
  }finally{Module._load=original;}
});

test('pasted images show a thumbnail chip and their paths ride along on send, not in the box',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes("img.src=a.thumb"),'chip phải có thumbnail');
    assert.ok(script.includes("naturalWidth"),'phải đo kích thước ảnh');
    assert.ok(script.includes("pending.filter(a=>a.path).map(a=>a.path)"),'path ghép lúc gửi');
    assert.equal(/t\.value=\(t\.value\?/.test(script),false,'không được nhét path vào ô nhập nữa');
    assert.ok(script.includes("el('button','attx'"),'chip phải có nút xoá');
  }finally{Module._load=original;}
});

test('a pending permission is always answered — on double click, tab close, or dispose',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const answered:any[]=[];
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,(prov:string,sid:string,rid:string,allow:boolean)=>answered.push({sid,rid,allow}));
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];

    // trả lời hai lần -> chỉ tính lần đầu
    c.showPermission('claude','a',{requestId:'r1',toolName:'Bash',input:{}});
    await panel.handler({type:'permissionResponse',requestId:'r1',allow:true});
    await panel.handler({type:'permissionResponse',requestId:'r1',allow:false});
    assert.equal(answered.filter(x=>x.rid==='r1').length,1,'không được trả lời hai lần');
    assert.equal(answered[0].allow,true);

    // đóng tab trong lúc đang chờ -> phải DENY, nếu không CLI treo mãi
    c.showPermission('claude','a',{requestId:'r2',toolName:'Bash',input:{}});
    panel.dispose();
    assert.deepEqual(answered.pop(),{sid:'a',rid:'r2',allow:false});

    // dispose toàn bộ provider cũng phải dọn
    await c.openSession(SESSION('b'));
    c.showPermission('claude','b',{requestId:'r3',toolName:'Bash',input:{}});
    c.dispose();
    assert.deepEqual(answered.pop(),{sid:'b',rid:'r3',allow:false});
  });
});

test('every element the script reaches for exists in the HTML',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const html=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{}).html({});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    const ids=new Set([...html.matchAll(/id="([a-zA-Z]+)"/g)].map(m=>m[1]));
    const used=[...new Set([...script.matchAll(/\$\('([a-zA-Z]+)'\)/g)].map(m=>m[1]))];
    const missing=used.filter(u=>!ids.has(u));
    // Một id thiếu làm script ném lỗi và mọi listener sau đó không được gắn (Enter chết).
    assert.deepEqual(missing,[],'script gọi $() vào id không tồn tại: '+missing.join(', '));
    assert.ok(used.length>10,'phải thực sự quét được, chỉ thấy '+used.length);
  }finally{Module._load=original;}
});

test('Enter sends and Shift+Enter does not',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(/e\.key==='Enter'&&!e\.shiftKey/.test(script),'thiếu điều kiện Enter');
    assert.ok(/preventDefault\(\);send\(\)/.test(script),'Enter phải chặn xuống dòng rồi gửi');
    // listener bọc trong on() để một phần tử thiếu không giết cả script
    assert.ok(script.includes("const on=(id,ev,fn)=>"),'phải có helper on() phòng thủ');
    assert.equal(/\$\('[a-z]+'\)\.onclick=/.test(script),false,'không gán onclick trực tiếp nữa');
  }finally{Module._load=original;}
});

test('the slash chip only appears for a provider that advertises commands',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes('state.slash=!!x.slash'),'phải nhận cờ slash');
    assert.ok(/sl\.hidden=!state\.slash/.test(script),'không có lệnh thì ẩn nút');
  }finally{Module._load=original;}
});

test('the + button opens a new chat in the project already on screen',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    let asked=false;
    v.mock.window.showQuickPick=async()=>{asked=true;return undefined;};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    const before=v.panels.length;
    // `+` từ trong một session: phải mở tab draft ngay, KHÔNG bắt chọn lại project —
    // bắt chọn lại là lý do "đang chat mà thêm chat không được".
    await v.panels[0].handler({type:'newTab'});
    assert.equal(asked,false,'không được hỏi project');
    assert.equal(v.panels.length,before+1,'phải có tab mới');
    const fresh=v.panels[v.panels.length-1];
    const draft=fresh.posted.find((m:any)=>m.type==='draftSelected');
    assert.ok(draft,'tab mới phải là draft sẵn sàng nhập');
    assert.equal(draft.draft.project.name,'Proj','cùng project đang mở');
    assert.equal(draft.draft.provider,'claude','cùng provider');
    c.dispose();
  });
});

test('the history chip lists only this project, newest first, after a rescan',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    let rescans=0;
    const stored=[
      {...SESSION('old'),title:'phiên cũ',updatedAt:1000},
      {...SESSION('new'),title:'phiên mới',updatedAt:9000},
      {...SESSION('other'),projectId:'zzz',title:'project khác',updatedAt:9999},
    ];
    let items:any[]=[];
    v.mock.window.showQuickPick=async(list:any[])=>{items=list;return list[0];};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,()=>{},async()=>stored,async()=>{rescans++;});
    await c.openSession(SESSION('a'));
    await v.panels[0].handler({type:'pickHistory'});
    // Session mở từ terminal chỉ vào store khi quét lại; không quét thì list là ảnh cũ.
    assert.equal(rescans,1,'phải quét lại lịch sử trước khi liệt kê');
    assert.deepEqual(items.map((i:any)=>i.label),['phiên mới','phiên cũ'],'chỉ project đang mở, mới nhất trước');
    // Chọn một dòng = mở đúng session đó trong tab riêng của nó.
    const opened=v.panels[v.panels.length-1].posted.find((m:any)=>m.type==='sessionSelected');
    assert.equal(opened.session.nativeSessionId,'new');
    c.dispose();
  });
});

test('every chat block starts at the same left edge',()=>{
  const css=require('node:fs').readFileSync('media/webview/chat.css','utf8');
  /** Thân của một rule CSS, tra bằng chuỗi thay vì regex để không phải escape selector. */
  const body=(sel:string)=>{
    const at=css.indexOf('\n'+sel+'{');
    assert.ok(at>=0,'thiếu rule '+sel);
    return css.slice(at+sel.length+2,css.indexOf('}',at));
  };
  const px=(text:string,prop:string,fallback:number)=>{
    const m=new RegExp('(?:^|;)'+prop+':(\\d+)px').exec(text);
    return m?Number(m[1]):fallback;
  };
  const MAIN=px(body('main'),'padding',-1);
  assert.equal(MAIN,12,'main padding');
  const MSG_SIDE=9;   // .msg{padding:6px 9px}
  assert.ok(/padding:6px 9px/.test(body('.msg')),'.msg vẫn là padding:6px 9px');
  assert.match(body('.user'),/background:color-mix\(in srgb,var\(--vscode-input-background\) 78%,var\(--vscode-editor-foreground\) 22%\)/,
    'user phải có nền khác nền code');
  assert.match(body('.user'),/box-shadow:inset 3px 0 0 var\(--vscode-contrastActiveBorder,var\(--accent\)\)/,
    'user phải có vạch trái để không phụ thuộc phân biệt màu');

  // Mốc chung mọi khối phải trùng: main + viền trái + padding trái.
  const inset=(sel:string,border:number)=>MAIN+border+px(body(sel),'padding-left',MSG_SIDE);
  assert.equal(inset('.user',1),23,'bong bóng user');
  assert.equal(inset('.assistant',0),23,'chữ agent — trước đây padding-left:0 nên thụt 11px');
  assert.equal(inset('.tool,.command',2),23,'tool/command');
  assert.equal(inset('.file',2),23,'dòng file');
  assert.equal(inset('.warning',2),23,'warning');
  assert.equal(inset('.error',2),23,'error');
  // .perm dùng `padding:8px 10px` nên số ngang là giá trị THỨ HAI.
  const permSide=/padding:\d+px (\d+)px/.exec(body('.perm'));
  assert.ok(permSide,'.perm phải khai padding hai chiều');
  assert.equal(MAIN+1+Number(permSide![1]),23,'thẻ duyệt quyền');
});

/** Manager giả đủ để đóng/mở một lượt: giữ handler sessionUpdated để test tự bắn. */
function queueManager(){
  const handlers:Record<string,any[]>={};
  const resumed:Array<{text:string;images?:string[]}>=[];
  let fail:string|undefined; let busy=false; let cancelled=0;
  const m:any={
    on:(ev:string,cb:any)=>{(handlers[ev]||(handlers[ev]=[])).push(cb);return ()=>{}},
    resume:async(session:any,text:string,opts:any)=>{
      if(fail){const e=new Error(fail);fail=undefined;throw e;}
      resumed.push({text,images:opts?.images});
      const next={...session,status:'running'};
      m.emit('sessionUpdated',next);
      return next;
    },
    emit:(ev:string,payload:any)=>{for(const cb of handlers[ev]||[])cb(payload);},
    isBusy:()=>busy,
    cancel:async()=>{cancelled++;},
    resumed,failNext:(msg:string)=>{fail=msg;},setBusy:(v:boolean)=>{busy=v;},cancels:()=>cancelled,
  };
  return m;
}
const tick=()=>new Promise(r=>setTimeout(r,0));
const lastQueue=(panel:any)=>[...panel.posted].reverse().find((p:any)=>p.type==='queue');
/** Hàng chờ mang theo số ảnh; phần lớn test chỉ quan tâm chữ. */
const queueTexts=(panel:any)=>lastQueue(panel).items.map((i:any)=>i.text);

test('a message typed mid-turn is queued, not dropped, and flushes in order when the turn ends',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    const panel=v.panels[0];

    panel.handler({type:'sendPrompt',text:'một'});
    panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    assert.deepEqual(manager.resumed,[],'đang chạy thì chưa gửi gì');
    assert.deepEqual(lastQueue(panel),{type:'queue',items:[{text:'một',images:0},{text:'hai',images:0}]});

    // Lượt xong -> flush đúng một tin, tin còn lại vẫn nằm chờ.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['một']);
    assert.deepEqual(queueTexts(panel),['hai'],'chỉ gửi một tin mỗi lượt');

    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['một','hai']);
    assert.deepEqual(queueTexts(panel),[]);
    c.dispose();
  });
});

test('a queued message survives a failed resume instead of vanishing',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    const panel=v.panels[0];
    panel.handler({type:'sendPrompt',text:'giữ tôi lại'});
    await tick();

    manager.failNext('claude executable not found');
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(queueTexts(panel),['giữ tôi lại'],'gửi lỗi thì trả về đầu hàng chờ');
    assert.ok(panel.posted.some((p:any)=>p.event?.type==='error'),'và phải báo lỗi ra tab');

    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['giữ tôi lại'],'lần sau gửi lại được');
    c.dispose();
  });
});

test('a queued message keeps its attachments',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    v.panels[0].handler({type:'sendPrompt',text:'xem ảnh',attachments:[ATT('a.png')]});
    await tick();
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'xem ảnh',images:[ATT('a.png')]}]);
    c.dispose();
  });
});

test('removing a queued message takes it out for good',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    const panel=v.panels[0];
    panel.handler({type:'sendPrompt',text:'một'});
    panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    panel.handler({type:'dequeue',index:0});
    await tick();
    assert.deepEqual(queueTexts(panel),['hai']);
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['hai'],'tin đã xoá không được gửi');
    c.dispose();
  });
});

test('a pending AskUserQuestion is re-posted after the webview re-renders, and never twice',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const answered:any[]=[];
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,(...a:any[])=>answered.push(a));
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    const req={requestId:'q1',toolName:'AskUserQuestion',requiresUserInteraction:true,
      input:{questions:[{question:'Tabs or spaces?',options:[{label:'Tabs'},{label:'Spaces'}]}]}};
    c.showPermission('claude','a',req);
    assert.equal(panel.posted.filter((m:any)=>m.type==='permission').length,1);

    // Webview nạp lại (ẩn tab, VS Code dựng lại DOM) -> renderAll xoá sạch thẻ câu hỏi.
    panel.posted.length=0;
    await panel.handler({type:'ready'});
    const replayed=panel.posted.filter((m:any)=>m.type==='permission');
    assert.equal(replayed.length,1,'request còn treo phải được gửi lại');
    assert.equal(replayed[0].request.requestId,'q1');
    assert.equal(answered.length,0,'chưa ai trả lời thì không được deny ngầm');

    // Trả lời xong thì hết treo: lần render sau không gửi lại nữa.
    await panel.handler({type:'permissionResponse',requestId:'q1',allow:true,answers:{'Tabs or spaces?':'Tabs'}});
    assert.equal(answered.length,1);
    assert.equal(answered[0][3],true);
    assert.deepEqual(answered[0][4].answers,{'Tabs or spaces?':'Tabs'});
    panel.posted.length=0;
    await panel.handler({type:'ready'});
    assert.equal(panel.posted.filter((m:any)=>m.type==='permission').length,0);
  });
});

test('a permission with no tab to show it leaves a warning instead of vanishing',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const answered:any[]=[];
    const c=new ChatPanelProvider({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,(...a:any[])=>answered.push(a));
    c.showPermission('claude','ghost',{requestId:'p9',toolName:'Bash',input:{command:'ls'}});
    assert.equal(answered.length,1,'không có tab thì phải deny để CLI không treo');
    assert.equal(answered[0][3],false);
    assert.equal(v.warnings.length,1,'deny ngầm phải để lại dấu vết');
    assert.match(v.warnings[0],/denied automatically/);
  });
});

test('a pending question dies with the turn: locked card, no replay, no late expiry warning',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const answered:any[]=[];
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,(...a:any[])=>answered.push(a));
    await c.openSession({...SESSION('a'),status:'running'});
    const panel=v.panels[0];
    c.showPermission('claude','a',{requestId:'q1',toolName:'AskUserQuestion',requiresUserInteraction:true,
      input:{questions:[{question:'Tabs or spaces?',options:[{label:'Tabs'}]}]}});

    // Lượt bị cancel: CLI không còn chờ, nên thẻ phải bị khoá và request phải được dọn.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    const closed=panel.posted.filter((m:any)=>m.type==='permissionClosed');
    assert.equal(closed.length,1,'webview phải được bảo là thẻ đã chết');
    assert.equal(closed[0].requestId,'q1');
    assert.equal(answered.length,1,'vẫn deny để CLI không bao giờ treo');
    assert.equal(answered[0][3],false);

    panel.posted.length=0;
    await panel.handler({type:'ready'});
    assert.equal(panel.posted.filter((m:any)=>m.type==='permission').length,0,'không replay thẻ chết');
    assert.equal(v.warnings.length,0,'và không có warning "expired" nào');
    c.dispose();
  });
});

test('showPermission reports back when there was no tab to show it in',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,()=>{});
    assert.equal(c.showPermission('claude','ghost',{requestId:'p1',toolName:'Bash',input:{}}),false);
    await c.openSession({...SESSION('a'),status:'running'});
    assert.equal(c.showPermission('claude','a',{requestId:'p2',toolName:'Bash',input:{}}),true);
    c.dispose();
  });
});

test('nothing ever closes the sidebar by itself',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    // Bố cục là của người dùng: mở tab, mở lại tab, đều không được đụng tới sidebar.
    await c.openSession(SESSION('a'));
    await c.openSession(SESSION('b'));
    assert.deepEqual(v.commands,[],'không có closeSidebar tự động ở bất kỳ đâu');
    c.dispose();
  });
});

test('image upload replies retain request identity for success and failure',async()=>{
  await withVscode(async(v,C)=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-upload-'));
    const c=new C({on:()=>()=>{}},{claude:{loadTranscript:async()=>[]}},LOOKUP,()=>{},()=>{},()=>{},dir);
    try{
      await c.openSession(SESSION('a'));const panel=v.panels[0];
      await panel.handler({type:'pasteImage',requestId:'ok',mime:'image/png',data:'aGk='});
      const saved=panel.posted.find((m:any)=>m.type==='attachment');assert.equal(saved.requestId,'ok');
      assert.equal(await fs.readFile(saved.path,'utf8'),'hi');
      await panel.handler({type:'pasteImage',requestId:'large',mime:'image/png',data:'A'.repeat(12*1024*1024+4)});
      assert.ok(panel.posted.some((m:any)=>m.type==='attachmentError'&&m.requestId==='large'));
      await fs.rm(path.join(dir,'devhub'),{recursive:true,force:true});
      await fs.writeFile(path.join(dir,'devhub'),'blocks directory');
      await panel.handler({type:'pasteImage',requestId:'disk',mime:'image/png',data:'aGk='});
      assert.ok(panel.posted.some((m:any)=>m.type==='attachmentError'&&m.requestId==='disk'));
    }finally{c.dispose();await fs.rm(dir,{recursive:true,force:true});}
  });
});

test('restoring selection opens the transcript when no editor tab exists',async()=>{
  await withVscode(async(v,C)=>{
    const c=new C({on:()=>()=>{}},{claude:{loadTranscript:async()=>[{type:'assistant_message',text:'restored',timestamp:1}]}},LOOKUP,()=>{},()=>{},()=>{});
    try{
      await c.restoreSelection(SESSION('restore'));
      assert.equal(v.panels.length,1);
      await v.panels[0].handler({type:'ready'});
      assert.ok(v.panels[0].posted.some((m:any)=>m.type==='sessionSelected'&&m.events.some((e:any)=>e.text==='restored')));
      await c.restoreSelection(SESSION('another'));
      assert.equal(v.panels.length,1,'startup must not replace an already open chat');
    }finally{c.dispose();}
  });
});

test('an image path becomes a webview URI on the way out, and stays a path in the cache',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const path=require('node:path');
    const p=path.join(require('node:os').tmpdir(),'t1','exec-1.png');
    const providers={claude:{loadTranscript:async()=>[{type:'assistant_image',path:p,alt:'sprite',timestamp:1}],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),provider:'claude'});
    const selected=v.panels[0].posted.find((m:any)=>m.type==='sessionSelected');
    const img=selected.events.find((e:any)=>e.type==='assistant_image');
    // Chỉ tới lúc gửi mới thành URI; cái nằm trong cache của host vẫn là đường dẫn ngắn.
    assert.equal(img.src,'https://file+.vscode-resource/'+p);
    assert.equal(img.path,p,'đường dẫn vẫn còn để lần gửi sau đổi lại được');
    assert.equal(JSON.stringify(img).includes('base64'),false,'không có bytes nào đi qua postMessage');
    c.dispose();
  });
});

test('an attached image survives with no typed text, and reaches the webview as a URI',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[{type:'user_message',text:'',images:[ATT('a.png')],timestamp:1}],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    // Chỉ ảnh, không chữ: trước đây `if(!text)return` nuốt luôn tin, không lỗi không hàng chờ.
    await v.panels[0].handler({type:'sendPrompt',text:'   ',attachments:[ATT('a.png')]});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'',images:[ATT('a.png')]}]);
    const selected=v.panels[0].posted.find((m:any)=>m.type==='sessionSelected');
    const um=selected.events.find((e:any)=>e.type==='user_message');
    assert.deepEqual(um.imageSrcs,['https://file+.vscode-resource/'+ATT('a.png')]);
    assert.deepEqual(um.images,[ATT('a.png')],'cache giữ đường dẫn, không giữ URI của một tab');
    c.dispose();
  });
});

test('a session the manager still holds is queued for, not resumed into',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));   // status 'done'
    // Stop ghi 'cancelled' ngay, nhưng stream chưa drain nên manager vẫn giữ session.
    manager.setBusy(true);
    await v.panels[0].handler({type:'sendPrompt',text:'gửi lúc vừa bấm Stop'});
    await tick();
    assert.deepEqual(manager.resumed,[],'không được gọi resume khi manager còn giữ lượt');
    assert.equal(v.panels[0].posted.some((m:any)=>m.type==='error'),false,'và không được in lỗi');
    assert.deepEqual(queueTexts(v.panels[0]),['gửi lúc vừa bấm Stop']);
    // sessionUpdated lúc bận không được rút tin ra khỏi hàng chờ để rồi ăn lỗi.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    assert.deepEqual(manager.resumed,[]);
    assert.deepEqual(queueTexts(v.panels[0]),['gửi lúc vừa bấm Stop'],'tin vẫn nằm nguyên');
    // Drain xong: sessionUpdated cuối mới là lúc gửi được.
    manager.setBusy(false);
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'gửi lúc vừa bấm Stop',images:undefined}]);
    c.dispose();
  });
});

test('Stop keeps the queue and sends it when the killed turn is done dying',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    const panel=v.panels[0];
    await panel.handler({type:'sendPrompt',text:'một'});
    await panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    assert.deepEqual(queueTexts(panel),['một','hai']);
    await panel.handler({type:'cancel'});
    await tick();
    assert.equal(manager.cancels(),1,'vẫn phải huỷ lượt đang chạy');
    assert.deepEqual(queueTexts(panel),['một','hai'],'Stop chỉ giết lượt, chữ đã gõ ở lại');
    assert.deepEqual(manager.resumed,[],'chưa drain xong thì chưa gửi');
    // Drain xong: tin đầu hàng chờ chạy tiếp, đúng thứ tự đã gõ.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'một',images:undefined}]);
    assert.deepEqual(queueTexts(panel),['hai']);
    c.dispose();
  });
});


test('a reloaded Claude transcript turns its leading image paths back into images',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const path=require('node:path');
    const dir=path.join(os.tmpdir(),'devhub-recover');
    const att=path.join(dir,'devhub','attachments');
    const a=path.join(att,'1-aa.png');
    // withImages nối path vào ĐẦU prompt, nên transcript đọc lại chỉ còn mấy dòng path trần.
    const providers={claude:{isAvailable:async()=>true,
      loadTranscript:async()=>[{type:'user_message',text:`${a}\nxem hộ tôi ảnh này`,timestamp:1},
                               {type:'user_message',text:'/etc/passwd\nkhông phải ảnh của tôi',timestamp:2}]}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},dir);
    await c.openSession(SESSION('a'));
    const selected=v.panels[0].posted.find((m:any)=>m.type==='sessionSelected');
    const [first,second]=selected.events;
    assert.deepEqual(first.images,[a]);
    assert.equal(first.text,'xem hộ tôi ảnh này','dòng path phải rời khỏi phần chữ');
    assert.deepEqual(first.imageSrcs,['https://file+.vscode-resource/'+a]);
    assert.equal(second.images,undefined,'đường dẫn ngoài thư mục attachment không được đụng vào');
    assert.equal(second.text,'/etc/passwd\nkhông phải ảnh của tôi');
    c.dispose();
  });
});

test('a failed first send keeps the queue in the order it was typed',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const started:string[]=[]; let boom=true;
    const manager:any={on:()=>()=>{},isBusy:()=>false,
      start:async(input:any)=>{if(boom){boom=false;throw new Error('claude executable not found');}
        started.push(input.prompt);return {...SESSION('new'),status:'running'};}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.newChat({id:'w',name:'WS'},{id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp'},'claude');
    const panel=v.panels[0];
    await panel.handler({type:'sendPrompt',text:'một'});
    await tick();
    assert.deepEqual(started,[],'start hỏng thì chưa có gì chạy');
    assert.deepEqual(queueTexts(panel),['một'],'tin hỏng phải quay lại đầu hàng chờ');
    await panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    assert.deepEqual(started,['một'],'tin cũ chạy trước, không nhảy cóc');
    assert.deepEqual(queueTexts(panel),['hai']);
    c.dispose();
  });
});

test('an error is part of the transcript, not a line that disappears on the next render',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    manager.failNext('Claude executable not found');
    await v.panels[0].handler({type:'sendPrompt',text:'chạy đi'});
    await tick();
    // Mở lại session: event lấy từ buffer của host, nên lỗi phải có mặt ở đó.
    await c.openSession(SESSION('a'));
    const selected=[...v.panels[0].posted].reverse().find((m:any)=>m.type==='sessionSelected');
    const err=selected.events.find((e:any)=>e.type==='error');
    assert.ok(err,'lỗi phải nằm trong transcript');
    assert.equal(err.message,'Claude executable not found');
    c.dispose();
  });
});

test('a live event that lands while history is loading is not wiped by the history',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    let release:(v?:any)=>void=()=>{};
    const gate=new Promise(r=>{release=r as any});
    const providers={claude:{isAvailable:async()=>true,
      // Đọc transcript chậm: đúng cửa sổ mà event live rơi vào cache rồi bị `set()` xoá.
      loadTranscript:async()=>{await gate;return [{type:'user_message',text:'cũ',timestamp:1000}]}}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    const opening=c.openSession({...SESSION('a'),status:'running'});
    await tick();
    manager.emit('event',{provider:'claude',sessionId:'a',event:{type:'assistant_message',text:'mới',timestamp:5000}});
    release();
    await opening;
    const selected=[...v.panels[0].posted].reverse().find((m:any)=>m.type==='sessionSelected');
    assert.deepEqual(selected.events.map((e:any)=>e.text),['cũ','mới'],
      'lịch sử phải xếp trước event live, không thay thế nó');
    c.dispose();
  });
});

test('a send that the manager refuses gives the typed text and its images back',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));   // 'done' => đường resume trực tiếp
    const panel=v.panels[0];
    manager.failNext('Claude executable not found');
    await panel.handler({type:'sendPrompt',text:'xem ảnh',attachments:[ATT('a.png')]});
    await tick();
    assert.deepEqual(queueTexts(panel),['xem ảnh'],'chữ đã gõ phải quay lại hàng chờ');
    assert.equal(lastQueue(panel).items[0].images,1,'và ảnh đính kèm đi cùng nó');
    assert.ok(panel.posted.some((m:any)=>m.type==='error'||m.event?.type==='error'),'vẫn phải nói là gửi hỏng');
    c.dispose();
  });
});

test('the first message of a brand-new chat shows its image too',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const handlers:Record<string,any[]>={};
    const manager:any={on:(ev:string,cb:any)=>{(handlers[ev]||(handlers[ev]=[])).push(cb);return ()=>{}},
      emit:(ev:string,p:any)=>{for(const cb of handlers[ev]||[])cb(p)},isBusy:()=>false,
      start:async(input:any)=>{
        // sessionManager phát tin của người dùng ngay khi start, kèm đường dẫn ảnh.
        manager.emit('event',{provider:'claude',sessionId:'new',event:{type:'user_message',text:input.prompt,images:input.images,timestamp:1}});
        return {...SESSION('new'),status:'running'};}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.newChat({id:'w',name:'WS'},{id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp'},'claude');
    const panel=v.panels[0];
    await panel.handler({type:'sendPrompt',text:'xem ảnh',attachments:[ATT('a.png')]});
    await tick();
    const selected=[...panel.posted].reverse().find((m:any)=>m.type==='sessionSelected');
    const um=selected.events.find((e:any)=>e.type==='user_message');
    assert.deepEqual(um.imageSrcs,['https://file+.vscode-resource/'+ATT('a.png')],
      'nhánh tạo session cũng phải đổi path thành webview URI');
    c.dispose();
  });
});

test('an image that only exists as a data uri is passed through, not turned into a file uri',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const src='data:image/png;base64,aGk=';
    const providers={claude:{isAvailable:async()=>true,
      loadTranscript:async()=>[{type:'user_message',text:'ảnh đây',images:[src],timestamp:1}]}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),provider:'claude'});
    const selected=v.panels[0].posted.find((m:any)=>m.type==='sessionSelected');
    const um=selected.events.find((e:any)=>e.type==='user_message');
    assert.deepEqual(um.imageSrcs,[src]);
    c.dispose();
  });
});

test('picking a model keeps the slash chip — optionsChanged always carries the flag',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    v.mock.window.showQuickPick=async(items:any[])=>items.find((i:any)=>i.value==='sonnet');
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true,slashCommands:()=>['compact']}};
    const c=new ChatPanelProvider({on:()=>()=>{},setTurnOptions:async(sess:any,o:any)=>({...sess,...o})},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    await panel.handler({type:'ready'});
    await panel.handler({type:'pickModel'});
    // `!!x.slash` ở webview: post thiếu cờ là nút `/` biến mất tới lần postOptions kế.
    const opts=panel.posted.filter((m:any)=>m.type==='optionsChanged');
    assert.equal(opts[opts.length-1].model,'sonnet');
    assert.equal(opts[opts.length-1].slash,true,'đổi model không được nuốt nút slash');
    c.dispose();
  });
});

test('a failed send does not lock the queue — the next message drains the head first',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const resumed:any[]=[];let fail=true;
    const manager:any={on:()=>()=>{},isBusy:()=>false,
      resume:async(s:any,text:string)=>{resumed.push(text);if(fail)throw new Error('claude executable not found');return {...s,status:'running'}}};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    await panel.handler({type:'sendPrompt',text:'một'});
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='queue').pop().items.map((i:any)=>i.text),['một'],
      'gửi hỏng phải giữ lại chữ');
    // Không có sessionUpdated nào sau một resume hỏng, nên nếu `queue.length` chặn đường gửi
    // thì tab thành chỉ-ghi: mọi tin sau đó chỉ chất đống.
    fail=false;
    await panel.handler({type:'sendPrompt',text:'hai'});
    assert.deepEqual(resumed,['một','một'],'tin cũ phải được gửi lại trước');
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='queue').pop().items.map((i:any)=>i.text),['hai'],
      'tin mới xuống cuối hàng, đúng thứ tự đã gõ');
    c.dispose();
  });
});

test('an attachment outside the Dev Hub folder is refused, not handed to the CLI',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const resumed:any[]=[];
    const manager:any={on:()=>()=>{},isBusy:()=>false,
      resume:async(s:any,text:string,o:any)=>{resumed.push(o.images);return {...s,status:'running'}}};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    // `attachments` đi thẳng vào prompt (Claude); validator dùng chung chỉ
    // biết "đường dẫn tuyệt đối" nên gốc phải chốt ở host.
    await panel.handler({type:'sendPrompt',text:'đọc hộ',attachments:['/etc/passwd']});
    assert.deepEqual(resumed,[],'không được gửi lượt nào');
    const shown=panel.posted.filter((m:any)=>m.type==='event').map((m:any)=>m.event.message).join('\n');
    assert.match(shown,/Refused an attachment/,'phải nói ra là đã từ chối');
    await panel.handler({type:'sendPrompt',text:'ảnh thật',attachments:[ATT('ok.png')]});
    assert.deepEqual(resumed,[[ATT('ok.png')]],'ảnh trong thư mục đính kèm vẫn đi bình thường');
    c.dispose();
  });
});

test('a draft tab survives Reload Window instead of being thrown away',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    c.registerSerializer({subscriptions:[]});
    assert.equal(v.serializers.length,1);
    // State webview của một tab chưa gửi tin: chỉ có định danh project, không có session.
    const panel:any={id:'devHub.chat',title:'',viewColumn:2,posted:[],handler:null,disposed:false,
      webview:{html:'',cspSource:'x',postMessage:(m:any)=>{panel.posted.push(m);return true},
        onDidReceiveMessage:(h:any)=>{panel.handler=h},asWebviewUri:(u:any)=>String(u)},
      reveal(){},dispose(){panel.disposed=true},onDidDispose:()=>{},onDidChangeViewState:()=>{}};
    await v.serializers[0].deserializeWebviewPanel(panel,{draft:{workspaceId:'w',projectId:'p',provider:'claude'},model:'sonnet'});
    assert.equal(panel.disposed,false,'tab draft không được vứt đi');
    const draft=panel.posted.find((m:any)=>m.type==='draftSelected');
    assert.ok(draft&&draft.draft.project.id==='p','phải dựng lại đúng project');
    assert.equal(panel.posted.filter((m:any)=>m.type==='optionsChanged').pop().model,'sonnet');
    c.dispose();
  });
});

test('a restored session disposed before lookup completes is ignored',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    let release!:()=>void;const waiting=new Promise<any>(resolve=>{release=()=>resolve(SESSION('restore'));});
    const c=new ChatPanelProvider({on:()=>()=>{}},{claude:{loadTranscript:async()=>[]}},LOOKUP,()=>{},()=>{},()=>{},'', '',async()=>waiting);
    c.registerSerializer({subscriptions:[]});const panel=serializerPanel();
    const restoring=v.serializers[0].deserializeWebviewPanel(panel,{provider:'claude',nativeSessionId:'restore'});
    await new Promise(r=>setTimeout(r,0));panel.dispose();release();await restoring;
    assert.deepEqual(panel.posted,[],'panel đã chết thì serializer không được dựng tab mới');
    c.dispose();
  });
});

test('a restored session disposed while its transcript loads does not post to a dead webview',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    let started=false;let release!:()=>void;const loading=new Promise<any[]>(resolve=>{release=()=>resolve([]);});
    const providers={claude:{loadTranscript:async()=>{started=true;return loading;}}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'', '',async()=>SESSION('restore'));
    c.registerSerializer({subscriptions:[]});const panel=serializerPanel();
    const restoring=v.serializers[0].deserializeWebviewPanel(panel,{provider:'claude',nativeSessionId:'restore'});
    for(let i=0;i<20&&!started;i++)await new Promise(r=>setTimeout(r,0));
    assert.equal(started,true,'serializer phải bắt đầu đọc transcript');
    panel.dispose();release();await restoring;
    assert.deepEqual(panel.posted,[],'không được post vào webview đã dispose');
    c.dispose();
  });
});

test('a queue the previous window left behind comes back as text, and is never auto-sent',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-queue-'));
    await fs.mkdir(path.join(dir,'devhub'),{recursive:true});
    // pid khác = do cửa sổ trước để lại. Cùng pid thì hàng chờ trong RAM mới là bản thật.
    await fs.writeFile(path.join(dir,'devhub','queues.json'),JSON.stringify({version:1,queues:{
      'sess:claude:a':{pid:process.pid+1,at:Date.now(),items:[{text:'chưa kịp gửi'}]}}}));
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    // manager không có `resume`: tự gửi lại là ném lỗi ngay, không im lặng đi qua.
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},dir);
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    const warn=panel.posted.filter((m:any)=>m.type==='event'&&m.event.type==='warning').map((m:any)=>m.event.message).join('\n');
    assert.match(warn,/chưa kịp gửi/,'chữ đã gõ phải quay lại được');
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='queue'&&m.items.length),[],'nhưng KHÔNG được xếp lại vào hàng chờ');
    const left=JSON.parse(await fs.readFile(path.join(dir,'devhub','queues.json'),'utf8'));
    assert.deepEqual(left.queues,{},'trả một lần rồi thôi, không dội lại mỗi lần mở');
    c.dispose();
  });
});

/**
 * Transcript của task planner là trạng thái sống: buffer đọc lúc task còn ANALYZING từng dính
 * mãi câu "no plan stored yet", nên bấm lại hàng đó sau khi plan xong vẫn ra tab cũ.
 */
test('a planner task tab re-reads the daemon on every open and keeps what was typed in it',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    let plan='no plan stored for KRP-1 yet';let reads=0;
    const providers={planner:{loadTranscript:async()=>{reads++;return [{type:'assistant_message',text:plan,timestamp:100}]},isAvailable:async()=>true}};
    const handlers:any={};
    const manager={on:(name:string,fn:any)=>{handlers[name]=fn;return ()=>{}},isBusy:()=>false};
    const task:any={provider:'planner',nativeSessionId:'task:KRP-1',workspaceId:'w',projectId:'p',cwd:'/tmp',
      title:'KRP-1 · ANALYZING',status:'imported',createdAt:1,updatedAt:1};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(task);
    // Hội thoại trong tab chỉ sống trong buffer của host — daemon không có endpoint đọc lại.
    handlers.event({provider:'planner',sessionId:'task:KRP-1',event:{type:'user_message',text:'hỏi thêm',timestamp:200}});
    plan='KRP-1 — plan v1';
    await c.openSession(task);
    assert.equal(reads,2,'mở lại phải đọc lại daemon, không dùng buffer cũ');
    const sel=v.panels[0].posted.filter((m:any)=>m.type==='sessionSelected').pop();
    assert.deepEqual(sel.events.map((e:any)=>e.text),['KRP-1 — plan v1','hỏi thêm'],
      'plan mới thay tiền tố lịch sử, tin nhắn đã gõ vẫn còn');
    c.dispose();
  });
});

test('a planner task tab is not re-read while a turn is running',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    let reads=0;
    const providers={planner:{loadTranscript:async()=>{reads++;return [{type:'assistant_message',text:'plan',timestamp:100}]},isAvailable:async()=>true}};
    const manager={on:()=>()=>{},isBusy:()=>true};
    const task:any={provider:'planner',nativeSessionId:'task:KRP-2',workspaceId:'w',projectId:'p',cwd:'/tmp',
      title:'KRP-2',status:'running',createdAt:1,updatedAt:1};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(task);
    await c.openSession(task);
    assert.equal(reads,1,'đang chạy thì buffer là nguồn duy nhất của event live');
    c.dispose();
  });
});

test('a claude transcript is still read once and served from the buffer after that',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    let reads=0;
    const providers={claude:{loadTranscript:async()=>{reads++;return [{type:'assistant_message',text:'hi',timestamp:1}]},isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    await c.openSession(SESSION('a'));
    assert.equal(reads,1,'transcript trên đĩa không đọc lại mỗi lần mở');
    c.dispose();
  });
});

test('a stop from outside the panel leaves its queue to flush on the cancelled event',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,{claude:{loadTranscript:async()=>[]}},LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    await v.panels[0].handler({type:'sendPrompt',text:'gửi tiếp sau khi stop'});
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(manager.resumed,[{text:'gửi tiếp sau khi stop',images:undefined}]);
    c.dispose();
  });
});
