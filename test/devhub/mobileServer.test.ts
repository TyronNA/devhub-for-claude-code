export {};
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const nodeFs=require('node:fs');const nodeOs=require('node:os');const nodePathT=require('node:path');
const {EventEmitter}=require('node:events');

/**
 * The mobile server speaks `chat.js`'s exact protocol over SSE + POST. Tests go over real HTTP:
 * one wrong message freezes the phone, and a unit test calling methods directly can't
 * see that.
 */
const VSCODE={workspace:{getConfiguration:()=>({get:(_k:string,d:any)=>d})}};
const PASSCODE='2468';
/** The only door is now the keypad; the cookie comes from here instead of the removed `?t=`. */
async function login(base:string,code=PASSCODE){
  const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  return {status:r.status,cookie:String(r.headers.get('set-cookie')||'').split(';')[0]};
}
function freshServer(){
  for(const m of ['../../src/devhub/web/mobileServer','../../src/devhub/views/chatPanelProvider'])
    delete require.cache[require.resolve(m)];
  return require('../../src/devhub/web/mobileServer').MobileServer;
}
async function withServer(fn:(ctx:any)=>Promise<void>,bindLan=true,customize?:(ctx:any)=>void){
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return VSCODE;return original.apply(this,arguments as any);};
  const MobileServer=freshServer();
  const em=new EventEmitter();
  const session:any={provider:'claude',nativeSessionId:'s1',workspaceId:'w1',projectId:'p1',cwd:'/tmp',title:'hello',status:'done',createdAt:1,updatedAt:Date.now()};
  const calls:any={};
  const manager:any={
    on:(n:string,f:any)=>{em.on(n,f);return()=>em.off(n,f);},
    isBusy:()=>false,
    resume:async(s:any,text:string)=>{calls.turn={kind:'resume',text};
      em.emit('event',{provider:'claude',sessionId:'s1',event:{type:'user_message',text,timestamp:Date.now()}});
      return {...s,status:'running'};},
    start:async(i:any)=>{calls.turn={kind:'start',input:i};return {...session,nativeSessionId:'s2',title:i.prompt};},
    cancel:async()=>{},updateUsage:async(s:any,u:any)=>({...s,usage:{...s.usage,...u}}),withSessionLock:async(_s:any,f:any)=>f(),
    setTurnOptions:async(s:any,o:any)=>{calls.turnOptions={id:s.nativeSessionId,...o};return {...s,...o};},
  };
  const codexSession:any={...session,provider:'codex',nativeSessionId:'c1',title:'codex chat'};
  let transcript:any[]=[{type:'assistant_message',text:'old turn',timestamp:1}];
  const providers:any={
    claude:{id:'claude',loadTranscript:async()=>transcript,slashCommands:()=>['compact','review']},
    codex:{id:'codex',loadTranscript:async()=>[]}};
  const storageDir=nodeFs.mkdtempSync(nodePathT.join(nodeOs.tmpdir(),'devhub-mobile-'));
  const answered:any[]=[];
  const deps:any={manager,providers,passcode:()=>PASSCODE,
    lookup:async()=>({workspaces:[{id:'w1',name:'WS',createdAt:1,updatedAt:1}],
                      projects:[{id:'p1',workspaceId:'w1',name:'proj',rootPath:'/tmp',createdAt:1,updatedAt:1}]}),
    listSessions:async()=>[session],
    findSession:async(_p:string,id:string)=>(id==='s1'?session:id==='c1'?codexSession:undefined),
    answerPermission:(...a:any[])=>answered.push(a),
    storageDir};
  customize?.({deps,manager,session,codexSession,em,calls});
  const srv=new MobileServer(deps);
  const {port,token}=await srv.start(0,bindLan);
  const base=`http://127.0.0.1:${port}`;
  try{
    const signed=await login(base);
    assert.equal(signed.status,204,'the right passcode must return a cookie');
    const headers={cookie:signed.cookie};
    const page=await fetch(base+'/',{headers});
    await fn({srv,base,token,headers,em,calls,answered,session,storageDir,
      setTranscript:(rows:any[])=>{transcript=rows;},html:await page.text()});
  } finally { srv.dispose(); Module._load=original; }
}
/** Reads SSE like a browser and lets the test wait for exactly the message it needs. */
async function stream(base:string,headers:any){
  const res:any=await fetch(base+'/api/stream',{headers});
  const reader=res.body.getReader();const dec=new TextDecoder();let buf='';const msgs:any[]=[];
  void (async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true});let i;
    while((i=buf.indexOf('\n\n'))>=0){const chunk=buf.slice(0,i);buf=buf.slice(i+2);
      for(const line of chunk.split('\n'))if(line.startsWith('data: '))msgs.push(JSON.parse(line.slice(6)));}}}catch{}})();
  const wait=(pred:any,ms=4000)=>new Promise<any>((ok,no)=>{const t0=Date.now();
    const iv=setInterval(()=>{const m=msgs.find(pred);
      if(m){clearInterval(iv);ok(m);}else if(Date.now()-t0>ms){clearInterval(iv);no(new Error('timed out waiting for an SSE message'));}},10);});
  const hello=await wait((m:any)=>m.type==='hello');
  const post=(m:any)=>fetch(base+'/api/msg?c='+hello.clientId,
    {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(m)});
  return {msgs,wait,post,clientId:hello.clientId,cancel:()=>reader.cancel().catch(()=>{})};
}

test('the page is served only to a caller holding the token',async()=>{
  await withServer(async({base,html,srv,token})=>{
    // Not signed in means the root page is the keypad, not the chat: none of chat.js's ids.
    const gate=await fetch(base+'/');
    assert.equal(gate.status,200);
    const gateHtml=await gate.text();
    assert.ok(!gateHtml.includes('id="messages"')&&!gateHtml.includes('id="input"'),gateHtml.slice(0,200));
    // `?t=` is gone for good: even a correct token in the URL opens nothing any more.
    assert.equal((await fetch(base+'/api/sessions?t='+encodeURIComponent(token))).status,401);
    // Same id set as the panel — `chat.js` looks them up with getElementById.
    assert.ok(html.includes('id="messages"')&&html.includes('id="input"'));
    // the bridge must come before chat.js: chat.js calls acquireVsCodeApi() on its first line.
    assert.ok(html.indexOf('/assets/bridge.js')<html.indexOf('/assets/chat.js'));
    assert.ok(srv.address().port>0);
  });
});

