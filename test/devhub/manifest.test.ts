const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');

test('extension contributes Dev Hub supervision commands',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const ids=new Set(pkg.contributes.commands.map((x:any)=>x.command));
  for(const id of ['devhub.revealProject','devhub.copySessionId','devhub.refreshHistory']) assert.equal(ids.has(id),true,`missing ${id}`);
});

test('every menu command has an icon so inline buttons never render as text over the tree',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const byId=new Map(pkg.contributes.commands.map((c:any)=>[c.command,c]));
  const menus=pkg.contributes.menus||{};
  const placed=new Set<string>();
  for(const list of Object.values<any>(menus)) for(const m of list) placed.add(m.command);
  assert.ok(placed.size>0,'must have commands attached to menus');
  for(const id of placed){
    const c:any=byId.get(id);
    assert.ok(c,`command ${id} is in a menu but not declared`);
    // No icon => VS Code prints the whole title, covering the project name in the tree.
    const ic=c.icon;
    if(typeof ic==='string'){assert.ok(ic.startsWith('$('),`command ${id} icon must be a codicon`);}
    else{
      assert.ok(ic&&ic.light&&ic.dark,`command ${id} is missing an icon`);
      for(const f of [ic.light,ic.dark])
        assert.ok(fs.existsSync(path.join(process.cwd(),f)),`command ${id} points at a missing file: ${f}`);
    }
  }
});

test('command titles keep the Dev Hub prefix for the palette but expose a short form for menus',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  for(const c of pkg.contributes.commands){
    assert.ok(String(c.title).startsWith('Dev Hub: '),`${c.command} must have the Dev Hub: prefix`);
    assert.ok(c.shortTitle&&!String(c.shortTitle).includes('Dev Hub'),`${c.command} is missing a short shortTitle`);
  }
});


test('brand icons are packaged and the light/dark pair actually differs where it must',()=>{
  const media=path.join(process.cwd(),'media');
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  assert.ok(pkg.files.includes('media'),'media must be in "files" or the VSIX will lack icons');
  for(const n of ['claude-light.svg','claude-dark.svg','codex-light.svg','codex-dark.svg'])
    assert.ok(fs.existsSync(path.join(media,n)),'missing '+n);
  // A dark-on-dark mark vanishes on a dark theme -> the two variants must differ.
  assert.notEqual(fs.readFileSync(path.join(media,'codex-light.svg'),'utf8'),fs.readFileSync(path.join(media,'codex-dark.svg'),'utf8'),'codex light/dark must differ');
});

test('the agents list ships empty so no personal paths leak, but the commands are there',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const agents=pkg.contributes.configuration.properties['devHub.agents'];
  assert.deepEqual(agents.default,[],'default must be empty — personal machine paths belong in the user\'s settings');
  assert.ok(/my-bot/.test(agents.markdownDescription),'the description must have a neutral example');
  for(const c of ['devhub.startAgent','devhub.stopAgent','devhub.restartAgent','devhub.openAgentLogs'])
    assert.ok(pkg.contributes.commands.some((x:any)=>x.command===c),'missing command '+c);
});

test('session switching is bound to keys and notifications default to background only',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const keys=Object.fromEntries(pkg.contributes.keybindings.map((k:any)=>[k.command,k.key]));
  assert.equal(keys['devhub.nextRunning'],'cmd+shift+]');
  assert.equal(keys['devhub.previousRunning'],'cmd+shift+[');
  assert.equal(keys['devhub.focusView'],'cmd+k cmd+a');
  const notify=pkg.contributes.configuration.properties['devHub.notify'];
  assert.equal(notify.default,'background','by default only notify for sessions not being viewed');
  assert.deepEqual(notify.enum,['off','background','always']);
});

test('README documents every setting and command the manifest ships',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const readme=fs.readFileSync(path.join(process.cwd(),'docs','DESIGN.md'),'utf8');
  for(const k of Object.keys(pkg.contributes.configuration.properties))
    assert.ok(readme.includes(k),'README is missing setting '+k);
  for(const c of pkg.contributes.commands)
    assert.ok(readme.includes(c.command),'README is missing command '+c.command);
  // Docs rot fastest where they describe architecture — pin a few anchors.
  assert.ok(readme.includes('--input-format stream-json'),'must describe the current transport');
  assert.ok(readme.includes('--permission-prompt-tool stdio'),'must describe the permission flow');
  assert.equal(/One shared Dev Hub chat tab/.test(readme),false,'leftover description of the old single-tab design');
});

test('CHANGELOG covers the shipped version',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const log=fs.readFileSync(path.join(process.cwd(),'CHANGELOG.md'),'utf8');
  assert.ok(log.includes('## '+pkg.version),'CHANGELOG is missing '+pkg.version);
});

test('nothing in the repo names a private workspace or a personal path',()=>{
  const root=process.cwd();
  for(const f of ['package.json','README.md','CHANGELOG.md','docs/DESIGN.md']){
    const t=fs.readFileSync(path.join(root,f),'utf8');
    // The repo is public; keep it neutral.
    assert.equal(/\/Users\/[a-z]/.test(t),false,f+' still has a personal machine path');
  }
});

test('comments, strings and docs are English only',()=>{
  const root=process.cwd(),bad:string[]=[];
  // Escapes, not literals: the letters only Vietnamese uses (a-breve, d-stroke, o/u-horn + the U+1EA0 block), so this file passes its own check.
  const VI=new RegExp('[\\u0103\\u0110\\u0111\\u01a1\\u01b0\\u1ea0-\\u1ef9]');
  const walk=(d:string)=>{for(const e of fs.readdirSync(path.join(root,d),{withFileTypes:true})){
    const p=d?d+'/'+e.name:e.name;
    if(e.isDirectory()){if(!['node_modules','dist','.git','images','.playwright-mcp'].includes(e.name))walk(p);continue;}
    if(!/\.(ts|js|css|html|md|json|yml)$/.test(e.name))continue;
    fs.readFileSync(path.join(root,p),'utf8').split('\n').forEach((l:string,i:number)=>{if(VI.test(l))bad.push(p+':'+(i+1));});
  }};
  walk('');
  assert.deepEqual(bad,[],'non-English text found');
});

test('the webview assets live in media/ and actually ship',()=>{
  const root=process.cwd();
  // CSP is default-src 'none' and localResourceRoots is empty: the webview can't load files itself,
  // the host must read and inline them. A missing file means a blank panel, so pin both ends.
  for(const rel of ['media/webview/chat.js','media/webview/chat.css']){
    const st=fs.statSync(path.join(root,rel));
    assert.ok(st.size>2000,rel+' is too small, probably written empty');
  }
  const provider=fs.readFileSync(path.join(root,'src/devhub/views/chatPanelProvider.ts'),'utf8');
  assert.ok(provider.includes("'media','webview'"),'the provider must read from media/webview');
  assert.equal(/const (css|script)=`/.test(provider),false,'css/js must not be inlined back into a TS file');

  const pack=fs.readFileSync(path.join(root,'scripts/package-vsix.js'),'utf8');
  assert.ok(/'media'/.test(pack),'the vsix must copy media');
  assert.ok(pack.includes('Extension="css"'),'[Content_Types].xml must declare css');
});

test('the shipped webview script is valid JavaScript on its own',()=>{
  const src=fs.readFileSync(path.join(process.cwd(),'media/webview/chat.js'),'utf8');
  // The script used to live in a TS template literal: a stray backtick in a comment
  // closed the string and broke the build. Now it is a real file, so check it directly.
  new (require('node:vm').Script)(src);
  assert.ok(src.includes('acquireVsCodeApi'));
});
