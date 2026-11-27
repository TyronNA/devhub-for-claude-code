export {};
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const vscodeMock={ViewColumn:{Beside:2},window:{},Uri:{file:(p:string)=>p},workspace:{getConfiguration:()=>({get:(_k:string,d:any)=>d})}};

/** DOM tối giản đủ để chạy thật hàm markdown() sinh ra trong webview. */
function makeDom(){
  const mk=(tag:string):any=>({tag,className:'',dataset:{} as any,title:'',_text:'',children:[] as any[],
    set textContent(v:string){this._text=v;this.children=[]},
    get textContent():string{return this._text||this.children.map((c:any)=>c.textContent??c.text??'').join('')},
    appendChild(c:any){this.children.push(c);return c},
    get lastChild(){return this.children[this.children.length-1]},
    querySelector(){return null},addEventListener(){},setAttribute(){},setSelectionRange(){},focus(){},
    style:{},value:'',placeholder:'',disabled:false,hidden:false,
    classList:{add(){},remove(){},contains(){return false}}});
  return {createElement:mk,createElementNS:()=>mk('svg'),createTextNode:(t:string)=>({text:t,textContent:t,children:[]}),
    getElementById:()=>mk('div'),addEventListener(){},activeElement:null};
}
function loadMarkdown(){
  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    delete require.cache[require.resolve('../../src/devhub/views/chatPanelProvider')];
    const {ChatPanelProvider}=require('../../src/devhub/views/chatPanelProvider');
    const c=new ChatPanelProvider({on:()=>()=>{}},{},async()=>({workspaces:[],projects:[]}),()=>{},()=>{},()=>{});
    const js=c.html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
    const body=js.replace('const vscode=acquireVsCodeApi();','const vscode={postMessage(){},setState(){},getState(){}};')
                 // Dòng boot ở cuối script (`ready` + render lần đầu) cần DOM thật; harness này
                 // chỉ có vài node giả. Cắt cả dòng thay vì so khớp nguyên văn — pin đúng chuỗi
                 // là hỏng ngay lần kế có ai thêm một lệnh vào cuối dòng đó.
                 .replace(/^vscode\.postMessage\(\{type:'ready'\}\).*$/m,'');
    const fn=new Function('document','window',body+'\nreturn {markdown,inline,toolRow,oneLine,isTableSep};');
    const doc=makeDom();
    return {api:fn(doc,{addEventListener(){},innerHeight:800}),doc};
  }finally{Module._load=original;}
}
const flat=(n:any):string=>n.children.map((c:any)=>c.text??(c._text||flat(c))).join('');
const tags=(n:any):string[]=>n.children.flatMap((c:any)=>c.tag?[c.tag,...tags(c)]:[]);

