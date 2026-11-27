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
      // VS Code fixes the real viewColumn after the panel shows; Beside(2) becomes column 2.
      const p:any={id,title,requested,viewColumn:requested,revealedIn:[] as any[],disposed:false,posted:[],handler:null,
        webview:{html:'',cspSource:'vscode-webview://x',postMessage:(m:any)=>{p.posted.push(m);return true},
          onDidReceiveMessage:(h:any)=>{p.handler=h},asWebviewUri:(u:any)=>'https://file+.vscode-resource/'+String(u)},
        reveal(c:any){p.revealedIn.push(c)},dispose(){p.disposed=true;p.onDispose&&p.onDispose()},
        onDidDispose:(f:any)=>{p.onDispose=f},onDidChangeViewState:()=>{}};
      panels.push(p);return p;}}}};
}
// `const vscode=require('vscode')` runs once at module load, so the cache must be cleared
// between tests — otherwise every panel falls into the first test's mock.
function freshProvider(){delete require.cache[require.resolve('../../src/devhub/views/chatPanelProvider')];
  return require('../../src/devhub/views/chatPanelProvider').ChatPanelProvider;}
async function withVscode(fn:(v:any,C:any)=>Promise<void>){
  const v=mockVscode();const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{await fn(v,freshProvider());}finally{Module._load=original;}
}
const SESSION=(id:string)=>({provider:'claude',nativeSessionId:id,workspaceId:'w',projectId:'p',cwd:'/tmp',title:'t',status:'done',createdAt:1,updatedAt:1});
/** Attachments are only valid inside the folder Dev Hub writes itself; the host refuses other paths. */
const ATT=(name:string)=>path.join(os.tmpdir(),'devhub','attachments',name);
const LOOKUP=async()=>({workspaces:[{id:'w',name:'WS',createdAt:1,updatedAt:1}],projects:[{id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp',createdAt:1,updatedAt:1}]});
// VS Code allows several listeners; the fake panel must keep them all to simulate dispose between awaits.
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
    assert.equal(v.panels.length,2,'two different sessions => two tabs');
    await c.openSession(SESSION('a'));
    assert.equal(v.panels.length,2,'reopening an old session => reuses the tab, no new one');
    c.dispose();
  });
});

test('tabs are no longer capped — every session keeps its own panel',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    for(let i=0;i<12;i++) await c.openSession(SESSION('s'+i));
    const alive=v.panels.filter((p:any)=>!p.disposed);
    assert.equal(alive.length,12,'no cap any more, saw '+alive.length);
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
    assert.ok(msg,'must send the path back to the webview');
    assert.equal(path.extname(msg.path),'.png');
    assert.deepEqual(await fs.readFile(msg.path),Buffer.from(png,'base64'),'file content must match the pasted image');
    c.dispose();
  });
});