test('the page carries a CSP that only allows what it actually loads',async()=>{
  await withServer(async({base,headers})=>{
    const csp=(await fetch(base+'/',{headers})).headers.get('content-security-policy')||'';
    assert.match(csp,/default-src 'none'/);
    // Every asset/API of the page is same-origin; `'unsafe-inline'` would reopen exactly the door
    // the panel closed, and `data:` is only allowed for images.
    assert.ok(!csp.includes("'unsafe-inline'"),csp);
    for(const d of ["script-src 'self'","style-src 'self'","connect-src 'self'","img-src 'self' data:"])
      assert.ok(csp.includes(d),d+' missing from '+csp);
  });
});

test('with no passcode set the server refuses to serve at all',async()=>{
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return VSCODE;return original.apply(this,arguments as any);};
  try{
    const MobileServer=freshServer();
    const dir=nodeFs.mkdtempSync(nodePathT.join(nodeOs.tmpdir(),'devhub-nopass-'));
    // Dropping `?t=` while allowing an empty passcode puts an unlocked shell on the Wi-Fi.
    for(const code of ['','12','abcd']){
      const srv=new MobileServer({manager:{on:()=>()=>{}} as any,providers:{},lookup:async()=>({workspaces:[],projects:[]}),
        listSessions:async()=>[],findSession:async()=>undefined,answerPermission:()=>{},storageDir:dir,passcode:()=>code});
      await assert.rejects(()=>srv.start(0,true),/passcode/,'passcode "'+code+'" must be rejected');
      assert.equal(srv.address(),undefined,'once rejected no port may stay open');
      srv.dispose();
    }
  } finally { Module._load=original; }
});

test('the keypad gate hands out a cookie for the right code and nothing else',async()=>{
  await withServer(async({base,headers})=>{
    const gate=await (await fetch(base+'/')).text();
    // Deliberately no `<input>`: in an iOS PWA a text field can't be focused, buttons can be tapped.
    assert.ok(!/<input/i.test(gate),'the keypad must contain no input');
    assert.ok(/id="pad"/.test(gate)&&/api\/login/.test(gate),gate.slice(0,300));
    // This page's own CSP: inline with a nonce, and NO 'self' for scripts because /assets is behind the door.
    const csp=(await fetch(base+'/')).headers.get('content-security-policy')||'';
    assert.match(csp,/script-src 'nonce-/);
    assert.ok(!csp.includes("script-src 'self'"),csp);
    // The nonce must be fresh on every response, or it is just 'unsafe-inline' spelled longer.
    const one=(await (await fetch(base+'/')).text()).match(/nonce="([^"]+)"/)![1];
    const two=(await (await fetch(base+'/')).text()).match(/nonce="([^"]+)"/)![1];
    assert.notEqual(one,two);
    // A wrong code returns no cookie; the right one does, and that cookie opens the API.
    const bad=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'1111'})});
    assert.equal(bad.status,401);assert.equal(bad.headers.get('set-cookie'),null);
    assert.equal((await fetch(base+'/api/sessions',{headers})).status,200);
  });
});

test('wrong codes lock the caller out instead of letting all 10000 be tried',async()=>{
  await withServer(async({base})=>{
    const bad=()=>fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'0000'})});
    let sawLock=false;
    for(let i=0;i<7;i++){const r=await bad();if(r.status===429){sawLock=true;
      const body=await r.json();assert.ok(body.retryAfter>0,'429 must say how long is left to wait');
      assert.ok(Number(r.headers.get('retry-after')||0)>=0);break;}}
    assert.ok(sawLock,'allowing more tries after 5 wrong ones makes brute force a matter of seconds');
    // While locked out even the RIGHT code doesn't pass — otherwise lockout is decoration.
    const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:PASSCODE})});
    assert.equal(r.status,429);assert.equal(r.headers.get('set-cookie'),null);
  });
});

test('the cookie survives a restart, and rotating the token signs every device out',async()=>{
  await withServer(async({base,srv,headers,storageDir})=>{
    const saved=nodeFs.readFileSync(nodePathT.join(storageDir,'mobile-token'),'utf8');
    assert.match(saved,/^[A-Za-z0-9_-]{24,}$/);
    // Reload Window = dispose + start. Minting the token every time kicks out every signed-in PWA.
    srv.dispose();
    const {port}=await srv.start(0,true);
    const again=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(again+'/api/sessions',{headers})).status,200,'the old cookie must stay valid after restart');
    srv.rotateToken();
    assert.equal((await fetch(again+'/api/sessions',{headers})).status,401,'rotate must invalidate the old cookie');
  });
});