test('bold, inline code and italics become real elements, not literal asterisks',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'Trạng thái: **chưa commit** ở `bot.mjs` và *tạm ổn*');
  const t=tags(root);
  assert.ok(t.includes('strong'),'thiếu <strong>');
  assert.ok(t.includes('code'),'thiếu <code>');
  assert.ok(t.includes('em'),'thiếu <em>');
  assert.equal(/\*\*|`/.test(flat(root)),false,'không được còn ký tự markdown thô: '+flat(root));
  assert.ok(flat(root).includes('chưa commit')&&flat(root).includes('bot.mjs'));
});

test('bullet and numbered lists build real list elements',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'- Commit đống thay đổi\n- Soi lại log bot\n- Việc khác');
  const ul=root.children.find((c:any)=>c.tag==='ul');
  assert.ok(ul,'phải có <ul>');
  assert.equal(ul.children.length,3);
  const root2=doc.createElement('div');
  api.markdown(root2,'1. một\n2. hai');
  assert.ok(root2.children.find((c:any)=>c.tag==='ol'),'danh sách đánh số phải là <ol>');
});

test('fenced blocks keep their content verbatim and record the language',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'trước\n```bash\nmake start\necho **not bold**\n```\nsau');
  const pre=root.children.find((c:any)=>c.tag==='pre');
  assert.ok(pre,'thiếu <pre>');
  assert.equal(pre.dataset.lang,'bash');
  assert.equal(pre.textContent,'make start\necho **not bold**','trong fence không được parse markdown');
});

test('headings render and links keep their href out of the visible text',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'## Cần làm gì tiếp?\nxem [PR 271](https://github.com/x/y/pull/271)');
  assert.ok(root.children.some((c:any)=>c.className==='md-h2'),'thiếu heading cấp 2');
  const a=root.children.flatMap((c:any)=>c.children||[]).find((c:any)=>c.tag==='a');
  assert.ok(a,'thiếu <a>');
  assert.equal(a.textContent,'PR 271');
  assert.equal(a.dataset.href,'https://github.com/x/y/pull/271');
});

test('markdown never uses innerHTML, so tags in agent output stay text',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'chú ý <img src=x onerror=alert(1)> và <script>bad()</script>');
  assert.equal(tags(root).some(t=>['img','script'].includes(t)),false,'không được dựng thẻ từ text');
  assert.ok(flat(root).includes('<img src=x'),'phải giữ nguyên dưới dạng text');
});

test('a tool call collapses to one line with the output folded behind a count',()=>{
  const {api,doc}=loadMarkdown();
  const root=doc.createElement('div');
  const long='cd orchestrator; grep -n "compact" app/slack_bot/bridge_sdk.py | sed -n \'50,200p\'; echo ---; grep -rn "compact" app/config.py app/slack_bot/claude_bridge.py 2>/dev/null | head -30';
  api.toolRow(root,'Bash',long,'line1\nline2\nline3\nline4',1);

  // Lệnh bị cắt thì chính nó cũng phải bung được, nếu không thân script mất hẳn khỏi UI.
  const cdet=root.children[0];
  assert.equal(cdet.tag,'details','lệnh dài phải gập lại');
  const head=cdet.children[0].children[0];
  assert.equal(head.className,'trow');
  assert.equal(head.children[0].textContent,'Bash');
  const arg=head.children[1].textContent;
  assert.equal(arg.includes('\n'),false,'lệnh phải nằm gọn một dòng');
  assert.ok(arg.length<=115,'phải cắt ngắn, đang '+arg.length);
  assert.ok(arg.endsWith('…)'),'phải có dấu … khi cắt: '+arg.slice(-8));
  assert.equal(cdet.children[1].textContent,long,'mở ra phải là lệnh đầy đủ');

  const det=root.children[1];
  assert.equal(det.tag,'details','output phải gập lại');
  const sum=det.children[0];
  assert.equal(sum.children[0].textContent,'line1','xem trước đúng dòng đầu');
  assert.equal(sum.children[1].textContent,'+3 lines','đếm đúng phần còn lại');
  assert.equal(sum.children[2].textContent,'exit 1','lệnh fail không được nhìn giống lệnh pass');
  assert.equal(det.children[1].textContent,'line1\nline2\nline3\nline4','mở ra phải đủ');
});

test('a tool row with no argument yet shows an ellipsis instead of empty parens',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.toolRow(root,'Bash','',undefined,null);
  assert.equal(root.children.length,1,'chưa có tham số thì không dựng details');
  assert.equal(root.children[0].children[1].textContent,'(…)');
});

test('a short command with no output stays a single row',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.toolRow(root,'Read','src/app.ts','',null);
  assert.equal(root.children.length,1,'không có output thì không dựng details');
  assert.equal(root.children[0].children[1].textContent,'(src/app.ts)');
});

test('pipe tables become real table elements with a header row',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'trước\n| | trước | sau |\n|---|---|---|\n| body | 13px | **14px** |\n| chip | 12 | 13 |\nsau');
  const tbl=root.children.find((c:any)=>c.tag==='table');
  assert.ok(tbl,'phải dựng <table>');
  const thead=tbl.children[0],tbody=tbl.children[1];
  assert.equal(thead.children[0].children.length,3,'3 cột header');
  assert.equal(thead.children[0].children[1].textContent,'trước');
  assert.equal(tbody.children.length,2,'2 hàng dữ liệu');
  assert.equal(tbody.children[0].children[0].textContent,'body');
  // inline markdown vẫn phải chạy trong ô
  const bold=tbody.children[0].children[2].children.find((c:any)=>c.tag==='strong');
  assert.ok(bold,'**14px** trong ô phải thành <strong>');
  // đoạn văn quanh bảng không bị nuốt
  assert.ok(root.children.some((c:any)=>c.className==='md-p'),'giữ lại đoạn văn');
});

test('a line with pipes but no separator row stays a paragraph',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'chạy a | b | c rồi xem');
  assert.equal(root.children.some((c:any)=>c.tag==='table'),false,'không được nhầm ống dẫn thành bảng');
});

test('blockquote, rule, task list, strikethrough, nesting and bare URLs all render',()=>{
  const {api,doc}=loadMarkdown();
  const q=doc.createElement('div');api.markdown(q,'> chú ý\n> dòng hai');
  assert.ok(q.children.some((c:any)=>c.tag==='blockquote'),'thiếu blockquote');

  const hr=doc.createElement('div');api.markdown(hr,'trên\n\n---\n\ndưới');
  assert.ok(hr.children.some((c:any)=>c.tag==='hr'),'thiếu <hr>');

  const t=doc.createElement('div');api.markdown(t,'- [ ] chưa xong\n- [x] xong rồi');
  const items=t.children.find((c:any)=>c.tag==='ul').children;
  assert.equal(items[0].className,'md-task');
  assert.equal(items[0].children[0].textContent,'☐');
  assert.equal(items[1].children[0].textContent,'☑');

  const st=doc.createElement('div');api.markdown(st,'cái này ~~bỏ rồi~~ nhé');
  assert.ok(tags(st).includes('s'),'thiếu <s> cho ~~gạch~~');

  const bi=doc.createElement('div');api.markdown(bi,'***vừa đậm vừa nghiêng***');
  assert.ok(tags(bi).includes('strong')&&tags(bi).includes('em'),'*** phải ra strong+em');

  const nest=doc.createElement('div');api.markdown(nest,'- ngoài\n  - trong\n  - trong 2\n- ngoài 2');
  const outer=nest.children.find((c:any)=>c.tag==='ul');
  assert.equal(outer.children.length,2,'2 mục ngoài');
  assert.ok(tags(outer.children[0]).includes('ul'),'mục đầu phải chứa list lồng');

  const url=doc.createElement('div');api.markdown(url,'xem https://github.com/x/y nhé');
  const a=url.children[0].children.find((c:any)=>c.tag==='a');
  assert.ok(a&&a.dataset.href==='https://github.com/x/y','URL trần phải thành link');

  const esc=doc.createElement('div');api.markdown(esc,'giá 5\\*3 không phải nghiêng');
  assert.equal(tags(esc).includes('em'),false,'\\* phải được thoát');
});

test('consecutive lines join into one paragraph but structure still breaks it',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'dòng một\ndòng hai\n\n- mục\ndòng ba');
  const paras=root.children.filter((c:any)=>c.className==='md-p');
  assert.equal(paras[0].textContent,'dòng một dòng hai','2 dòng liền phải gộp 1 đoạn');
  assert.ok(root.children.some((c:any)=>c.tag==='ul'),'list vẫn tách ra');
});