test('image paste messages are validated before touching disk',()=>{
  const ok=parseWebviewMessage({type:'pasteImage',mime:'image/png',data:'aGk='});
  assert.deepEqual(ok,{type:'pasteImage',mime:'image/png',data:'aGk='});
  assert.equal(parseWebviewMessage({type:'pasteImage',mime:'text/html',data:'aGk='}),undefined,'rejects unknown mime');
  assert.equal(parseWebviewMessage({type:'pasteImage',mime:'image/png',data:'not base64!'}),undefined,'rejects broken base64');
  assert.equal(parseWebviewMessage({type:'pasteImage',mime:'image/png',data:'A'.repeat(13*1024*1024)}),undefined,'rejects oversize');
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
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(script),false,'content must not be built with innerHTML');
    assert.ok(script.includes("type:'pasteImage'"),'must have an image paste handler');
    assert.ok(html.includes('img-src  data:'),'without cspSource only data: remains, must not print undefined');
    assert.equal(/img-src[^;]*undefined/.test(html),false,'CSP must not contain the word undefined');
    const withSource=(c as any).html({cspSource:'vscode-resource://x'});
    assert.ok(withSource.includes("img-src vscode-resource://x data:;"),'images from disk load through the webview source');
    assert.equal(/default-src 'none'/.test(withSource),true,'the rest of the CSP is unchanged');
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
    assert.ok(/body\[data-provider="claude"\]\{--accent:#d97757/.test(html),'Claude must have its own accent');
    assert.ok(/body\[data-provider="planner"\]\{--accent:#8b7cf8/.test(html),'Planner must have its own accent');
    const script=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes("setAttribute('data-provider'"),'the script must set data-provider per provider');
    for(const id of ['model','effort','donut','arc','ctxtext','ctxtokens','ctxwrap','q5wrap','q5arc','q5text','q7wrap','q7arc','q7text','q5tip','q7tip','ctxtip'])assert.ok(html.includes('id="'+id+'"'),'missing control: '+id);
    // The `‹` button only ever showed on phones — exactly what the left-edge drawer now does.
    assert.ok(!html.includes('id="back"'),'the back button was removed, must not come back');
    assert.equal(html.includes('id="usage"'),false,'the old usage row duplicated the composerbar — removed');
    // At phone width: the quota label and context % give way, the % of the two limit rings stay.
    assert.ok(/#q5lab,#q7lab,#ctxtext,#ctxtokens\{display:none\}/.test(html),'narrow screens must hide the quota label and context %');
    assert.ok(html.includes('id="q5lab"')&&html.includes('id="q7lab"'),'the quota label must be its own span to be hideable');
    // One row at 390px only fits when every chip other than model is pinned `flex:none` — `.chip` has
    // `overflow:hidden` so the flex item's min-width is 0 and the whole row gets squeezed.
    assert.equal(/\.composerbar\{[^}]*flex-wrap/.test(html),false,'the composerbar must be one row on phones');
    assert.ok(/\.composerbar>\*\{flex:none\}/.test(html),'chips must keep their width');
    assert.ok(/#model\{flex:0 1 auto;min-width:0\}/.test(html),'the model name is the ONLY thing allowed to shrink');
    // A fixed `height` on the textarea + grow() measuring `height:auto` = the box grows while the keyboard slides
    // up, and WebKit cancels the present. Resting size comes from min-height, grow() measures content from 0.
    assert.equal(/textarea\{min-height:32px;height:/.test(html),false,'the input on phones must not have a fixed `height`');
    assert.equal(script.includes("style.height='auto'"),false,'grow() must not measure with `auto` — that is rows="3", not the content');
    assert.ok(script.includes("t.style.height='0px';contentH=t.scrollHeight"),'grow() must measure content from 0');
    assert.equal(html.includes('id="compact"'),false,'no separate compact button needed — the context ring already is one');
    for(const t of ['pickModel','pickEffort'])assert.ok(script.includes("type:'"+t+"'"),'missing message '+t);
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
    assert.equal(new Set(cols).size,1,'all three tabs must share one column, saw: '+JSON.stringify(cols));
    assert.ok(v.panels.every((p:any)=>p.revealedIn.every((x:any)=>x===cols[0])),'reveal must point at that same column too');
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

test('the chosen model/effort belongs to the session: closing and reopening the tab does not fall back to default',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    v.mock.window.showQuickPick=async(items:any[])=>items.find((i:any)=>i.value==='sonnet');
    let stored:any={...SESSION('c'),provider:'claude'};
    const manager:any={on:()=>()=>{},isBusy:()=>false,
      setTurnOptions:async(sess:any,o:any)=>{stored={...sess,...o};return stored;}};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(stored);
    await v.panels[0].handler({type:'pickModel'});
    assert.equal(stored.model,'sonnet','the picker must write the choice to the session, not only to the tab');
    // Close the tab then reopen that same session: the new tab must read the session's choice.
    v.panels[0].dispose();
    await c.openSession(stored);
    const opts=v.panels[v.panels.length-1].posted.filter((m:any)=>m.type==='optionsChanged').pop();
    assert.equal(opts.model,'sonnet','reopening must not fall back to devHub.claude.model');
    c.dispose();
  });
});

test('effort choices stay within what each CLI accepts',()=>{
  const pkg=JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.cwd(),'package.json'),'utf8'));
  const claude=pkg.contributes.configuration.properties['devHub.claude.effort'].enum;
  assert.ok(claude.includes('max'),'Claude has --effort max');
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
    assert.equal(/Default model|Default effort/.test(script),false,'must not show the word Default');
    assert.ok(script.includes("state.model||'auto'"),'empty shows auto');
    assert.ok(html.includes('title="Thinking effort"'),'the effort chip must explain itself with a tooltip');
    assert.ok(html.includes('title="Model"'),'the model chip must explain itself with a tooltip');
    assert.equal(/\\u[0-9a-f]{4}[0-9]/.test(script),false,'no wrongly written non-BMP unicode escapes');
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
      'optionsChanged must come after sessionSelected, otherwise model/effort get overwritten: '+kinds.join(','));
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
      assert.ok(i>0,'missing branch '+kind);
      const branch=script.slice(i,i+260);
      assert.ok(branch.includes('model:state.model')&&branch.includes('effort:state.effort'),
        kind+' must keep model/effort instead of overwriting state');
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
    assert.ok(script.includes('createElementNS'),'must build inline SVG');
    assert.ok(/MARK=\{claude:'M[^']{200,}'/.test(script),'the logo path must be embedded');
    // empty localResourceRoots => every file reference in the webview dies
    assert.equal(/media\/[a-z-]+\.svg/.test(html),false,'the webview must not point at an svg file');
    assert.equal(/<img/.test(html),false,'no <img>');
    c.dispose();
  }finally{Module._load=original;}
});