test('the PWA install metadata is complete enough for iOS standalone',async()=>{
  await withServer(async({base,headers})=>{
    const html=await (await fetch(base+'/',{headers})).text();
    // `black-translucent` = iOS 26+ lays a blur over the status bar; `default` needs `.ios-top-edge`
    // for the bar to get a background colour instead of white.
    assert.match(html,/apple-mobile-web-app-status-bar-style" content="default/);
    assert.match(html,/<body><div class="ios-top-edge" aria-hidden="true"><\/div>/);
    assert.ok(/theme-color[^>]*prefers-color-scheme: light/.test(html)&&/theme-color[^>]*prefers-color-scheme: dark/.test(html),html);
    // Without `use-credentials` the manifest is fetched without the cookie → 401.
    assert.match(html,/rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
    const res=await fetch(base+'/manifest.webmanifest',{headers});
    assert.equal(res.status,200);
    assert.ok((res.headers.get('content-type')||'').startsWith('application/manifest+json'));
    const m=await res.json();
    assert.equal(m.display,'standalone');assert.equal(m.start_url,'/');
    const csp=(await fetch(base+'/',{headers})).headers.get('content-security-policy')||'';
    assert.ok(csp.includes("manifest-src 'self'"),csp);
  });
});

test('a cross-origin caller is refused even when it somehow holds the token',async()=>{
  await withServer(async({base,headers,token})=>{
    // DNS rebinding: a foreign page can read neither cookie nor token, but Origin pins it shut.
    const evil={...headers,Origin:'http://evil.example'};
    assert.equal((await fetch(base+'/',{headers:evil})).status,403);
    assert.equal((await fetch(base+'/api/sessions',{headers:evil})).status,403);
    // No Origin (a non-browser client) still passes — only the token is the door.
    assert.equal((await fetch(base+'/api/sessions',{headers})).status,200);
    // Origin matching Host passes: that is the page's own path.
    const host=new URL(base).host;
    assert.equal((await fetch(base+'/api/sessions',
      {headers:{...headers,Origin:'http://'+host}})).status,200);
    void token;
  });
});

test('the same renderer the panel uses is what the phone downloads',async()=>{
  await withServer(async({base,headers})=>{
    for(const asset of ['chat.js','chat.css','bridge.js','mobile.css']){
      const r=await fetch(base+'/assets/'+asset,{headers});
      assert.equal(r.status,200,asset);
      assert.ok((await r.text()).length>100,asset+' empty');
    }
    assert.equal((await fetch(base+'/assets/../package.json',{headers})).status,404);
  });
});

test('mobile footer drops the safe-area inset while the keyboard is open',async()=>{
  await withServer(async({base,headers})=>{
    const css=await (await fetch(base+'/assets/mobile.css',{headers})).text();
    // Only pin the padding — the other declarations in this rule are where the iOS keyboard probe
    // changes things, and the mobileComposer test is what guards that part.
    assert.match(css,/body\[data-keyboard="open"\] footer\{padding-bottom:4px[;}]/,
      'an open keyboard must not add the safe-area again');
  });
});

test('a session opened from the phone streams its transcript and drives the real manager',async()=>{
  await withServer(async({base,headers,calls,em})=>{
    const s=await stream(base,headers);
    await s.post({type:'ready'});
    await s.wait((m:any)=>m.type==='empty');
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    const sel=await s.wait((m:any)=>m.type==='sessionSelected');
    assert.equal(sel.events.length,1);
    assert.equal(sel.events[0].text,'old turn');
    assert.equal(sel.project.name,'proj');
    const opt=await s.wait((m:any)=>m.type==='optionsChanged');
    assert.equal(opt.slash,true,'the slash button only shows once the CLI has declared commands');

    await s.post({type:'sendPrompt',text:'hi from phone'});
    const echoed=await s.wait((m:any)=>m.type==='event'&&m.event.type==='user_message');
    assert.equal(calls.turn.kind,'resume');
    assert.equal(echoed.event.text,'hi from phone');

    em.emit('event',{provider:'claude',sessionId:'s1',event:{type:'assistant_delta',text:'ab',timestamp:2}});
    em.emit('event',{provider:'claude',sessionId:'s1',event:{type:'assistant_delta',text:'cd',timestamp:3}});
    const batch=await s.wait((m:any)=>m.type==='eventBatch');
    assert.equal(batch.items.length,1,'deltas must be batched, or every character is one SSE message');
    assert.equal(batch.items[0].event.text,'abcd');
    s.cancel();
  });
});

test('an approval reaches the phone and its answer reaches the CLI',async()=>{
  await withServer(async({base,headers,srv,answered})=>{
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    await s.wait((m:any)=>m.type==='sessionSelected');
    assert.equal(srv.showPermission('claude','s1',{requestId:'r1',toolName:'Bash',input:{command:'ls'}}),true);
    const perm=await s.wait((m:any)=>m.type==='permission');
    assert.equal(perm.request.requestId,'r1');
    await s.post({type:'permissionResponse',requestId:'r1',allow:true});
    await new Promise(r=>setTimeout(r,100));
    assert.equal(answered.length,1);
    assert.equal(answered[0][3],true);
    // No client holds the session -> must YIELD, not accept and then leave the CLI hanging.
    assert.equal(srv.showPermission('claude','nobody-holds-this',{requestId:'r2'}),false);
    s.cancel();
  });
});

test('a draft started from a project becomes a real session',async()=>{
  await withServer(async({base,headers,calls})=>{
    const s=await stream(base,headers);
    await s.post({type:'openProject',projectId:'p1'});
    const draft=await s.wait((m:any)=>m.type==='draftSelected');
    assert.equal(draft.draft.project.name,'proj');
    await s.post({type:'sendPrompt',text:'brand new'});
    const sel=await s.wait((m:any)=>m.type==='sessionSelected'&&m.session.nativeSessionId==='s2');
    assert.equal(calls.turn.kind,'start');
    assert.equal(sel.session.title,'brand new');
    s.cancel();
  });
});

test('a mobile draft keeps the real session id when startup rekeys before start returns',async()=>{
  const real:any={provider:'codex',nativeSessionId:'real-id',workspaceId:'w1',projectId:'p1',cwd:'/tmp',
    title:'hello',status:'running',createdAt:1,updatedAt:Date.now()};
  await withServer(async({base,headers})=>{
    const s=await stream(base,headers);
    await s.post({type:'openProject',projectId:'p1'});
    await s.wait((m:any)=>m.type==='draftSelected');
    await s.post({type:'setProvider',provider:'codex'});
    await s.wait((m:any)=>m.type==='draftSelected'&&m.draft.provider==='codex');
    await s.post({type:'sendPrompt',text:'hello'});
    const selected=await s.wait((m:any)=>m.type==='sessionSelected'&&m.session.provider==='codex');
    assert.equal(selected.session.nativeSessionId,'real-id');
    s.cancel();
  },true,({deps,manager,em}:any)=>{
    deps.findSession=async(_provider:string,id:string)=>id==='real-id'?real:undefined;
    manager.start=async(input:any)=>{
      em.emit('sessionRekeyed',{provider:'codex',oldId:'pending:turn',newId:'real-id',session:real});
      return {...real,nativeSessionId:'pending:turn',title:input.prompt};
    };
  });
});

test('the file route serves only media files inside the media roots, with byte ranges',async()=>{
  await withServer(async({base,headers})=>{
    const enc=(p:string)=>Buffer.from(p,'utf8').toString('base64url');
    assert.equal((await fetch(base+'/api/file?p='+enc('/etc/passwd'),{headers})).status,403);
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-media-'));
    try{
      fs.writeFileSync(path.join(dir,'secret.txt'),'top secret');fs.writeFileSync(path.join(dir,'clip.mp4'),'0123456789');
      fs.symlinkSync(path.join(dir,'secret.txt'),path.join(dir,'evil.png'));
      const f=(p:string,h:any={})=>fetch(base+'/api/file?f='+encodeURIComponent(p),{headers:{...headers,...h}});
      assert.equal((await f(path.join(dir,'secret.txt'))).status,403,'roots now include ~ and tmp: only media extensions may be read');
      assert.equal((await f(path.join(dir,'evil.png'))).status,403,'a .png symlink pointing at another file must die after realpath');
      const full=await f(path.join(dir,'clip.mp4'));
      assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'video/mp4');assert.equal(await full.text(),'0123456789');
      const part=await f(path.join(dir,'clip.mp4'),{range:'bytes=2-4'});
      assert.equal(part.status,206,'Safari will not play video unless Range returns 206');
      assert.equal(part.headers.get('content-range'),'bytes 2-4/10');assert.equal(await part.text(),'234');
      assert.equal((await f(path.join(dir,'clip.mp4'),{range:'bytes=50-'})).status,416);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
    // Same string prefix but a different folder: the check must anchor on the separator, not a bare startsWith.

    assert.equal((await fetch(base+'/api/file?p='+enc('/tmp-evil/x.png'),{headers})).status,403);
  });
});

test('option and slash choices come from the provider, not from the phone',async()=>{
  await withServer(async({base,headers})=>{
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    await s.wait((m:any)=>m.type==='sessionSelected');
    const slash=await (await fetch(base+`/api/choices?kind=slash&c=${s.clientId}`,{headers})).json();
    assert.deepEqual(slash.items.map((x:any)=>x.value),['/compact ','/review ']);
    await s.post({type:'setOption',kind:'model',value:'opus'});
    const opt=await s.wait((m:any)=>m.type==='optionsChanged'&&m.model==='opus');
    assert.equal(opt.model,'opus');
    const list=await (await fetch(base+'/api/sessions',{headers})).json();
    assert.equal(list.sessions[0].projectName,'proj');
    s.cancel();
  });
});

test('switching Claude account from the phone: label per project, toggled through the host, inherited reports an error',async()=>{
  const toggled:string[]=[];let level:any='info';
  await withServer(async({base,headers})=>{
    const list=await (await fetch(base+'/api/sessions',{headers})).json();
    assert.equal(list.projects[0].account,'acme','every project carries an account label for the sheet to draw');
    const s=await stream(base,headers);
    await s.post({type:'switchAccount',projectId:'p1'});
    const ok=await s.wait((m:any)=>m.type==='accountSwitched');
    assert.deepEqual(toggled,['/tmp|proj']);assert.match(ok.message,/work/);
    level='warn';await s.post({type:'switchAccount',projectId:'p1'});
    await s.wait((m:any)=>m.type==='error'&&/covered/.test(m.message));
    await s.post({type:'switchAccount',projectId:'nope'});
    await s.wait((m:any)=>m.type==='error'&&m.message==='That project is gone.');
    s.cancel();
  },true,({deps})=>{deps.accounts={label:()=>'acme',
    toggle:async(root:string,name:string)=>{toggled.push(root+'|'+name);return level==='info'?{level,message:`${name} → Claude work.`}:{level,message:'covered by parent'};}};});
});

test('altAccountFile not set: no label, switchAccount is refused',async()=>{
  await withServer(async({base,headers})=>{
    const list=await (await fetch(base+'/api/sessions',{headers})).json();
    assert.equal(list.projects[0].account,undefined);
    const s=await stream(base,headers);
    await s.post({type:'switchAccount',projectId:'p1'});
    await s.wait((m:any)=>m.type==='error'&&/altAccountFile/.test(m.message));
    s.cancel();
  },true,({deps})=>{deps.accounts={label:()=>undefined,toggle:async()=>{throw new Error('must not be called');}};});
});

test('a stale client id is rejected so the phone reconnects instead of talking to nothing',async()=>{
  await withServer(async({base,headers})=>{
    const r=await fetch(base+'/api/msg?c=gone',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"type":"ready"}'});
    assert.equal(r.status,409);
  });
});

test('the mobile bridge is valid JavaScript',()=>{
  const file=nodePathT.join(process.cwd(),'media','mobile','bridge.js');
  const src=nodeFs.readFileSync(file,'utf8');
  new Function(src);
  // These messages must NOT be sent to the server: the phone has no QuickPick to open.
  for(const local of ['pickModel','pickEffort','pickProvider','pickProject','pickSlash','pickHistory'])
    assert.ok(src.includes(local),'the bridge lacks local handling for '+local);
});

test('the phone shows the images a Claude turn was sent with, like the panel does',async()=>{
  await withServer(async({base,headers,storageDir,setTranscript})=>{
    const img=nodePathT.join(storageDir,'devhub','attachments','1-a.png');
    // Claude writes images into the prompt as paths, so a re-read transcript only has those lines.
    setTranscript([{type:'user_message',text:img+'\nlook at the image',timestamp:1}]);
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    const sel=await s.wait((m:any)=>m.type==='sessionSelected');
    const um=sel.events.find((e:any)=>e.type==='user_message');
    assert.equal(um.text,'look at the image','paths must be split off the text');
    assert.equal(um.imageSrcs.length,1);
    assert.ok(String(um.imageSrcs[0]).startsWith('/api/file?p='),'images must go through the server\'s file route: '+um.imageSrcs[0]);
    s.cancel();
  });
});

test('Stop on the phone keeps the queue and sends it once the turn is dead',async()=>{
  await withServer(async({base,headers,em,calls,session})=>{
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    await s.wait((m:any)=>m.type==='sessionSelected');
    // A turn is running: two more typed messages must be queued.
    em.emit('sessionUpdated',{...session,status:'running'});
    await s.post({type:'sendPrompt',text:'queued one'});
    await s.post({type:'sendPrompt',text:'queued two'});
    await s.wait((m:any)=>m.type==='queue'&&m.items.length===2);
    delete calls.turn;

    await s.post({type:'cancel'});
    await new Promise(r=>setTimeout(r,80));
    assert.equal(calls.turn,undefined,'Stop must not send anything by itself while the turn is still dying');
    // `sessionUpdated` after Stop is where scheduleFlush runs — the queue is intact so sending continues.
    em.emit('sessionUpdated',{...session,status:'cancelled'});
    await s.wait((m:any)=>m.type==='queue'&&m.items.length===1);
    assert.deepEqual(calls.turn,{kind:'resume',text:'queued one'},'after Stop the queue must keep running');
    s.cancel();
  });
});


test('switching to the other provider drops options that only mean something to the old one',async()=>{
  await withServer(async({base,headers})=>{
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    await s.wait((m:any)=>m.type==='sessionSelected');
    await s.post({type:'setOption',kind:'model',value:'opus'});
    await s.wait((m:any)=>m.type==='optionsChanged'&&m.model==='opus');
    // `opus` is not a Codex model; carrying it over breaks the whole turn.
    await s.post({type:'openSession',provider:'codex',id:'c1'});
    await s.wait((m:any)=>m.type==='sessionSelected'&&m.session.provider==='codex');
    const opt=await s.wait((m:any)=>m.type==='optionsChanged'&&m.provider==='codex');
    assert.equal(opt.model,undefined,'the model must reset to the new provider\'s default');
    s.cancel();
  });
});

test('a message replayed after a dropped connection runs once, not twice',async()=>{
  await withServer(async({base,headers})=>{
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1',__id:'a1'});
    await s.wait((m:any)=>m.type==='sessionSelected');
    // fetch may reject AFTER the server finished handling it; the bridge resends that exact message.
    const again={type:'sendPrompt',text:'only once',__id:'a2'};
    await s.post(again);await s.post(again);
    await new Promise(r=>setTimeout(r,120));
    const sent=s.msgs.filter((m:any)=>m.type==='event'&&m.event.type==='user_message'&&m.event.text==='only once');
    assert.equal(sent.length,1,'a message with a duplicate __id must be dropped');
    s.cancel();
  });
});

test('reopening the session already on screen keeps what is queued for it',async()=>{
  await withServer(async({base,headers,em,session})=>{
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    await s.wait((m:any)=>m.type==='sessionSelected');
    em.emit('sessionUpdated',{...session,status:'running'});
    await s.post({type:'sendPrompt',text:'wait for this turn to finish'});
    await s.wait((m:any)=>m.type==='queue'&&m.items.length===1);
    // The bridge sends openSession on every reconnect; clearing the queue here loses text to a dropped signal.
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    await new Promise(r=>setTimeout(r,120));
    assert.deepEqual(s.msgs.filter((m:any)=>m.type==='queue').pop().items.map((i:any)=>i.text),['wait for this turn to finish']);
    s.cancel();
  });
});

test('the bridge waits for the server to confirm the session before flushing its outbox',()=>{
  const src=nodeFs.readFileSync(nodePathT.join(process.cwd(),'media','mobile','bridge.js'),'utf8');
  new Function(src);
  // Two POSTs are two HTTP requests; flushing the outbox right after openSession races itself.
  assert.match(src,/restoring=setTimeout\(doneRestoring/,'must wait for confirmation, with a timeout escape');
  assert.equal(/id:last\.id\}\);\s*flush\(\);/.test(src),false,'must not flush right after openSession');
  assert.match(src,/msg\.__id=/,'every message must have an id so the server can drop duplicates');
});

