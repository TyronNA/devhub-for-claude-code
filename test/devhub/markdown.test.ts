export {};
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const vscodeMock={ViewColumn:{Beside:2},window:{},Uri:{file:(p:string)=>p},workspace:{getConfiguration:()=>({get:(_k:string,d:any)=>d})}};

/** A minimal DOM, just enough to really run the markdown() function produced in the webview. */
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
                 // The boot line at the end of the script (`ready` + first render) needs a real DOM; this harness
                 // only has a few fake nodes. Cut the whole line rather than match it verbatim — pinning the exact string
                 // breaks the next time someone adds a statement to the end of that line.
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
  api.markdown(root,'Status: **not committed** in `bot.mjs` and *mostly fine*');
  const t=tags(root);
  assert.ok(t.includes('strong'),'missing <strong>');
  assert.ok(t.includes('code'),'missing <code>');
  assert.ok(t.includes('em'),'missing <em>');
  assert.equal(/\*\*|`/.test(flat(root)),false,'no raw markdown characters may remain: '+flat(root));
  assert.ok(flat(root).includes('not committed')&&flat(root).includes('bot.mjs'));
});

test('bullet and numbered lists build real list elements',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'- Commit the pending changes\n- Check the bot log again\n- Something else');
  const ul=root.children.find((c:any)=>c.tag==='ul');
  assert.ok(ul,'must have a <ul>');
  assert.equal(ul.children.length,3);
  const root2=doc.createElement('div');
  api.markdown(root2,'1. one\n2. two');
  assert.ok(root2.children.find((c:any)=>c.tag==='ol'),'a numbered list must be an <ol>');
});

test('fenced blocks keep their content verbatim and record the language',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'before\n```bash\nmake start\necho **not bold**\n```\nafter');
  const pre=root.children.find((c:any)=>c.tag==='pre');
  assert.ok(pre,'missing <pre>');
  assert.equal(pre.dataset.lang,'bash');
  assert.equal(pre.textContent,'make start\necho **not bold**','markdown must not be parsed inside a fence');
});

test('headings render and links keep their href out of the visible text',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'## What next?\nsee [PR 271](https://github.com/x/y/pull/271)');
  assert.ok(root.children.some((c:any)=>c.className==='md-h2'),'missing level-2 heading');
  const a=root.children.flatMap((c:any)=>c.children||[]).find((c:any)=>c.tag==='a');
  assert.ok(a,'missing <a>');
  assert.equal(a.textContent,'PR 271');
  assert.equal(a.dataset.href,'https://github.com/x/y/pull/271');
});

test('markdown never uses innerHTML, so tags in agent output stay text',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'note <img src=x onerror=alert(1)> and <script>bad()</script>');
  assert.equal(tags(root).some(t=>['img','script'].includes(t)),false,'no tags may be built from text');
  assert.ok(flat(root).includes('<img src=x'),'must be kept as text');
});

test('a tool call collapses to one line with the output folded behind a count',()=>{
  const {api,doc}=loadMarkdown();
  const root=doc.createElement('div');
  const long='cd orchestrator; grep -n "compact" app/slack_bot/bridge_sdk.py | sed -n \'50,200p\'; echo ---; grep -rn "compact" app/config.py app/slack_bot/claude_bridge.py 2>/dev/null | head -30';
  api.toolRow(root,'Bash',long,'line1\nline2\nline3\nline4',1);

  // A truncated command must itself expand, or the script body disappears from the UI entirely.
  const cdet=root.children[0];
  assert.equal(cdet.tag,'details','a long command must be folded');
  const head=cdet.children[0].children[0];
  assert.equal(head.className,'trow');
  assert.equal(head.children[0].textContent,'Bash');
  const arg=head.children[1].textContent;
  assert.equal(arg.includes('\n'),false,'the command must fit on one line');
  assert.ok(arg.length<=115,'must be shortened, currently '+arg.length);
  assert.ok(arg.endsWith('…)'),'must have … when shortened: '+arg.slice(-8));
  assert.equal(cdet.children[1].textContent,long,'expanded must show the full command');

  const det=root.children[1];
  assert.equal(det.tag,'details','output must be folded');
  const sum=det.children[0];
  assert.equal(sum.children[0].textContent,'line1','preview shows exactly the first line');
  assert.equal(sum.children[1].textContent,'+3 lines','counts the remainder correctly');
  assert.equal(sum.children[2].textContent,'exit 1','a failing command must not look like a passing one');
  assert.equal(det.children[1].textContent,'line1\nline2\nline3\nline4','expanded must be complete');
});

test('a tool row with no argument yet shows an ellipsis instead of empty parens',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.toolRow(root,'Bash','',undefined,null);
  assert.equal(root.children.length,1,'no arguments yet means no details');
  assert.equal(root.children[0].children[1].textContent,'(…)');
});

test('a short command with no output stays a single row',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.toolRow(root,'Read','src/app.ts','',null);
  assert.equal(root.children.length,1,'no output means no details');
  assert.equal(root.children[0].children[1].textContent,'(src/app.ts)');
});

test('pipe tables become real table elements with a header row',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'before\n| | before | after |\n|---|---|---|\n| body | 13px | **14px** |\n| chip | 12 | 13 |\nafter');
  const tbl=root.children.find((c:any)=>c.tag==='table');
  assert.ok(tbl,'must build a <table>');
  const thead=tbl.children[0],tbody=tbl.children[1];
  assert.equal(thead.children[0].children.length,3,'3 header columns');
  assert.equal(thead.children[0].children[1].textContent,'before');
  assert.equal(tbody.children.length,2,'2 data rows');
  assert.equal(tbody.children[0].children[0].textContent,'body');
  // inline markdown must still run inside cells
  const bold=tbody.children[0].children[2].children.find((c:any)=>c.tag==='strong');
  assert.ok(bold,'**14px** in a cell must become <strong>');
  // the paragraphs around the table are not swallowed
  assert.ok(root.children.some((c:any)=>c.className==='md-p'),'keeps the paragraphs');
});

test('a line with pipes but no separator row stays a paragraph',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'run a | b | c then look');
  assert.equal(root.children.some((c:any)=>c.tag==='table'),false,'a pipe must not be mistaken for a table');
});

test('blockquote, rule, task list, strikethrough, nesting and bare URLs all render',()=>{
  const {api,doc}=loadMarkdown();
  const q=doc.createElement('div');api.markdown(q,'> note\n> line two');
  assert.ok(q.children.some((c:any)=>c.tag==='blockquote'),'missing blockquote');

  const hr=doc.createElement('div');api.markdown(hr,'above\n\n---\n\nbelow');
  assert.ok(hr.children.some((c:any)=>c.tag==='hr'),'missing <hr>');

  const t=doc.createElement('div');api.markdown(t,'- [ ] not done\n- [x] done');
  const items=t.children.find((c:any)=>c.tag==='ul').children;
  assert.equal(items[0].className,'md-task');
  assert.equal(items[0].children[0].textContent,'☐');
  assert.equal(items[1].children[0].textContent,'☑');

  const st=doc.createElement('div');api.markdown(st,'this one is ~~gone~~ ok');
  assert.ok(tags(st).includes('s'),'missing <s> for ~~strike~~');

  const bi=doc.createElement('div');api.markdown(bi,'***bold and italic***');
  assert.ok(tags(bi).includes('strong')&&tags(bi).includes('em'),'*** must give strong+em');

  const nest=doc.createElement('div');api.markdown(nest,'- outer\n  - inner\n  - inner 2\n- outer 2');
  const outer=nest.children.find((c:any)=>c.tag==='ul');
  assert.equal(outer.children.length,2,'2 outer items');
  assert.ok(tags(outer.children[0]).includes('ul'),'the first item must contain the nested list');

  const url=doc.createElement('div');api.markdown(url,'see https://github.com/x/y ok');
  const a=url.children[0].children.find((c:any)=>c.tag==='a');
  assert.ok(a&&a.dataset.href==='https://github.com/x/y','a bare URL must become a link');

  const esc=doc.createElement('div');api.markdown(esc,'price 5\\*3 is not italic');
  assert.equal(tags(esc).includes('em'),false,'\\* must be escaped');
});

test('consecutive lines join into one paragraph but structure still breaks it',()=>{
  const {api,doc}=loadMarkdown();const root=doc.createElement('div');
  api.markdown(root,'line one\nline two\n\n- item\nline three');
  const paras=root.children.filter((c:any)=>c.className==='md-p');
  assert.equal(paras[0].textContent,'line one line two','2 adjacent lines must merge into 1 paragraph');
  assert.ok(root.children.some((c:any)=>c.tag==='ul'),'the list still breaks out');
});