test('chat turns carry no You/Claude label — border and colour say who spoke',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=freshProvider()&&new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.equal(/label='You'/.test(script),false,'no You label any more');
    const ua=script.slice(script.indexOf("e.type==='user_message'"),script.indexOf("e.type==='tool_started'"));
    assert.equal(/label=providerName/.test(ua),false,'user/assistant get no provider label');
    // Labels on tool/command/error must stay — they are information, not identity.
    assert.ok(script.includes("label='Error'")&&script.includes("label='Warning'"),'keep labels for warning/error');
    assert.ok(script.includes("el('span','tname'"),'tool/command use a one-line row instead of a label');
    assert.ok(script.includes('if(label)d.insertBefore'),'meta is only inserted when there is a label');
  }finally{Module._load=original;}
});

test('a chat tab is titled by project alone and carries the brand icon',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','/MEDIA');
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    await panel.handler({type:'ready'});
    assert.equal(panel.title,'Proj','the title is just the project name');
    assert.equal(/Claude/.test(panel.title),false,'the provider name must not be in the title');
    assert.ok(panel.iconPath&&panel.iconPath.light&&panel.iconPath.dark,'must set iconPath');
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
      assert.ok(html.includes('id="'+id+'"'),'missing '+id);
    assert.ok(/@keyframes spin/.test(html),'must have a spin animation');
    assert.ok(/prefers-reduced-motion/.test(html),'must respect reduced-motion');
    assert.ok(/WORDS=\['Cooking','Vibing'/.test(script),'must have a verb list');
    assert.ok(script.includes('startThinking()')&&script.includes('stopThinking()'),'must toggle with status');
    assert.ok(/if\(running\)startThinking\(\);else stopThinking\(\)/.test(script),'tied to the running status');
    assert.ok(script.includes("sp.appendChild(mark(p))"),'the spinner uses the brand logo');

    // The composer must be ONE frame wrapping the attachments, the input and the toolbar
    const box=html.indexOf('class="composer-box"');
    assert.ok(box>0,'missing composer-box');
    for(const id of ['attachments','input','model','effort','send'])
      assert.ok(html.indexOf('id="'+id+'"')>box,id+' must be inside composer-box');
    assert.ok(/\.composer-box:focus-within\{border-color:var\(--accent\)/.test(html),'focus must light the accent border');
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
    assert.ok(msg,'must push the request to the webview');
    assert.equal(msg.request.requestId,'r1');

    await panel.handler({type:'permissionResponse',requestId:'r1',allow:false});
    assert.deepEqual(answered.pop(),{prov:'claude',sid:'a',rid:'r1',allow:false});

    // No tab open -> must deny right away, never leave the CLI hanging forever
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
    assert.ok(script.includes("x.type==='permission'"),'must receive the permission message');
    assert.ok(script.includes("el('button','allow','Allow')")&&script.includes("el('button','deny','Deny')"));
    assert.ok(script.includes("type:'permissionResponse'"),'must send the decision back');
    assert.ok(/\.perm\.answered \.pacts\{display:none\}/.test(html),'buttons must lock once answered');
  }finally{Module._load=original;}
});

test('pasted images show a thumbnail chip and their paths ride along on send, not in the box',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes("img.src=a.thumb"),'the chip must have a thumbnail');
    assert.ok(script.includes("naturalWidth"),'must measure the image size');
    assert.ok(script.includes("pending.filter(a=>a.path).map(a=>a.path)"),'path joined at send time');
    assert.equal(/t\.value=\(t\.value\?/.test(script),false,'the path must no longer be stuffed into the input');
    assert.ok(script.includes("el('button','attx'"),'the chip must have a remove button');
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

    // answering twice -> only the first counts
    c.showPermission('claude','a',{requestId:'r1',toolName:'Bash',input:{}});
    await panel.handler({type:'permissionResponse',requestId:'r1',allow:true});
    await panel.handler({type:'permissionResponse',requestId:'r1',allow:false});
    assert.equal(answered.filter(x=>x.rid==='r1').length,1,'must not answer twice');
    assert.equal(answered[0].allow,true);

    // closing the tab while waiting -> must DENY, otherwise the CLI hangs forever
    c.showPermission('claude','a',{requestId:'r2',toolName:'Bash',input:{}});
    panel.dispose();
    assert.deepEqual(answered.pop(),{sid:'a',rid:'r2',allow:false});

    // disposing the whole provider must clean up too
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
    // One missing id makes the script throw and no later listener gets attached (Enter dies).
    assert.deepEqual(missing,[],'the script calls $() on a nonexistent id: '+missing.join(', '));
    assert.ok(used.length>10,'must actually scan something, only saw '+used.length);
  }finally{Module._load=original;}
});