test('the bridge remembers the project with the selected session',()=>{
  const b=bootBridge(PROJECT_STATE(1));
  b.socket.onmessage({data:JSON.stringify({type:'sessionSelected',
    session:{provider:'codex',nativeSessionId:'real-id'},project:{id:'p0'}})});
  assert.deepEqual(JSON.parse(b.storage.value),{provider:'codex',id:'real-id',projectId:'p0'});
});

test('a gone restored session falls back to its remembered project',async()=>{
  const b=bootBridge(PROJECT_STATE(1),{provider:'codex',id:'stale-id',projectId:'p0'});
  assert.deepEqual(b.posted.map((m:any)=>({type:m.type,provider:m.provider,id:m.id})),
    [{type:'openSession',provider:'codex',id:'stale-id'}]);
  b.socket.onmessage({data:JSON.stringify({type:'error',message:'That session is gone.'})});
  await flush();
  assert.deepEqual(b.posted.map((m:any)=>({type:m.type,projectId:m.projectId})),
    [{type:'openSession',projectId:undefined},{type:'openProject',projectId:'p0'}]);
});

test('a dead-end restore still flushes what was queued while offline',async()=>{
  // Without a projectId there is no way to reattach; the outbox must still go out, or the message
  // sits until the next reconnect fires it — late and out of context.
  const b=bootBridge(PROJECT_STATE(1),{provider:'claude',id:'stale-id'});
  b.socket.onerror();
  b.api.postMessage({type:'sendPrompt',text:'typed while offline'});
  await flush();
  assert.equal(b.posted.filter((m:any)=>m.type==='sendPrompt').length,0,'stays in the outbox until reconnected');
  b.socket.onmessage({data:JSON.stringify({type:'hello',clientId:'c2'})});
  await flush();
  assert.equal(b.posted.filter((m:any)=>m.type==='sendPrompt').length,0,'not flushed while reattaching');
  b.socket.onmessage({data:JSON.stringify({type:'error',message:'That session is gone.'})});
  await flush();
  assert.equal(b.posted.filter((m:any)=>m.type==='sendPrompt').length,1,'must flush once there is no way to reattach');
});

