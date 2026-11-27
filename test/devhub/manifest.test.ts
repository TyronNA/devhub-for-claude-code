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
  assert.ok(placed.size>0,'phải có lệnh gắn vào menu');
  for(const id of placed){
    const c:any=byId.get(id);
    assert.ok(c,`lệnh ${id} nằm trong menu nhưng chưa khai báo`);
    // Không icon => VS Code in nguyên title, đè lên tên project trong tree.
    const ic=c.icon;
    if(typeof ic==='string'){assert.ok(ic.startsWith('$('),`lệnh ${id} icon phải là codicon`);}
    else{
      assert.ok(ic&&ic.light&&ic.dark,`lệnh ${id} thiếu icon`);
      for(const f of [ic.light,ic.dark])
        assert.ok(fs.existsSync(path.join(process.cwd(),f)),`lệnh ${id} trỏ tới file không tồn tại: ${f}`);
    }
  }
});

test('command titles keep the Dev Hub prefix for the palette but expose a short form for menus',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  for(const c of pkg.contributes.commands){
    assert.ok(String(c.title).startsWith('Dev Hub: '),`${c.command} phải có tiền tố Dev Hub:`);
    assert.ok(c.shortTitle&&!String(c.shortTitle).includes('Dev Hub'),`${c.command} thiếu shortTitle gọn`);
  }
});


test('brand icons are packaged',()=>{
  const media=path.join(process.cwd(),'media');
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  assert.ok(pkg.files.includes('media'),'media phải nằm trong "files" nếu không VSIX sẽ thiếu icon');
  for(const n of ['claude-light.svg','claude-dark.svg'])
    assert.ok(fs.existsSync(path.join(media,n)),'thiếu '+n);
});

test('the agents list ships empty so no personal paths leak, but the commands are there',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const agents=pkg.contributes.configuration.properties['devHub.agents'];
  assert.deepEqual(agents.default,[],'default phải rỗng — path máy cá nhân thuộc về settings của người dùng');
  assert.ok(/my-bot/.test(agents.markdownDescription),'mô tả phải có ví dụ trung tính');
  for(const c of ['devhub.startAgent','devhub.stopAgent','devhub.restartAgent','devhub.openAgentLogs'])
    assert.ok(pkg.contributes.commands.some((x:any)=>x.command===c),'thiếu lệnh '+c);
});

test('session switching is bound to keys and notifications default to background only',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const keys=Object.fromEntries(pkg.contributes.keybindings.map((k:any)=>[k.command,k.key]));
  assert.equal(keys['devhub.nextRunning'],'cmd+shift+]');
  assert.equal(keys['devhub.previousRunning'],'cmd+shift+[');
  assert.equal(keys['devhub.focusView'],'cmd+k cmd+a');
  const notify=pkg.contributes.configuration.properties['devHub.notify'];
  assert.equal(notify.default,'background','mặc định chỉ báo session không đang xem');
  assert.deepEqual(notify.enum,['off','background','always']);
});

test('README documents every setting and command the manifest ships',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const readme=fs.readFileSync(path.join(process.cwd(),'docs','DESIGN.md'),'utf8');
  for(const k of Object.keys(pkg.contributes.configuration.properties))
    assert.ok(readme.includes(k),'README thiếu setting '+k);
  for(const c of pkg.contributes.commands)
    assert.ok(readme.includes(c.command),'README thiếu command '+c.command);
  // Tài liệu hay mục nhất ở chỗ mô tả kiến trúc — khoá lại vài điểm neo.
  assert.ok(readme.includes('--input-format stream-json'),'phải mô tả transport hiện tại');
  assert.ok(readme.includes('--permission-prompt-tool stdio'),'phải mô tả luồng duyệt quyền');
  assert.equal(/One shared Dev Hub chat tab/.test(readme),false,'còn sót mô tả single-tab cũ');
});

test('CHANGELOG covers the shipped version',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const log=fs.readFileSync(path.join(process.cwd(),'CHANGELOG.md'),'utf8');
  assert.ok(log.includes('## '+pkg.version),'CHANGELOG thiếu '+pkg.version);
});

test('nothing in the repo names a private workspace or a personal path',()=>{
  const root=process.cwd();
  for(const f of ['package.json','README.md','CHANGELOG.md','docs/DESIGN.md']){
    const t=fs.readFileSync(path.join(root,f),'utf8');
    // Repo có thể public lại bất cứ lúc nào; giữ nó trung tính từ đầu.
    assert.equal(/\/Users\/[a-z]/.test(t),false,f+' còn đường dẫn máy cá nhân');
  }
});

test('the webview assets live in media/ and actually ship',()=>{
  const root=process.cwd();
  // CSP là default-src 'none' và localResourceRoots rỗng: webview không tự nạp file được,
  // host phải đọc rồi nhúng. Thiếu file thì panel trắng, nên khoá cả hai đầu lại.
  for(const rel of ['media/webview/chat.js','media/webview/chat.css']){
    const st=fs.statSync(path.join(root,rel));
    assert.ok(st.size>2000,rel+' quá nhỏ, chắc bị ghi rỗng');
  }
  const provider=fs.readFileSync(path.join(root,'src/devhub/views/chatPanelProvider.ts'),'utf8');
  assert.ok(provider.includes("'media','webview'"),'provider phải đọc từ media/webview');
  assert.equal(/const (css|script)=`/.test(provider),false,'không được nhúng lại css/js vào file TS');

  const pack=fs.readFileSync(path.join(root,'scripts/package-vsix.js'),'utf8');
  assert.ok(/'media'/.test(pack),'vsix phải copy media');
  assert.ok(pack.includes('Extension="css"'),'[Content_Types].xml phải khai css');
});

test('the shipped webview script is valid JavaScript on its own',()=>{
  const src=fs.readFileSync(path.join(process.cwd(),'media/webview/chat.js'),'utf8');
  // Trước đây script nằm trong template literal của TS: một backtick lẻ trong comment là
  // đóng chuỗi và hỏng build. Giờ là file thật nên kiểm tra trực tiếp.
  new (require('node:vm').Script)(src);
  assert.ok(src.includes('acquireVsCodeApi'));
});