test('Enter sends and Shift+Enter does not',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(/e\.key==='Enter'&&!e\.shiftKey/.test(script),'missing the Enter condition');
    assert.ok(/preventDefault\(\);send\(\)/.test(script),'Enter must block the newline then send');
    // listeners wrapped in on() so one missing element doesn't kill the whole script
    assert.ok(script.includes("const on=(id,ev,fn)=>"),'must have a defensive on() helper');
    assert.equal(/\$\('[a-z]+'\)\.onclick=/.test(script),false,'no direct onclick assignment any more');
  }finally{Module._load=original;}
});

test('the slash chip only appears for a provider that advertises commands',()=>{
  const original=Module._load;const v=mockVscode();
  Module._load=function(r:string){if(r==='vscode')return v.mock;return original.apply(this,arguments as any);};
  try{
    const script=new (freshProvider())({on:()=>()=>{}},{},LOOKUP,()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    assert.ok(script.includes('state.slash=!!x.slash'),'must receive the slash flag');
    assert.ok(/sl\.hidden=!state\.slash/.test(script),'no commands hides the button');
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
    // `+` from inside a session: must open a draft tab right away, NOT ask for the project again —
    // asking again is why "can't add a chat while chatting".
    await v.panels[0].handler({type:'newTab'});
    assert.equal(asked,false,'must not ask for the project');
    assert.equal(v.panels.length,before+1,'must have a new tab');
    const fresh=v.panels[v.panels.length-1];
    const draft=fresh.posted.find((m:any)=>m.type==='draftSelected');
    assert.ok(draft,'the new tab must be a draft ready for input');
    assert.equal(draft.draft.project.name,'Proj','same open project');
    assert.equal(draft.draft.provider,'claude','same provider');
    c.dispose();
  });
});

test('the history chip lists only this project, newest first, after a rescan',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    let rescans=0;
    const stored=[
      {...SESSION('old'),title:'old session',updatedAt:1000},
      {...SESSION('new'),title:'new session',updatedAt:9000},
      {...SESSION('other'),projectId:'zzz',title:'other project',updatedAt:9999},
    ];
    let items:any[]=[];
    v.mock.window.showQuickPick=async(list:any[])=>{items=list;return list[0];};
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},'','',
      async()=>undefined,()=>{},async()=>stored,async()=>{rescans++;});
    await c.openSession(SESSION('a'));
    await v.panels[0].handler({type:'pickHistory'});
    // Sessions opened from a terminal only enter the store on a rescan; without one the list is a stale snapshot.
    assert.equal(rescans,1,'must rescan history before listing');
    assert.deepEqual(items.map((i:any)=>i.label),['new session','old session'],'only the open project, newest first');
    // Picking a row = open exactly that session in its own tab.
    const opened=v.panels[v.panels.length-1].posted.find((m:any)=>m.type==='sessionSelected');
    assert.equal(opened.session.nativeSessionId,'new');
    c.dispose();
  });
});

test('every chat block starts at the same left edge',()=>{
  const css=require('node:fs').readFileSync('media/webview/chat.css','utf8');
  /** The body of a CSS rule, looked up by string instead of regex so selectors needn't be escaped. */
  const body=(sel:string)=>{
    const at=css.indexOf('\n'+sel+'{');
    assert.ok(at>=0,'missing rule '+sel);
    return css.slice(at+sel.length+2,css.indexOf('}',at));
  };
  const px=(text:string,prop:string,fallback:number)=>{
    const m=new RegExp('(?:^|;)'+prop+':(\\d+)px').exec(text);
    return m?Number(m[1]):fallback;
  };
  const MAIN=px(body('main'),'padding',-1);
  assert.equal(MAIN,12,'main padding');
  const MSG_SIDE=9;   // .msg{padding:6px 9px}
  assert.ok(/padding:6px 9px/.test(body('.msg')),'.msg is still padding:6px 9px');
  assert.match(body('.user'),/background:color-mix\(in srgb,var\(--vscode-input-background\) 78%,var\(--vscode-editor-foreground\) 22%\)/,
    'user must have a background different from code');
  assert.match(body('.user'),/box-shadow:inset 3px 0 0 var\(--vscode-contrastActiveBorder,var\(--accent\)\)/,
    'user must have a left bar so it does not rely on telling colours apart');

  // The common edge of every block must line up: main + left border + left padding.
  const inset=(sel:string,border:number)=>MAIN+border+px(body(sel),'padding-left',MSG_SIDE);
  assert.equal(inset('.user',1),23,'user bubble');
  assert.equal(inset('.assistant',0),23,'agent text — previously padding-left:0 so it was indented 11px');
  assert.equal(inset('.tool,.command',2),23,'tool/command');
  assert.equal(inset('.file',2),23,'file row');
  assert.equal(inset('.warning',2),23,'warning');
  assert.equal(inset('.error',2),23,'error');
  // .perm uses `padding:8px 10px` so the horizontal value is the SECOND one.
  const permSide=/padding:\d+px (\d+)px/.exec(body('.perm'));
  assert.ok(permSide,'.perm must declare two-axis padding');
  assert.equal(MAIN+1+Number(permSide![1]),23,'permission card');
});