/**
 * The whole reason this page exists is to be opened from a phone: binding loopback makes the link only work
 * on the machine running the extension. A CI machine may have no LAN IP — skip then.
 */
test('the server answers on the LAN address when it is told to',async()=>{
  const {lanAddress}=require('../../src/devhub/web/mobileServer');
  await withServer(async(ctx:any)=>{
    const lan=lanAddress();
    if(!lan)return;
    const port=new URL(ctx.base).port;
    const res=await fetch(`http://${lan}:${port}/`,{headers:ctx.headers});
    assert.equal(res.status,200,'a phone on the same Wi-Fi must be able to reach it');
    assert.match(await res.text(),/<div/,'must be the real chat page');
  },true);
});

test('with devHub.mobile.lan off nothing outside this machine can reach it',async()=>{
  const {lanAddress}=require('../../src/devhub/web/mobileServer');
  await withServer(async(ctx:any)=>{
    const lan=lanAddress();
    if(!lan)return;
    const port=new URL(ctx.base).port;
    // Loopback must still work, while the LAN IP must be refused at the socket level.
    assert.equal((await fetch(ctx.base+'/',{headers:ctx.headers})).status,200);
    await assert.rejects(fetch(`http://${lan}:${port}/`,{headers:ctx.headers}),
      'binding loopback means the port must not listen on the LAN IP');
  },false);
});

test('lanAddress never hands out a public address',()=>{
  const {lanAddress}=require('../../src/devhub/web/mobileServer');
  const lan=lanAddress();
  // The URL carries a token; a public IP in it invites the whole internet into an endpoint that runs a CLI.
  if(lan)assert.match(lan,/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,`must not return a public IP: ${lan}`);
});

/**
 * The picker sheet is the ONLY phone-only piece of UI, so it must really run —
 * grepping the source can't tell which rows survive filtering. A fake DOM just big enough for `openSheet`.
 */