/** A fake manager just enough to close/open a turn: keeps the sessionUpdated handler so the test can fire it. */
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
/** The queue carries the image count; most tests only care about the text. */
const queueTexts=(panel:any)=>lastQueue(panel).items.map((i:any)=>i.text);

test('a message typed mid-turn is queued, not dropped, and flushes in order when the turn ends',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    const panel=v.panels[0];

    panel.handler({type:'sendPrompt',text:'one'});
    panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    assert.deepEqual(manager.resumed,[],'nothing is sent while running');
    assert.deepEqual(lastQueue(panel),{type:'queue',items:[{text:'one',images:0},{text:'hai',images:0}]});

    // Turn done -> flush exactly one message, the rest stays queued.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['one']);
    assert.deepEqual(queueTexts(panel),['hai'],'only one message per turn');

    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['one','hai']);
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
    panel.handler({type:'sendPrompt',text:'keep me'});
    await tick();

    manager.failNext('claude executable not found');
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(queueTexts(panel),['keep me'],'a failed send goes back to the head of the queue');
    assert.ok(panel.posted.some((p:any)=>p.event?.type==='error'),'and must report the error to the tab');

    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['keep me'],'can be resent next time');
    c.dispose();
  });
});

test('a queued message keeps its attachments',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    v.panels[0].handler({type:'sendPrompt',text:'look at the image',attachments:[ATT('a.png')]});
    await tick();
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'look at the image',images:[ATT('a.png')]}]);
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
    panel.handler({type:'sendPrompt',text:'one'});
    panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    panel.handler({type:'dequeue',index:0});
    await tick();
    assert.deepEqual(queueTexts(panel),['hai']);
    manager.emit('sessionUpdated',{...SESSION('a'),status:'done'});
    await tick();
    assert.deepEqual(manager.resumed.map((r:any)=>r.text),['hai'],'a deleted message must not be sent');
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

    // The webview reloads (tab hidden, VS Code rebuilds the DOM) -> renderAll wipes the question cards.
    panel.posted.length=0;
    await panel.handler({type:'ready'});
    const replayed=panel.posted.filter((m:any)=>m.type==='permission');
    assert.equal(replayed.length,1,'a pending request must be resent');
    assert.equal(replayed[0].request.requestId,'q1');
    assert.equal(answered.length,0,'no silent deny while nobody has answered');

    // Once answered it no longer pends: the next render doesn't resend it.
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
    assert.equal(answered.length,1,'no tab means deny so the CLI does not hang');
    assert.equal(answered[0][3],false);
    assert.equal(v.warnings.length,1,'a silent deny must leave a trace');
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

    // Turn cancelled: the CLI no longer waits, so the card must be locked and the request cleaned up.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    const closed=panel.posted.filter((m:any)=>m.type==='permissionClosed');
    assert.equal(closed.length,1,'the webview must be told the card is dead');
    assert.equal(closed[0].requestId,'q1');
    assert.equal(answered.length,1,'still deny so the CLI never hangs');
    assert.equal(answered[0][3],false);

    panel.posted.length=0;
    await panel.handler({type:'ready'});
    assert.equal(panel.posted.filter((m:any)=>m.type==='permission').length,0,'no replay of dead cards');
    assert.equal(v.warnings.length,0,'and no "expired" warning');
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
    // The layout belongs to the user: opening a tab or reopening one must never touch the sidebar.
    await c.openSession(SESSION('a'));
    await c.openSession(SESSION('b'));
    assert.deepEqual(v.commands,[],'no automatic closeSidebar anywhere');
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
    // Only becomes a URI at send time; what sits in the host cache is still the short path.
    assert.equal(img.src,'https://file+.vscode-resource/'+p);
    assert.equal(img.path,p,'the path is still there so the next send can convert again');
    assert.equal(JSON.stringify(img).includes('base64'),false,'no bytes travel over postMessage');
    c.dispose();
  });
});

test('an attached image survives with no typed text, and reaches the webview as a URI',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[{type:'user_message',text:'',images:[ATT('a.png')],timestamp:1}],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));
    // Image only, no text: previously `if(!text)return` swallowed the message, no error, no queue.
    await v.panels[0].handler({type:'sendPrompt',text:'   ',attachments:[ATT('a.png')]});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'',images:[ATT('a.png')]}]);
    const selected=v.panels[0].posted.find((m:any)=>m.type==='sessionSelected');
    const um=selected.events.find((e:any)=>e.type==='user_message');
    assert.deepEqual(um.imageSrcs,['https://file+.vscode-resource/'+ATT('a.png')]);
    assert.deepEqual(um.images,[ATT('a.png')],'the cache keeps the path, not one tab\'s URI');
    c.dispose();
  });
});

test('a session the manager still holds is queued for, not resumed into',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));   // status 'done'
    // Stop writes 'cancelled' right away, but the stream hasn't drained so the manager still holds the session.
    manager.setBusy(true);
    await v.panels[0].handler({type:'sendPrompt',text:'sent right after pressing Stop'});
    await tick();
    assert.deepEqual(manager.resumed,[],'must not call resume while the manager still holds the turn');
    assert.equal(v.panels[0].posted.some((m:any)=>m.type==='error'),false,'and must not print an error');
    assert.deepEqual(queueTexts(v.panels[0]),['sent right after pressing Stop']);
    // sessionUpdated while busy must not pull the message out of the queue only to fail.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    assert.deepEqual(manager.resumed,[]);
    assert.deepEqual(queueTexts(v.panels[0]),['sent right after pressing Stop'],'the message stays put');
    // Drained: the final sessionUpdated is when sending works.
    manager.setBusy(false);
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'sent right after pressing Stop',images:undefined}]);
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
    await panel.handler({type:'sendPrompt',text:'one'});
    await panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    assert.deepEqual(queueTexts(panel),['one','hai']);
    await panel.handler({type:'cancel'});
    await tick();
    assert.equal(manager.cancels(),1,'must still cancel the running turn');
    assert.deepEqual(queueTexts(panel),['one','hai'],'Stop only kills the turn, typed text stays');
    assert.deepEqual(manager.resumed,[],'nothing is sent until drained');
    // Drained: the head of the queue runs next, in the order typed.
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await tick();
    assert.deepEqual(manager.resumed,[{text:'one',images:undefined}]);
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
    // withImages prepends the paths to the prompt, so a re-read transcript only has a few bare path lines.
    const providers={claude:{isAvailable:async()=>true,
      loadTranscript:async()=>[{type:'user_message',text:`${a}\nlook at this image for me`,timestamp:1},
                               {type:'user_message',text:'/etc/passwd\nnot my image',timestamp:2}]}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},dir);
    await c.openSession(SESSION('a'));
    const selected=v.panels[0].posted.find((m:any)=>m.type==='sessionSelected');
    const [first,second]=selected.events;
    assert.deepEqual(first.images,[a]);
    assert.equal(first.text,'look at this image for me','the path lines must be split off the text');
    assert.deepEqual(first.imageSrcs,['https://file+.vscode-resource/'+a]);
    assert.equal(second.images,undefined,'paths outside the attachment folder must not be touched');
    assert.equal(second.text,'/etc/passwd\nnot my image');
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
    await panel.handler({type:'sendPrompt',text:'one'});
    await tick();
    assert.deepEqual(started,[],'a failed start means nothing ran yet');
    assert.deepEqual(queueTexts(panel),['one'],'the failed message must go back to the head of the queue');
    await panel.handler({type:'sendPrompt',text:'hai'});
    await tick();
    assert.deepEqual(started,['one'],'the old message runs first, no skipping ahead');
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
    await v.panels[0].handler({type:'sendPrompt',text:'go'});
    await tick();
    // Reopening a session: events come from the host's buffer, so the error must be there.
    await c.openSession(SESSION('a'));
    const selected=[...v.panels[0].posted].reverse().find((m:any)=>m.type==='sessionSelected');
    const err=selected.events.find((e:any)=>e.type==='error');
    assert.ok(err,'the error must be in the transcript');
    assert.equal(err.message,'Claude executable not found');
    c.dispose();
  });
});