/** The fake fetch returns promises: each `.then` is a microtask, so drain a few rounds before the DOM shows it. */
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
function bootBridge(state:any,lastSession?:any){
  const mk=(tag:string):any=>({tag,className:'',hidden:false,type:'',value:'',placeholder:'',children:[] as any[],_t:'',
    style:{_v:{} as any,transform:'',setProperty(k:string,v:string){this._v[k]=v},removeProperty(k:string){delete this._v[k]}},
    set textContent(v:string){this._t=v;this.children=[]},
    get textContent():string{return this._t||this.children.map((c:any)=>c.textContent||'').join('')},
    appendChild(c:any){this.children.push(c);return c},
    setAttribute(){},addEventListener(){},removeAttribute(){},focus(){},
    get classList(){const self=this as any;return {add(c:string){self.className=(self.className+' '+c).trim()}}}});
  const sheet=Object.assign(mk('div'),{id:'sheet'});
  // The drawer gesture hangs off document; keep the handler so the test can fire it by hand.
  const handlers:any={};
  const document:any={getElementById:(id:string)=>id==='sheet'?sheet:null,createElement:mk,
    createTextNode:(t:string)=>({textContent:t,children:[]}),
    addEventListener(t:string,fn:Function){(handlers[t]=handlers[t]||[]).push(fn)},body:mk('body')};
  const posted:any[]=[];
  const win:any={postMessage(){},matchMedia:()=>({matches:false}),innerWidth:390};
  const fetched:string[]=[];
  const fetchStub=(url:string,init?:any)=>{fetched.push(String(url));
    if(init&&init.method==='POST'){posted.push(JSON.parse(init.body));return Promise.resolve({status:200})}
    if(String(url).indexOf('/api/sessions')===0)return Promise.resolve({json:()=>Promise.resolve(state)});
    return Promise.resolve({json:()=>Promise.resolve({items:[]})});
  };
  const sockets:any[]=[];
  class ES{onmessage:any;onerror:any;readyState=1;constructor(){sockets.push(this)}close(){}}
  const src=nodeFs.readFileSync(nodePathT.join(process.cwd(),'media','mobile','bridge.js'),'utf8');
  const storage:any={value:lastSession?JSON.stringify(lastSession):null,
    getItem(){return this.value;},setItem(_key:string,value:string){this.value=value;}};
  new Function('window','document','localStorage','EventSource','fetch','setTimeout','clearTimeout',src)(
    win,document,storage,ES,fetchStub,(fn:Function)=>1,()=>{});
  // Without `hello` every POST stays in the outbox — the bridge deliberately doesn't send before it has a clientId.
  sockets[0].onmessage({data:JSON.stringify({type:'hello',clientId:'c1'})});
  const all=(cls:string)=>{const out:any[]=[];const walk=(n:any)=>{for(const c of n.children||[]){
    if(String(c.className||'').split(' ').indexOf(cls)>=0)out.push(c);walk(c)}};walk(sheet);return out};
  const drawer=()=>document.body.children.find((c:any)=>c.id==='drawer');
  const fire=(type:string,x?:number,y?:number)=>{for(const fn of handlers[type]||[])
    fn({cancelable:true,preventDefault(){},touches:x===undefined?[]:[{identifier:1,clientX:x,clientY:y}]})};
  const rowsIn=(node:any,cls:string)=>{const out:any[]=[];const walk=(n:any)=>{for(const c of n.children||[]){
    if(String(c.className||'').split(' ').indexOf(cls)>=0)out.push(c);walk(c)}};walk(node);return out};
  return {sheet,posted,storage,api:win.acquireVsCodeApi(),all,socket:sockets[0],drawer,fire,rowsIn,
    rows:()=>all('sheet-row'),shown:()=>all('sheet-row').filter((r:any)=>!r.hidden),
    input:()=>all('sheet-input')[0],clear:()=>all('sheet-clear')[0],
    label:(r:any)=>r.children[0].textContent};
}
const PROJECT_STATE=(n:number)=>({workspaces:[{id:'w1',name:'Acme Work'}],
  projects:Array.from({length:n},(_,i)=>({id:'p'+i,name:i===0?'order-chatbot-admin-system':'repo-'+i,workspaceId:'w1',rootPath:'/tmp/'+i})),
  sessions:[]});

test('the project sheet filters by keyword across the name and its workspace',async()=>{
  const b=bootBridge(PROJECT_STATE(12));
  b.api.postMessage({type:'pickProject'});
  await flush();
  assert.equal(b.rows().length,12,'the sheet must build all 12 rows');
  assert.ok(b.input(),'12 rows means a filter box');
  // Each keyword matches independently: with long repo names people remember two separate pieces, not one run.
  b.input().value='chat admin';b.input().oninput();
  assert.deepEqual(b.shown().map(b.label),['order-chatbot-admin-system']);
  // Filtering also works by workspace, since that is often remembered instead of the full name.
  b.input().value='acme';b.input().oninput();
  assert.equal(b.shown().length,12);
  b.input().value='khong-co-repo-nao';b.input().oninput();
  assert.equal(b.shown().length,0);
  b.clear().onclick();
  assert.equal(b.shown().length,12,'✕ restores the full list');
  // Picking must still be openProject of the right row, even while filtering.
  b.input().value='repo-7';b.input().oninput();
  b.shown()[0].onclick();
  assert.deepEqual(b.posted.map((m:any)=>({type:m.type,projectId:m.projectId})),[{type:'openProject',projectId:'p7'}]);
  assert.equal(b.sheet.hidden,true,'picking closes the sheet');
});

test('a short list gets no filter box, and only the session sheet stacks its rows',async()=>{
  const few=bootBridge(PROJECT_STATE(4));
  few.api.postMessage({type:'pickProject'});
  await flush();
  assert.equal(few.input(),undefined,'with 4 rows a filter box only takes space');
  // Project: one line (caption is the workspace name). Session: two tiers, caption longer than the label.
  assert.deepEqual(few.rows().map((r:any)=>r.className),Array(4).fill('sheet-row'));

  const ss=bootBridge({workspaces:[],projects:[],sessions:[{provider:'claude',nativeSessionId:'a',title:'impl',
    projectName:'SHT',status:'done',updatedAt:Date.now()}]});
  ss.api.postMessage({type:'pickHistory'});
  await flush();
  assert.deepEqual(ss.rowsIn(ss.drawer(),'sheet-row').map((r:any)=>r.className),['sheet-row stacked']);
});