test('a live event that lands while history is loading is not wiped by the history',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    let release:(v?:any)=>void=()=>{};
    const gate=new Promise(r=>{release=r as any});
    const providers={claude:{isAvailable:async()=>true,
      // Slow transcript read: exactly the window where a live event lands in the cache and gets wiped by `set()`.
      loadTranscript:async()=>{await gate;return [{type:'user_message',text:'old',timestamp:1000}]}}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    const opening=c.openSession({...SESSION('a'),status:'running'});
    await tick();
    manager.emit('event',{provider:'claude',sessionId:'a',event:{type:'assistant_message',text:'new',timestamp:5000}});
    release();
    await opening;
    const selected=[...v.panels[0].posted].reverse().find((m:any)=>m.type==='sessionSelected');
    assert.deepEqual(selected.events.map((e:any)=>e.text),['old','new'],
      'history goes before live events, it does not replace them');
    c.dispose();
  });
});

test('a send that the manager refuses gives the typed text and its images back',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession(SESSION('a'));   // 'done' => the direct resume path
    const panel=v.panels[0];
    manager.failNext('Claude executable not found');
    await panel.handler({type:'sendPrompt',text:'look at the image',attachments:[ATT('a.png')]});
    await tick();
    assert.deepEqual(queueTexts(panel),['look at the image'],'typed text must go back to the queue');
    assert.equal(lastQueue(panel).items[0].images,1,'and the attached image goes with it');
    assert.ok(panel.posted.some((m:any)=>m.type==='error'||m.event?.type==='error'),'must still say the send failed');
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
        // sessionManager emits the user's message right at start, with the image paths.
        manager.emit('event',{provider:'claude',sessionId:'new',event:{type:'user_message',text:input.prompt,images:input.images,timestamp:1}});
        return {...SESSION('new'),status:'running'};}};
    const c=new ChatPanelProvider(manager,providers,LOOKUP,()=>{},()=>{},()=>{});
    await c.newChat({id:'w',name:'WS'},{id:'p',workspaceId:'w',name:'Proj',rootPath:'/tmp'},'claude');
    const panel=v.panels[0];
    await panel.handler({type:'sendPrompt',text:'look at the image',attachments:[ATT('a.png')]});
    await tick();
    const selected=[...panel.posted].reverse().find((m:any)=>m.type==='sessionSelected');
    const um=selected.events.find((e:any)=>e.type==='user_message');
    assert.deepEqual(um.imageSrcs,['https://file+.vscode-resource/'+ATT('a.png')],
      'the session-creating branch must also turn paths into webview URIs');
    c.dispose();
  });
});

test('an image that only exists as a data uri is passed through, not turned into a file uri',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const src='data:image/png;base64,aGk=';
    const providers={claude:{isAvailable:async()=>true,
      loadTranscript:async()=>[{type:'user_message',text:'here is the image',images:[src],timestamp:1}]}};
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
    // `!!x.slash` in the webview: a post missing the flag makes the `/` button vanish until the next postOptions.
    const opts=panel.posted.filter((m:any)=>m.type==='optionsChanged');
    assert.equal(opts[opts.length-1].model,'sonnet');
    assert.equal(opts[opts.length-1].slash,true,'changing model must not swallow the slash button');
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
    await panel.handler({type:'sendPrompt',text:'one'});
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='queue').pop().items.map((i:any)=>i.text),['one'],
      'a failed send must keep the text');
    // No sessionUpdated follows a failed resume, so if `queue.length` blocks the send path
    // the tab becomes write-only: every later message just piles up.
    fail=false;
    await panel.handler({type:'sendPrompt',text:'hai'});
    assert.deepEqual(resumed,['one','one'],'the old message must be resent first');
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='queue').pop().items.map((i:any)=>i.text),['hai'],
      'the new message goes to the end, in the order typed');
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
    // `attachments` go straight into the prompt (Claude); the shared validator only
    // knows "absolute path", so the root must be pinned in the host.
    await panel.handler({type:'sendPrompt',text:'read it for me',attachments:['/etc/passwd']});
    assert.deepEqual(resumed,[],'no turn may be sent');
    const shown=panel.posted.filter((m:any)=>m.type==='event').map((m:any)=>m.event.message).join('\n');
    assert.match(shown,/Refused an attachment/,'must say it was refused');
    await panel.handler({type:'sendPrompt',text:'real image',attachments:[ATT('ok.png')]});
    assert.deepEqual(resumed,[[ATT('ok.png')]],'images in the attachment folder still go through normally');
    c.dispose();
  });
});

test('a draft tab survives Reload Window instead of being thrown away',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{});
    c.registerSerializer({subscriptions:[]});
    assert.equal(v.serializers.length,1);
    // Webview state of a tab that hasn't sent anything: only project identity, no session.
    const panel:any={id:'devHub.chat',title:'',viewColumn:2,posted:[],handler:null,disposed:false,
      webview:{html:'',cspSource:'x',postMessage:(m:any)=>{panel.posted.push(m);return true},
        onDidReceiveMessage:(h:any)=>{panel.handler=h},asWebviewUri:(u:any)=>String(u)},
      reveal(){},dispose(){panel.disposed=true},onDidDispose:()=>{},onDidChangeViewState:()=>{}};
    await v.serializers[0].deserializeWebviewPanel(panel,{draft:{workspaceId:'w',projectId:'p',provider:'claude'},model:'sonnet'});
    assert.equal(panel.disposed,false,'a draft tab must not be thrown away');
    const draft=panel.posted.find((m:any)=>m.type==='draftSelected');
    assert.ok(draft&&draft.draft.project.id==='p','must rebuild the right project');
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
    assert.deepEqual(panel.posted,[],'a dead panel means the serializer must not build a new tab');
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
    assert.equal(started,true,'the serializer must start reading the transcript');
    panel.dispose();release();await restoring;
    assert.deepEqual(panel.posted,[],'must not post into a disposed webview');
    c.dispose();
  });
});

test('a queue the previous window left behind comes back as text, and is never auto-sent',async()=>{
  await withVscode(async (v,ChatPanelProvider)=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-queue-'));
    await fs.mkdir(path.join(dir,'devhub'),{recursive:true});
    // A different pid = left over by a previous window. Same pid means the in-RAM queue is the real one.
    await fs.writeFile(path.join(dir,'devhub','queues.json'),JSON.stringify({version:1,queues:{
      'sess:claude:a':{pid:process.pid+1,at:Date.now(),items:[{text:'not sent yet'}]}}}));
    const providers={claude:{loadTranscript:async()=>[],isAvailable:async()=>true}};
    // The manager has no `resume`: an automatic resend throws right away instead of passing silently.
    const c=new ChatPanelProvider({on:()=>()=>{}},providers,LOOKUP,()=>{},()=>{},()=>{},dir);
    await c.openSession(SESSION('a'));
    const panel=v.panels[0];
    const warn=panel.posted.filter((m:any)=>m.type==='event'&&m.event.type==='warning').map((m:any)=>m.event.message).join('\n');
    assert.match(warn,/not sent yet/,'typed text must be handed back');
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='queue'&&m.items.length),[],'but must NOT be re-queued');
    const left=JSON.parse(await fs.readFile(path.join(dir,'devhub','queues.json'),'utf8'));
    assert.deepEqual(left.queues,{},'handed back once only, not echoed on every open');
    c.dispose();
  });
});

/**
 * A planner task transcript is live state: a buffer read while the task was still ANALYZING used to stick
 * on "no plan stored yet" forever, so clicking that row again after the plan was done still showed the old tab.
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
    // The conversation in the tab only lives in the host's buffer — the daemon has no endpoint to read it back.
    handlers.event({provider:'planner',sessionId:'task:KRP-1',event:{type:'user_message',text:'follow-up question',timestamp:200}});
    plan='KRP-1 — plan v1';
    await c.openSession(task);
    assert.equal(reads,2,'reopening must re-read the daemon, not use the old buffer');
    const sel=v.panels[0].posted.filter((m:any)=>m.type==='sessionSelected').pop();
    assert.deepEqual(sel.events.map((e:any)=>e.text),['KRP-1 — plan v1','follow-up question'],
      'a new plan replaces the history prefix, typed messages stay');
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
    assert.equal(reads,1,'while running the buffer is the only source of live events');
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
    assert.equal(reads,1,'the transcript on disk is not re-read on every open');
    c.dispose();
  });
});

test('a stop from outside the panel leaves its queue to flush on the cancelled event',async()=>{
  await withVscode(async(v,ChatPanelProvider)=>{
    const manager=queueManager();
    const c=new ChatPanelProvider(manager,{claude:{loadTranscript:async()=>[]}},LOOKUP,()=>{},()=>{},()=>{});
    await c.openSession({...SESSION('a'),status:'running'});
    await v.panels[0].handler({type:'sendPrompt',text:'send again after stop'});
    manager.emit('sessionUpdated',{...SESSION('a'),status:'cancelled'});
    await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(manager.resumed,[{text:'send again after stop',images:undefined}]);
    c.dispose();
  });
});