/**
 * Runs the keypad script FOR REAL in a tiny DOM. Grepping strings can't catch this bug: the old one was
 * `if(code.length>=4)send()` — valid syntax, right intent, wrong only for passcodes longer than 4.
 */
function bootKeypad(passcode='1234'){
  const src=String(keypadHtml(passcode)).match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)![1];
  const mk=(tag:string):any=>{const n:any={tag,className:'',_t:'',children:[] as any[],onclick:undefined,
    value:'',focused:0,focus(){this.focused++},
    appendChild(c:any){this.children.push(c);return c},
    set textContent(v:string){this._t=v;this.children.length=0},get textContent(){return this._t}};return n;};
  const dots=mk('div'),msg=mk('div'),pad=mk('div');
  // `#pw`/`#go` are in static HTML (autofocus needs that), so the harness must prebuild them like the parser.
  const pw=mk('input'),go=mk('button');
  const byId:any={dots,msg,pad,pw,go};
  const calls:any[]=[];let replaced='';
  const document={getElementById:(id:string)=>byId[id],createElement:mk};
  const fetchFn=(_u:string,init:any)=>{calls.push(JSON.parse(init.body));
    return Promise.resolve({status:204,json:()=>Promise.resolve({})});};
  new Function('document','fetch','location',src)(document,fetchFn,{replace:(p:string)=>{replaced=p;}});
  const tap=(label:string)=>{const b=pad.children.find((c:any)=>c.textContent===label);
    assert.ok(b,'no key "'+label+'"');b.onclick();};
  return {tap,calls,dots,msg,pad,pw,go,get replaced(){return replaced;}};
}
/** `keypad()` only writes to res, no port needed — build the server and call it directly. */
function keypadHtml(passcode='1234'){
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return VSCODE;return original.apply(this,arguments as any);};
  try{
    const MobileServer=freshServer();
    const srv=new MobileServer({passcode:()=>passcode} as any);
    let html='';
    srv.keypad({writeHead(){},end(b:string){html=b;}});
    return html;
  } finally { Module._load=original; }
}

test('the keypad fires at exactly the length the server accepts', async()=>{
  // This is a contract that once broke: the keypad has NO send button, it sends itself at full length. Widening
  // `PASSCODE_RE` while forgetting the keypad sets a passcode that can never be typed.
  const { PASSCODE_RE }=require('../../src/devhub/web/mobileServer');
  const len=[...Array(20).keys()].filter(n=>PASSCODE_RE.test('1'.repeat(n)));
  assert.deepEqual(len,[4,8,9,10,11,12,13,14,15,16,17,18,19],
    'only two branches: 4 (keypad auto-sends) and >=8 (input + send button)');
  assert.equal(PASSCODE_RE.test('a'.repeat(129)),false,'128 character cap');
  assert.equal(PASSCODE_RE.test('Anh vip_1'),false,'no whitespace: pasting into the input would be a typo you cannot see');
  const k=bootKeypad();
  for(const d of ['1','2','3'])k.tap(d);
  assert.deepEqual(k.calls,[],'too short means do not spend a rate-limit attempt');
  k.tap('4');
  assert.deepEqual(k.calls,[{code:'1234'}]);
  await new Promise(r=>setTimeout(r,0));
  assert.equal(k.replaced,'/','after 204 it must leave the keypad page');
});

test('the keypad has no submit button and cannot overrun the passcode length', async()=>{
  const k=bootKeypad();
  assert.equal(k.pad.children.some((c:any)=>c.textContent==='OK'),false,
    'adding a send button changes the contract above — change both places or neither');
  for(const d of ['1','2','3','4','5','6'])k.tap(d);
  assert.deepEqual(k.calls,[{code:'1234'}],'sends exactly once, later keys send nothing more');
});

/**
 * The long passcode branch: the server can't know the length to auto-send, so the contract CHANGES — there is a send button, and
 * the keypad must not be built. Run the script for real to catch the `pin` branch landing on the wrong page variant.
 */
test('a long passcode swaps the pad for a text field and a submit button', async()=>{
  const html=keypadHtml('Anhvip_123');
  assert.match(html,/<input id="pw"[^>]*autofocus/,'autofocus must be in static HTML to work on WebKit');
  assert.match(html,/<input id="pw"[^>]*type="password"/);
  assert.equal(/class="wide">Unlock</.test(html),true,'must have a send button');

  const k=bootKeypad('Anhvip_123');
  assert.deepEqual(k.pad.children,[],'a long passcode no longer builds the keypad');
  assert.deepEqual(k.dots.children,[],'the 4-dot counter is meaningless here too');

  k.go.onclick();
  assert.deepEqual(k.calls,[],'an empty input must not burn a rate-limit attempt');
  assert.equal(k.pw.focused,1,'…but focus RIGHT inside the tap handler: iOS only opens the keyboard that way');

  k.pw.value='Anhvip_123';k.go.onclick();
  assert.deepEqual(k.calls,[{code:'Anhvip_123'}],'sends the whole string, not cut to any length');
  await new Promise(r=>setTimeout(r,0));
  assert.equal(k.replaced,'/','after 204 it must leave the page');
});

test('Enter in the text field submits like the button', async()=>{
  const k=bootKeypad('Anhvip_123');
  k.pw.value='Anhvip_123';
  k.pw.onkeydown({key:'a'});
  assert.deepEqual(k.calls,[],'ordinary keys do not send');
  k.pw.onkeydown({key:'Enter'});
  assert.deepEqual(k.calls,[{code:'Anhvip_123'}]);
});

/**
 * History on the phone is a left-edge drawer. Two things must really run, grep can't see them:
 * rows are built for EVERY project (the only way to jump between repos on the
 * phone), and the gesture only opens when a finger moves sideways from the edge.
 */
const HISTORY_STATE={workspaces:[{id:'w1',name:'Acme Work'}],
  projects:[{id:'p0',name:'devhub',workspaceId:'w1',rootPath:'/tmp/0'}],
  sessions:[{provider:'claude',nativeSessionId:'s1',title:'fix mobile header',projectId:'p0',projectName:'devhub',status:'idle',updatedAt:Date.now()},
            {provider:'planner',nativeSessionId:'s2',title:'other project',projectId:'p9',projectName:'other',status:'idle',updatedAt:Date.now()}]};

test('the history drawer lists every session, not just the open project, and opens the one tapped',async()=>{
  const b=bootBridge(HISTORY_STATE);
  b.socket.onmessage({data:JSON.stringify({type:'sessionSelected',project:{id:'p0'},session:{provider:'claude',nativeSessionId:'s1'}})});
  b.api.postMessage({type:'pickHistory'});
  await flush();
  const d=b.drawer();
  assert.ok(d&&!d.hidden,'the drawer must appear');
  assert.equal(d.className,'open');
  const rows=b.rowsIn(d,'sheet-row');
  assert.deepEqual(rows.map((r:any)=>r.children[0].textContent),['fix mobile header','other project'],
    'sessions of other projects must still be there');
  assert.match(rows[1].children[1].textContent,/^other · planner/,'a row must say which project it belongs to');
  assert.match(rows[0].className,/\bon\b/,'the row being viewed must be highlighted');
  rows[0].onclick();
  const sent=b.posted.pop();
  assert.equal(sent.type,'openSession'); assert.equal(sent.provider,'claude'); assert.equal(sent.id,'s1');
  assert.equal(d.className,'','tapping a row must close the drawer');
});

test('a swipe from the left edge opens the drawer, a vertical drag never does',async()=>{
  const b=bootBridge(HISTORY_STATE);
  // A vertical scroll starting at the left edge: once the vertical axis is locked no drawer may be built.
  b.fire('touchstart',6,300); b.fire('touchmove',10,360); b.fire('touchend');
  await flush();
  assert.equal(b.drawer(),undefined,'a vertical drag must not open it');
  // Starting mid-screen doesn't either: that is a swipe inside content.
  b.fire('touchstart',200,300); b.fire('touchmove',300,302); b.fire('touchend');
  await flush();
  assert.equal(b.drawer(),undefined,'only the left edge opens it');
  b.fire('touchstart',6,300); b.fire('touchmove',240,306); b.fire('touchend');
  await flush();
  const d=b.drawer();
  assert.ok(d&&!d.hidden,'a horizontal swipe from the edge must open it');
  assert.equal(d.className,'open','releasing past 40% locks it open');
  assert.ok(b.rowsIn(d,'sheet-row').length>0,'content must load during the drag');
});

test('a swipe that stops short snaps the drawer back shut',async()=>{
  const b=bootBridge(HISTORY_STATE);
  b.fire('touchstart',6,300); b.fire('touchmove',30,300); b.fire('touchend');
  await flush();
  assert.equal(b.drawer().className,'','a drag short of the threshold springs back');
});

test('a fresh stream gets mediaBase without ready, and hello carries the page build',async()=>{
  await withServer(async({base,headers,html})=>{
    const s=await stream(base,headers);
    // An SSE reconnect (server restart) does NOT send `ready` — if mediaBase only came with `ready` the old page would lose media.
    await s.wait((m:any)=>m.type==='mediaBase'&&m.base==='/api/file?f=');
    const hello=s.msgs.find((m:any)=>m.type==='hello');
    const meta=/<meta name="devhub-build" content="([0-9a-f]+)">/.exec(html);
    assert.ok(meta,'the page must embed the build id');assert.equal(hello.build,meta![1]);
    s.cancel();
  });
});

test('the bridge reloads a page whose build no longer matches the server, once per build',()=>{
  const src=nodeFs.readFileSync(nodePathT.join(process.cwd(),'media','mobile','bridge.js'),'utf8');
  const run=(pageBuild:string,serverBuild:string,session:Record<string,string>)=>{
    let reloads=0;const sources:any[]=[];const posted:any[]=[];
    const node=():any=>({classList:{add(){},remove(){},toggle(){}},dataset:{},style:{},appendChild(){},addEventListener(){},setAttribute(){}});
    const document:any={body:node(),addEventListener(){},getElementById:()=>null,createElement:node,
      querySelector:(q:string)=>q==='meta[name="devhub-build"]'?{getAttribute:()=>pageBuild}:null};
    const win:any={location:{search:'',reload:()=>{reloads++}},matchMedia:()=>({matches:true}),addEventListener(){},postMessage:(m:any)=>posted.push(m)};
    class ES{onmessage:any;onerror:any;readyState=1;constructor(){sources.push(this)}close(){}}
    const store=(o:Record<string,string>)=>({getItem:(k:string)=>k in o?o[k]:null,setItem:(k:string,v:string)=>{o[k]=String(v)}});
    new Function('window','document','EventSource','localStorage','sessionStorage','location','fetch','setTimeout','clearTimeout','setInterval',src)(
      win,document,ES,store({}),store(session),win.location,async()=>({status:200}),()=>0,()=>{},()=>0);
    sources[0].onmessage({data:JSON.stringify({type:'hello',clientId:'c1',build:serverBuild})});
    return reloads;
  };
  assert.equal(run('aaa','aaa',{}),0,'same build does not reload');
  assert.equal(run('aaa','bbb',{}),1,'server on a new build while the page runs old JS: must reload');
  assert.equal(run('aaa','bbb',{'devhub.reloadFor':'bbb'}),0,'already reloaded for this build yet still mismatched (cache): must not loop forever');
});

test('the phone gets only the tail of a long transcript and pulls older pages on demand',async()=>{
  await withServer(async({base,headers,setTranscript})=>{
    setTranscript(Array.from({length:450},(_,i)=>({type:'assistant_message',text:'m'+i,timestamp:i+1})));
    const s=await stream(base,headers);
    await s.post({type:'openSession',provider:'claude',id:'s1'});
    const first=await s.wait((m:any)=>m.type==='sessionSelected');
    assert.equal(first.events.length,200,'opening a session must only send the tail, not the whole buffer');
    assert.equal(first.events[199].text,'m449');
    assert.equal(first.older,250);
    assert.ok(!first.keepScroll,'opening a session jumps to the bottom');
    s.msgs.length=0;
    await s.post({type:'loadOlder'});
    const more=await s.wait((m:any)=>m.type==='sessionSelected');
    assert.equal(more.events.length,400);assert.equal(more.events[0].text,'m50');
    assert.equal(more.older,50);assert.equal(more.keepScroll,true);
    s.msgs.length=0;
    await s.post({type:'loadOlder'});
    const all=await s.wait((m:any)=>m.type==='sessionSelected');
    assert.equal(all.events.length,450);assert.equal(all.older,0);
    s.cancel();
    // An SSE reconnect = a new client: again only the tail, not carrying over the widened window.
    const r=await stream(base,headers);
    await r.post({type:'openSession',provider:'claude',id:'s1'});
    const again=await r.wait((m:any)=>m.type==='sessionSelected');
    assert.equal(again.events.length,200);
    r.cancel();
  });
});
