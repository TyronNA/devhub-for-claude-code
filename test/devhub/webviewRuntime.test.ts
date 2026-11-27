export {};
declare const global:any;
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const vscodeMock={ViewColumn:{Beside:2},window:{},Uri:{file:(p:string)=>p},workspace:{getConfiguration:()=>({get:(_k:string,d:any)=>d})}};

/**
 * Runs the webview script FOR REAL in a fake DOM. Syntax tests can't catch runtime errors —
 * one `$('compact')` pointing at a nonexistent id once killed the whole script and made Enter do nothing.
 */
function boot(initialState?:any,opts?:{touch?:boolean}){
  const listeners:Record<string,[string,Function][]>={};
  const byId:Record<string,any>={};
  const mk=(tag:string):any=>({tag,className:'',dataset:{} as any,title:'',
    // The real style is a CSSStyleDeclaration: direct assignment WORKS, and setProperty for CSS variables must too.
    style:{_v:{} as any,setProperty(k:string,v:string){this._v[k]=v},removeProperty(k:string){delete this._v[k]}},
    value:'',placeholder:'',
    disabled:false,hidden:false,children:[] as any[],_t:'',scrollTop:0,clientHeight:200,
    // Count reads: every scrollHeight read after a DOM change forces the browser to compute layout.
    _shReads:0,
    get scrollHeight():number{this._shReads++;return (this.children.length||0)*20},
    set textContent(v:string){this._t=v;this.children=[]},
    get textContent():string{return this._t||this.children.map((c:any)=>c.textContent??c.text??'').join('')},
    get lastChild(){return this.children[this.children.length-1]},
    get lastElementChild(){return this.children[this.children.length-1]},
    get firstChild(){return this.children[0]},get firstElementChild(){return this.children[0]},
    // A real DocumentFragment MOVES its children to the target node, it doesn't become a child itself.
    // parentNode like the real DOM: webview code uses it to know whether a row is still in the tree or was pruned.
    appendChild(c:any){if(c&&c.tag==='#fragment'){for(const g of c.children.splice(0)){g.parentNode=this;this.children.push(g)}return c}
      c.parentNode=this;this.children.push(c);return c},prepend(c:any){c.parentNode=this;this.children.unshift(c)},
    insertBefore(c:any){c.parentNode=this;this.children.unshift(c);return c},
    removeChild(c:any){const i=this.children.indexOf(c);if(i>=0){this.children.splice(i,1);c.parentNode=null}},
    querySelector(sel:string){const f=(n:any):any=>{for(const c of n.children||[]){
      if(('.'+c.className).includes(sel)||c.tag===sel)return c;const r=f(c);if(r)return r}};return f(this)||null},
    closest:()=>null,setAttribute(k:string,v:any){this.dataset[k]=v},getAttribute:()=>undefined,
    addEventListener(ev:string,fn:Function){(listeners[this.id||this.tag]??=[]).push([ev,fn])},
    setSelectionRange(){},click(){this._clicks=(this._clicks||0)+1},
    get tagName(){return String(this.tag||'div').toUpperCase()},
    // `focus()` must move `activeElement`: chat.js only trusts the keyboard when an input has focus.
    focus(){document.activeElement=this},
    // Real DOM: classList and className are the SAME place. The old mock split them so
    // `el(...,'msg assistant assistant-streaming')` then `classList.contains(...)` gave false —
    // every "append to the streaming node" branch silently went untested.
    get classList(){const self=this as any;
      const parts=()=>self.className?String(self.className).split(/\s+/).filter(Boolean):[];
      const put=(a:string[])=>{self.className=a.join(' ')};
      return {add:(...cs:string[])=>{const a=parts();for(const c of cs)if(!a.includes(c))a.push(c);put(a)},
        remove:(...cs:string[])=>put(parts().filter(c=>!cs.includes(c))),
        contains:(c:string)=>parts().includes(c),
        toggle:(c:string,on?:boolean)=>{const a=parts(),has=a.includes(c);
          if(on===undefined?has:!on)put(a.filter(x=>x!==c));else if(!has)put(a.concat(c))}}}});
  const document:any={createElement:mk,createElementNS:()=>mk('svg'),createDocumentFragment:()=>mk('#fragment'),
    createTextNode:(t:string)=>({text:t,textContent:t,children:[]}),
    // #input's tag must be a real textarea: `editing()` tells inputs apart by `tagName`.
    getElementById:(id:string)=>(byId[id]??=Object.assign(mk(id==='input'?'textarea':id==='file'?'input':'div'),{id})),
    body:mk('body'),activeElement:null,
    addEventListener:(ev:string,fn:Function)=>(listeners.__doc??=[]).push([ev,fn])};
  const posted:any[]=[];
  const win:any={addEventListener:(ev:string,fn:Function)=>(listeners.__win??=[]).push([ev,fn]),innerHeight:900};
  // visualViewport: the ONLY place that shows the remaining area when the iOS keyboard is open.
  const vv:any={height:900,addEventListener:(ev:string,fn:Function)=>(listeners.__vv??=[]).push([ev,fn])};
  win.visualViewport=vv;
  // The composer reads `(hover:none)` once at load to know whether there is a physical keyboard.
  win.matchMedia=(q:string)=>({media:q,matches:!!(opts&&opts.touch)&&/hover:\s*none/.test(q),addEventListener(){}});
  (global as any).Image=class{onload:any;set src(_v:string){(this as any).naturalWidth=10;(this as any).naturalHeight=5;this.onload&&this.onload()}};
  (global as any).FileReader=class{onload:any;result='data:image/png;base64,aGk=';readAsDataURL(){this.onload&&this.onload()}};
  const warnings:string[]=[];

  const original=Module._load;
  Module._load=function(r:string){if(r==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  let js:string;
  try{
    delete require.cache[require.resolve('../../src/devhub/views/chatPanelProvider')];
    const {ChatPanelProvider}=require('../../src/devhub/views/chatPanelProvider');
    js=new ChatPanelProvider({on:()=>()=>{}},{},async()=>({workspaces:[],projects:[]}),()=>{},()=>{},()=>{})
      .html({}).match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  }finally{Module._load=original;}

  // The spinner uses setInterval; left real, node won't exit after the tests finish.
  const timers:any[]=[];
  const fakeSetInterval=(fn:Function,ms:number)=>{const id={fn,ms};timers.push(id);return id};
  const fakeClearInterval=(id:any)=>{const i=timers.indexOf(id);if(i>=0)timers.splice(i,1)};
  // rAF runs immediately: autoscroll is batched per frame, left real the test can't see the scroll result.
  const frames:Function[]=[];
  const fakeRaf=(fn:Function)=>{frames.push(fn);fn();return frames.length};
  // setState/getState is the ONLY thing that survives Reload Window (the DOM doesn't) —
  // the mock must really store, or drafts can't be tested.
  const store={value:initialState};
  new Function('document','window','acquireVsCodeApi','console','setInterval','clearInterval','setTimeout','requestAnimationFrame',js)(
    document,win,()=>({postMessage:(m:any)=>posted.push(m),
      setState(v:any){store.value=v},getState(){return store.value}}),
    {warn:(...a:any[])=>warnings.push(a.join(' ')),log(){},error:(...a:any[])=>warnings.push('error '+a.join(' '))},
    fakeSetInterval,fakeClearInterval,(fn:Function)=>{fn();return 0},fakeRaf);

  const post=(x:any)=>{for(const [e,f] of (listeners.__win||[]))if(e==='message')f({data:x})};
  const fire=(id:string,ev:string,arg?:any)=>{const hit=(listeners[id]||[]).filter(([e])=>e===ev);
    assert.ok(hit.length,`no listener ${ev} on #${id}`);for(const [,f] of hit)f(arg)};
  const keyboard=(height:number)=>{vv.height=height;
    for(const [e,f] of (listeners.__vv||[]))if(e==='resize')f({})};
  /** The keyboard can't open with nothing focused, so the test must state the input holds focus. */
  const focusInput=()=>{document.getElementById('input').focus()};
  const blurInput=()=>{document.activeElement=null;
    for(const [e,f] of (listeners.__doc||[]))if(e==='focusout')f({})};
  const docFire=(ev:string,arg:any)=>{for(const [e,f] of (listeners.__doc||[]))if(e===ev)f(arg)};
  return {document,win,docFire,posted,post,fire,warnings,byId,timers,frames,store,vv,keyboard,focusInput,blurInput};
}
const SESSION=(status:string)=>({provider:'claude',nativeSessionId:'a',status,usage:{inputTokens:5,contextUsedTokens:100,contextWindowTokens:1000}});

test('the webview survives every message type it can receive',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'optionsChanged',model:'opus',effort:'medium',provider:'claude'});
  for(const event of [
    {type:'assistant_delta',text:'**bold** `code`'},
    {type:'command_started',command:'ls -la',output:'a\nb\nc',exitCode:0},
    {type:'tool_started',tool:'Read',label:'x.ts'},
    {type:'file_changed',change:'edit',path:'/tmp/x.ts'},
    {type:'usage',usage:{costUsd:0.5}},
    {type:'warning',message:'w'},{type:'error',message:'e'},
    {type:'turn_done'},
  ]) w.post({type:'event',sessionId:'a',event});
  w.post({type:'eventBatch',items:[{sessionId:'a',event:{type:'assistant_delta',text:'x'}}]});
  w.post({type:'permission',request:{requestId:'r1',toolName:'Bash',input:{command:'rm x'}}});
  w.post({type:'permissionClosed',requestId:'r1',note:'the turn ended'});
  w.post({type:'attachment',path:'/tmp/img.png'});
  w.post({type:'insertText',text:'/commit '});
  w.post({type:'sessionUpdated',session:SESSION('running')});
  w.post({type:'error',message:'boom'});
  w.post({type:'scm',status:{branch:'main',ahead:1,behind:0,files:2,untracked:1,added:3,removed:4,changes:[]}});
  w.post({type:'scm'});
  w.post({type:'empty'});
  w.post({type:'draftSelected',draft:{provider:'planner',workspace:{name:'W'},project:{name:'P'}}});
  assert.deepEqual(w.warnings,[],'there must be no warnings/errors: '+w.warnings.join(' | '));
});

test('Enter sends, Shift+Enter does not, and a running turn queues instead of dropping',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const input=w.document.getElementById('input');

  input.value='check prod';w.posted.length=0;
  let prevented=false;
  w.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault:()=>{prevented=true}});
  assert.equal(prevented,true,'Enter must block the newline');
  assert.deepEqual(w.posted,[{type:'sendPrompt',text:'check prod'}]);

  input.value='newline';w.posted.length=0;
  w.fire('input','keydown',{key:'Enter',shiftKey:true,preventDefault:()=>assert.fail('Shift+Enter must not be blocked')});
  assert.deepEqual(w.posted,[],'Shift+Enter only inserts a newline');

  // The webview used to block by itself while running, so messages vanished. Now it still sends to the host,
  // and the host decides to queue — so typed text isn't lost.
  w.post({type:'sessionUpdated',session:SESSION('running')});
  input.value='second turn';w.posted.length=0;
  w.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault(){}});
  assert.deepEqual(w.posted,[{type:'sendPrompt',text:'second turn'}],'while running it is sent up for the host to queue');
  assert.equal(input.value,'','the input must be empty after queuing');
});

test('Cmd+C copies a selection inside the frame instead of trusting the workbench to',()=>{
  const w=boot();let copies=0,sel='';
  w.document.execCommand=(c:string)=>{if(c==='copy')copies++;return true};
  w.win.getSelection=()=>({isCollapsed:!sel,toString:()=>sel});
  const key=(k:any)=>w.docFire('keydown',Object.assign({keyCode:67,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false},k));
  key({metaKey:true});assert.equal(copies,0,'no selection means VS Code handles it');
  sel='a passage';key({metaKey:true});assert.equal(copies,1,'Cmd+C with a selection must copy by itself');
  key({ctrlKey:true});assert.equal(copies,2,'Ctrl+C too');
  key({metaKey:true,shiftKey:true});key({metaKey:true,keyCode:86});assert.equal(copies,2,'other keys are untouched');
});

test('the host owns the queue: webview only renders what it is told, and can remove one',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'queue',items:['one','hai']});
  const rows=w.document.getElementById('queue').children;
  assert.equal(rows.length,2,'two messages in the queue');
  assert.ok(rows[1].textContent.includes('hai'));
  w.posted.length=0;
  rows[0].children[2].onclick();
  assert.deepEqual(w.posted,[{type:'dequeue',index:0}]);
  // The host is the source of truth: the webview doesn't remove from the DOM before the host confirms.
  assert.equal(w.document.getElementById('queue').children.length,2);
  w.post({type:'queue',items:['hai']});
  assert.equal(w.document.getElementById('queue').children.length,1);
});

test('every composer control is wired',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const expect:Record<string,string>={slash:'pickSlash',model:'pickModel',effort:'pickEffort',
    provider:'pickProvider',crumb:'pickProject',history:'pickHistory',newtab:'newTab',cancel:'cancel',
    copyid:'copySessionId'};
  for(const [id,type] of Object.entries(expect)){
    w.posted.length=0;w.fire(id,'click',{});
    assert.ok(w.posted.some(p=>p.type===type),`#${id} must send ${type}`);
  }
  // The context ring IS the compact button — but it must be the real compact action, not
  // sending the string "/compact" as a prompt.
  w.posted.length=0;w.fire('ctxwrap','click',{});
  assert.deepEqual(w.posted,[{type:'compact'}],'clicking the context ring sends compact');

  w.posted.length=0;
  w.fire('input','paste',{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>({type:'image/png',name:'a.png'})}]},preventDefault(){}});
  assert.ok(w.posted.some(p=>p.type==='pasteImage'),'pasting an image must send pasteImage');

  w.document.getElementById('input').value='/';w.posted.length=0;
  w.fire('input','input',{});
  assert.ok(w.posted.some(p=>p.type==='pickSlash'),'typing "/" opens the picker');
});

test('a pasted image rides along on send instead of sitting in the textarea',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'attachment',path:'/tmp/shot.png'});
  const input=w.document.getElementById('input');
  assert.equal(input.value,'','the path must not be stuffed into the input');
  input.value='look at this image';w.posted.length=0;
  w.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault(){}});
  // Images are a separate field; the host decides how to join paths into the prompt.
  assert.deepEqual(w.posted,[{type:'sendPrompt',text:'look at this image',attachments:['/tmp/shot.png']}]);
});

test('a long transcript is built off-document instead of reflowing once per event',()=>{
  const w=boot();
  const events=Array.from({length:300},(_,i)=>({type:'assistant_message',text:'line '+i}));
  const m=w.document.getElementById('messages');
  m._shReads=0;
  w.post({type:'sessionSelected',session:SESSION('done'),events,workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,300,'must build every event');
  // The old way: addEvent set m.scrollTop=m.scrollHeight after EVERY event -> 300 layout measurements.
  assert.ok(m._shReads<=2,`opening a long transcript may measure layout only once, saw ${m._shReads}`);
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a truncated transcript offers older pages and keeps the reader in place when they arrive',()=>{
  const w=boot();
  const ev=(n:number,from:number)=>Array.from({length:n},(_,i)=>({type:'assistant_message',text:'m'+(from+i)}));
  const m=w.document.getElementById('messages');
  w.post({type:'sessionSelected',session:SESSION('done'),events:ev(200,250),older:250,workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,201,'200 events + load-more button');
  assert.ok(String(m.children[0].className).includes('older'),'the button must be at the top');
  w.fire('button','click');
  assert.deepEqual(w.posted.filter((x:any)=>x.type==='loadOlder'),[{type:'loadOlder'}]);
  assert.equal(m.children[0].disabled,true,'locks once clicked, no double fire');
  m.scrollTop=1000;const fromEnd=m.scrollHeight-m.scrollTop;
  w.post({type:'sessionSelected',session:SESSION('done'),events:ev(400,50),older:50,keepScroll:true,workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.scrollHeight-m.scrollTop,fromEnd,'loading more above must not jump the reading position');
  w.post({type:'sessionSelected',session:SESSION('done'),events:ev(3,0),workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,3,'no `older` (panel) means no button');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('streaming does not yank the view down while the user is reading further up',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  for(let i=0;i<30;i++)w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'x'+i}});
  m.scrollTop=0;w.fire('messages','scroll',{});   // the user scrolls up to re-read
  w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'new'}});
  assert.equal(m.scrollTop,0,'reading above must not be yanked to the bottom');
  // Scrolling back to the bottom must stick to the bottom again.
  m.scrollTop=m.scrollHeight;w.fire('messages','scroll',{});
  m.scrollTop=m.scrollHeight-1;
  w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'newer'}});
  assert.equal(m.scrollTop,m.scrollHeight,'at the bottom it keeps sticking to the bottom');
});

test('sending your own message always scrolls it into view',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  for(let i=0;i<30;i++)w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'x'+i}});
  m.scrollTop=0;                        // scrolled up re-reading
  w.post({type:'event',sessionId:'a',event:{type:'user_message',text:'my new message'}});
  // Conditional scrolling is right for agent output, but your own message sitting
  // below the screen looks like it was lost.
  assert.ok(m.scrollTop>0,'your own message must be scrolled to');
  w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'reply'}});
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('an attachment chip opens the image, and only once the host has saved it',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const box=w.document.getElementById('attachments');
  // Pasting an image: the chip shows at once, but with no path yet -> not clickable.
  w.fire('input','paste',{clipboardData:{items:[{kind:'file',type:'image/png',
    getAsFile:()=>({type:'image/png',name:'a.png'})}]},preventDefault(){}});
  assert.equal(box.children.length,1);
  assert.equal(typeof box.children[0].onclick,'undefined','no path yet means openFile must not be sent');

  w.post({type:'attachment',path:'/tmp/shot.png'});
  const chip=box.children[0];
  assert.equal(typeof chip.onclick,'function','once the host has saved it the chip opens the image');
  w.posted.length=0;
  chip.onclick({target:{className:'thumb'}});
  assert.deepEqual(w.posted,[{type:'openFile',path:'/tmp/shot.png'}]);
  // Clicking the remove button must not open the image too.
  w.posted.length=0;
  chip.onclick({target:{className:'attx'}});
  assert.deepEqual(w.posted,[]);
});

test('the thinking spinner starts and stops with the turn, leaving no timer behind',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.timers.length,1,'while running there must be exactly 1 clock');
  assert.equal(w.document.getElementById('thinking').hidden,false);
  w.post({type:'sessionUpdated',session:SESSION('done')});
  assert.equal(w.timers.length,0,'a finished turn must cancel the clock, no leak');
  assert.equal(w.document.getElementById('thinking').hidden,true);
});

test('every ring measures what is LEFT, and the quota rings vanish for a provider without quota',()=>{
  const w=boot();
  const resets=Date.now()+2.5*60*60*1000;
  w.post({type:'sessionSelected',session:{...SESSION('done'),
    usage:{contextUsedTokens:100,contextWindowTokens:1000,
      quota5hUsedPercentage:54,quota5hObservedAt:Date.now(),quota5hResetsAt:resets,
      quota7dUsedPercentage:31,quota7dObservedAt:Date.now()}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  const CIRC=2*Math.PI*10;
  assert.equal(w.byId.q5wrap.hidden,false);
  assert.equal(w.byId.q5lab.textContent+' '+w.byId.q5text.textContent,'5h 46%','the text is quota LEFT, not used');
  const [dash]=String(w.byId.q5arc.dataset['stroke-dasharray']).split(' ').map(Number);
  assert.ok(Math.abs(dash-CIRC*0.46)<1,'the 5h arc must be 46% of the ring when 54% is used, saw: '+dash);
  const label=w.byId.q5wrap.dataset['aria-label'];
  assert.ok(label.includes('46% left · 54% used'),'the label must state both directions, saw: '+label);
  assert.ok(/in 2h 3[0-9]m/.test(label),'the reset time moves fully into the label, saw: '+label);
  assert.equal(w.byId.q5wrap.title,'','no title: the native tooltip is slow and covers the card');
  const tip=w.byId.q5tip.textContent;
  assert.ok(tip.includes('Five-hour limit')&&tip.includes('46%')&&tip.includes('54% used'),'the hover card is missing numbers, saw: '+tip);
  assert.ok(/Resetsin 2h 3[0-9]m/.test(tip),'the hover card must have a reset countdown, saw: '+tip);
  assert.ok(!w.byId.q7tip.textContent.includes('Resets'),'without resetsAt the 7d card does not invent a reset line');
  // The arc no longer depends on resetsAt: without it it still draws from the % left.
  const [d7]=String(w.byId.q7arc.dataset['stroke-dasharray']).split(' ').map(Number);
  assert.ok(Math.abs(d7-CIRC*0.69)<1,'without resetsAt it still draws from 69% left, saw: '+d7);
  // All three rings go the same way: context 100/1000 used means an arc of 90% of the ring.
  const [dc]=String(w.byId.arc.dataset['stroke-dasharray']).split(' ').map(Number);
  assert.ok(Math.abs(dc-CIRC*0.9)<1,'the context ring also measures what is left, saw: '+dc);
  assert.equal(w.byId.ctxtext.textContent,'90%');
  assert.equal(w.timers.some((t:any)=>t.ms===60000),true,'still keeps the clock for the ~ mark and countdown');

  w.post({type:'sessionSelected',session:{provider:'planner',nativeSessionId:'b',status:'done',usage:{}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.byId.q5wrap.hidden,true,'a session without quota — fully hidden, no "5h —"');
  assert.equal(w.byId.q7wrap.hidden,true);
  assert.equal(w.timers.some((t:any)=>t.ms===60000),false,'no rings left means no clock kept');
});

test('AskUserQuestion renders its options and answering sends them back',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.posted.length=0;
  w.post({type:'permission',request:{requestId:'q1',toolName:'AskUserQuestion',input:{questions:[
    {question:'Tabs or spaces?',header:'Indent',options:[
      {label:'Spaces',description:'two of them'},{label:'Tabs',description:'one of them'}]}]}}});

  const card=w.document.getElementById('messages').children.find((c:any)=>c.className==='perm');
  assert.ok(card,'must build the question card');
  const box=card.children.find((c:any)=>c.className==='qbox');
  assert.equal(box.children[0].textContent,'Tabs or spaces?');
  const opts=box.children[1].children;
  assert.equal(opts.length,2,'the right number of options');
  assert.equal(opts[0].children[0].textContent,'Spaces');
  assert.equal(opts[0].children[1].textContent,'two of them','the description must show');
  assert.equal(w.posted.length,0,'nothing sent before choosing');

  opts[1].onclick();
  assert.deepEqual(w.posted,[{type:'permissionResponse',requestId:'q1',allow:true,answers:{'Tabs or spaces?':'Tabs'}}]);
});

test('a plain tool permission still gets Allow/Deny, not question options',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.posted.length=0;
  w.post({type:'permission',request:{requestId:'p1',toolName:'Bash',input:{command:'rm -rf /'}}});
  const card=w.document.getElementById('messages').children.find((c:any)=>c.className==='perm');
  assert.equal(card.children.some((c:any)=>c.className==='qbox'),false,'not a question');
  const acts=card.children.find((c:any)=>c.className==='pacts');
  assert.deepEqual(acts.children.map((b:any)=>b.textContent),['Allow','Deny']);
});

test('unsent text survives the panel being destroyed when the tab is hidden',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const input=w.document.getElementById('input');
  input.value='unsent message';
  w.fire('input','input',{});
  assert.equal(w.store.value.draftText,'unsent message','the text being typed must be in the webview state');
  assert.equal(w.store.value.nativeSessionId,'a','still keeps the session so the serializer gets the right tab back');

  // Hiding the tab destroys the DOM; reopening runs the script from scratch with that same state.
  const again=boot(w.store.value);
  assert.equal(again.document.getElementById('input').value,'unsent message');
});

test('a pending attachment comes back with the draft, and send clears both',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'attachment',path:'/tmp/shot.png'});
  w.document.getElementById('input').value='with image';
  w.fire('input','input',{});
  assert.deepEqual(w.store.value.atts,['/tmp/shot.png']);

  const again=boot(w.store.value);
  assert.equal(again.document.getElementById('input').value,'with image');
  again.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  again.posted.length=0;
  again.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault(){}});
  assert.deepEqual(again.posted,[{type:'sendPrompt',text:'with image',attachments:['/tmp/shot.png']}],
    'an image restored from state can still be sent along');
  assert.equal(again.store.value.draftText,'','sending must clear the draft, or it refills next time');
  assert.deepEqual(again.store.value.atts,[]);
});

test('a tool call stays one row: the result rewrites the started row, live and on replay',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'command_started',command:'ls -la',callId:'c1'}});
  assert.equal(m.children.length,1);
  w.post({type:'event',sessionId:'a',event:{type:'command_completed',command:'ls -la',output:'a\nb\nc',exitCode:0,callId:'c1'}});
  assert.equal(m.children.length,1,'started + completed must be ONE row, not printed twice');
  assert.ok(m.children[0].textContent.includes('a'),'that row must carry the output');
  // No callId (old transcripts) means matching by the command itself.
  w.post({type:'event',sessionId:'a',event:{type:'tool_started',tool:'Read',label:'/x.ts'}});
  w.post({type:'event',sessionId:'a',event:{type:'tool_completed',tool:'Read',label:'/x.ts',summary:'ok'}});
  assert.equal(m.children.length,2);
  // Reopening a session: replay must merge too, or the transcript doubles.
  w.post({type:'sessionSelected',session:SESSION('done'),events:[
    {type:'command_started',command:'npm test',callId:'c9'},
    {type:'command_completed',command:'npm test',output:'pass',exitCode:0,callId:'c9'}],
    workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,1,'replay is also one row');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a re-posted question redraws once after a re-render, and is not duplicated',()=>{
  const w=boot();
  const REQ={type:'permission',request:{requestId:'q1',toolName:'AskUserQuestion',input:{questions:[
    {question:'Tabs or spaces?',options:[{label:'Spaces'},{label:'Tabs'}]}]}}};
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post(REQ);
  const m=w.document.getElementById('messages');
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,1);

  // The host resends the same request while the card is still in the DOM.
  w.post(REQ);
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,1,'must not be duplicated');

  // Re-rendering wipes the DOM; replay must rebuild the card, or the question vanishes while the CLI still blocks.
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,0);
  w.post(REQ);
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,1,'must reappear after render');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a dead request card is locked with a reason instead of staying clickable',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'permission',request:{requestId:'q1',toolName:'AskUserQuestion',input:{questions:[
    {question:'Tabs or spaces?',options:[{label:'Tabs'}]}]}}});
  const card=w.document.getElementById('messages').children[0];
  w.post({type:'permissionClosed',requestId:'q1',note:'the turn ended'});
  assert.ok(card.classList.contains('answered'),'the card must be locked');
  assert.ok(card.textContent.includes('the turn ended'),'and say why');
  // Resending again must not stack another note.
  const n=card.children.length;
  w.post({type:'permissionClosed',requestId:'q1',note:'the turn ended'});
  assert.equal(card.children.length,n);
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a tool that answers on its own card says so instead of pretending Allow works',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'permission',request:{requestId:'r1',toolName:'mcp__form__ask',requiresUserInteraction:true,input:{}}});
  const card=w.document.getElementById('messages').children[0];
  assert.ok(card.textContent.includes('Allow may be refused'));
  w.post({type:'permission',request:{requestId:'r2',toolName:'Bash',input:{command:'ls'}}});
  const plain=w.document.getElementById('messages').children[1];
  assert.ok(!plain.textContent.includes('Allow may be refused'),'ordinary tools must not get this label');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

/** Collects (tag, class) of the whole subtree — enough to tell whether markdown became elements or is still text. */
function shape(n:any,out:string[]=[]){for(const c of n.children||[]){
  if(c.tag)out.push(c.tag+(c.className?'.'+c.className:''));shape(c,out)}return out}

test('a half-written answer is formatted while it streams, not left as raw markdown',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  const send=(text:string)=>w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text}});
  send('`docker prune` removes **stopped containers**:\n\n');
  send('| Container | Size |\n|---|---|\n| `api` | **491 MB** |\n');
  const card=m.children[0];
  const tags=shape(card);
  assert.ok(tags.includes('code')&&tags.includes('strong'),'while running there must already be code/strong: '+tags.join(','));
  assert.ok(tags.includes('table.md-table'),'the table must be a real table, not a pile of |');
  assert.ok(!card.textContent.includes('**'),'no ** may remain in the text');
  assert.ok(!card.textContent.includes('\u0060'),'no backticks may remain in the text');

  // A settled block is drawn only once: later deltas must not duplicate the first part.
  send('\nmore to come\n');
  assert.equal(shape(m.children[0]).filter(t=>t==='table.md-table').length,1);

  // turn_done redraws from the raw text; the result must match reopening the transcript.
  const raw='`docker prune` removes **stopped containers**:\n\n| Container | Size |\n|---|---|\n| `api` | **491 MB** |\n\nmore to come\n';
  w.post({type:'event',sessionId:'a',event:{type:'turn_done'}});
  const live=shape(m.children[0]);
  w.post({type:'sessionSelected',session:SESSION('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'assistant_message',text:raw}]});
  assert.deepEqual(live,shape(w.document.getElementById('messages').children[0]),'live and replay must produce the same DOM');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('an assistant image event renders an inline preview',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'event',sessionId:'a',event:{type:'assistant_image',src:'data:image/png;base64,aGk=',alt:'image.png'}});
  const card=w.document.getElementById('messages').children[0];
  const img=card.children.find((x:any)=>x.tag==='img');
  assert.ok(img,'there must be an img tag in the assistant message');
  assert.equal(img.className,'assistant-image');
  assert.equal(img.src,'data:image/png;base64,aGk=');
  assert.equal(img.alt,'image.png');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a code fence still streaming keeps its blank lines inside the block',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'```sh\ndocker ps\n\ndocker df\n'}});
  const tags=shape(m.children[0]);
  assert.equal(tags.filter(t=>t.startsWith('pre')).length,1,'an unclosed fence is still ONE block: '+tags.join(','));
  assert.ok(m.children[0].textContent.includes('docker df'),'the part after the blank line must be inside the block');
  // Append to an open fence then close it: the content must match the source character for character.
  w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'docker volume ls\n'}});
  w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'```\n\nxong.\n'}});
  w.post({type:'event',sessionId:'a',event:{type:'turn_done'}});
  const live=m.children[0].textContent;
  w.post({type:'sessionSelected',session:SESSION('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'assistant_message',
      text:'```sh\ndocker ps\n\ndocker df\ndocker volume ls\n```\n\nxong.\n'}]});
  assert.equal(live,w.document.getElementById('messages').children[0].textContent,
    'stream and replay must produce the same content');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('underscores in identifiers are not italics, without needing regex lookbehind',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'assistant_message',text:'last_token_usage and total_token_usage, while _this_ is emphasis.'}]});
  const card=w.document.getElementById('messages').children[0];
  const tags=shape(card);
  assert.equal(tags.filter(t=>t==='em').length,1,'only ONE place may become <em>: '+tags.join(','));
  assert.ok(card.textContent.includes('last_token_usage'),'variable names must keep their underscores');
  assert.ok(card.textContent.includes('total_token_usage'));
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('the iOS keyboard shrinks the panel instead of pushing the composer off-screen',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const body=w.document.body,input=w.document.getElementById('input');
  // The textarea cap is 40% of the visible area; give it "infinitely tall" content to see the exact cap.
  Object.defineProperty(input,'scrollHeight',{get:()=>9999});
  assert.equal(body.style._v['height'],undefined,'no keyboard yet means nothing is overridden');

  w.keyboard(420);                       // not focused: 420px is a junk number, not a keyboard
  assert.equal(body.style._v['height'],undefined,'no focused input means no keyboard');

  w.focusInput();
  w.keyboard(420);                       // keyboard open: 420px of visible area left
  assert.equal(body.style._v['height'],'420px','must pin the height to visualViewport');
  assert.equal(body.dataset.keyboard,'open','the mobile footer must know the keyboard is open');
  assert.equal(input.style.height,Math.round(420*0.4)+'px','the textarea cap must follow the real area, not innerHeight');

  w.keyboard(900);                       // close the keyboard
  assert.equal(body.style._v['height'],undefined,'closing the keyboard restores 100dvh');
  assert.equal(body.dataset.keyboard,'','closing the keyboard must restore the safe-area');

  // iOS fires `scroll` with the OLD height after the keyboard closes; without the focus check the whole app
  // is stuck in a 420px strip at the top of the screen.
  w.keyboard(420);
  assert.equal(body.style._v['height'],'420px','still focused means 420px is real');
  w.blurInput();
  assert.equal(body.style._v['height'],undefined,'losing focus drops the override, even while visualViewport is still small');
  w.focusInput();

  // A junk number from a cross-origin iframe must not become height:0 (a blank panel).
  for(const junk of [0,1,120]){
    w.keyboard(junk);
    assert.equal(body.style._v['height'],undefined,`visualViewport=${junk} must be ignored`);
    assert.equal(input.style.height,Math.round(900*0.4)+'px','and the textarea cap still follows innerHeight');
  }
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a keyboard opening does not resize the focused composer',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const input=w.document.getElementById('input');
  Object.defineProperty(input,'scrollHeight',{get:()=>40,configurable:true});
  w.fire('input','input',{});                      // re-measured: the box's resting size is 40px
  const writes:string[]=[];let cur=input.style.height;
  Object.defineProperty(input.style,'height',{configurable:true,get:()=>cur,set(v:string){writes.push(v);cur=v}});

  // 0.29.18 left `height:34px` in CSS while grow() measured `height:auto` (= `rows="3"` = 73px), so
  // EVERY visualViewport event grew the focused box to 73px. iOS fires resize/scroll continuously while the
  // keyboard slides up, and exactly that one relayout is enough for WebKit to cancel the present: tap 1 doesn't open it, tap 2
  // does (by then the box is already 73px so there is nothing left to write).
  w.focusInput();w.keyboard(420);
  assert.deepEqual(writes,[],'the keyboard sliding up must not change the focused box geometry');

  // But the cap by visible area must still clamp when the content is taller than it.
  writes.length=0;
  Object.defineProperty(input,'scrollHeight',{get:()=>9999,configurable:true});
  w.fire('input','input',{});
  // `0px` then `40px` is the measurement (clamp to 0 to read scrollHeight then restore): it ONLY runs when the box
  // value changes, not on every visualViewport event — that is the whole point of the assert above.
  assert.deepEqual(writes,['0px','40px',Math.round(420*0.4)+'px'],'long content still caps at the real area');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('on touch there is a file picker, because iOS never fires paste with a file',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const file=w.document.getElementById('file');

  w.fire('attach','click');
  assert.equal(file._clicks,1,'the paperclip button must open the right file input');

  file.files=[{type:'image/png',name:'photo.png'}];
  w.fire('file','change');
  const sent=w.posted.filter((m:any)=>m.type==='pasteImage');
  assert.equal(sent.length,1,'images must go up to the host through the paste channel');
  assert.equal(sent[0].mime,'image/png');
  assert.equal(sent[0].data,'aGk=');
  assert.equal(file.value,'','must reset so picking the same image again still fires change');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a picked file the host would reject is refused out loud, not dropped',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const file=w.document.getElementById('file');
  file.files=[{type:'image/heic',name:'IMG_0001.HEIC'}];
  w.fire('file','change');
  assert.equal(w.posted.filter((m:any)=>m.type==='pasteImage').length,0,'a mime the host rejects must not be sent');
  const rows=w.document.getElementById('messages').children;
  const last=rows[rows.length-1];
  assert.ok(String(last.className).includes('error'),'there must be an error line: '+last.className);
  assert.ok(last.textContent.includes('image/heic'),'and say which type was rejected');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('the webview boots with every control it listens to, and reports no viewport',()=>{
  const w=boot();
  // `on()` warns when an element is missing: after removing the `‹` button, empty warnings are what proves
  // no listener still points at a vanished id (one missing and the whole script dies).
  assert.deepEqual(w.posted.filter((m:any)=>m.type==='viewport'),[]);
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('send waits for image reading and saving without clearing the draft',()=>{
  const w=boot();w.post({type:'sessionSelected',session:SESSION('done'),events:[]});
  let reader:any;
  global.FileReader=class{onload:any;result='data:image/png;base64,aGk=';readAsDataURL(){reader=this}};
  w.document.getElementById('file').files=[{type:'image/png',name:'photo.png',size:2}];
  w.fire('file','change');w.document.getElementById('input').value='review image';
  w.fire('send','click');
  assert.equal(w.posted.filter(m=>m.type==='sendPrompt').length,0);
  assert.equal(w.document.getElementById('input').value,'review image');
  reader.onload();w.fire('send','click');
  assert.equal(w.posted.filter(m=>m.type==='sendPrompt').length,0);
  const upload=w.posted.find(m=>m.type==='pasteImage');
  w.post({type:'attachment',path:'/tmp/photo.png',requestId:upload.requestId});w.fire('send','click');
  assert.deepEqual(w.posted.filter(m=>m.type==='sendPrompt'),[{type:'sendPrompt',text:'review image',attachments:['/tmp/photo.png']}]);
});

test('oversized images show an error and never create a pending attachment',()=>{
  const w=boot();w.document.getElementById('file').files=[{type:'image/png',size:9*1024*1024+1}];w.fire('file','change');
  assert.equal(w.posted.filter(m=>m.type==='pasteImage').length,0);
  assert.equal(w.document.getElementById('attachments').children.length,0);
  assert.match(w.document.getElementById('messages').textContent,/9 MiB/);
});

test('removed uploads cannot return or take another image slot',()=>{
  const w=boot();w.post({type:'sessionSelected',session:SESSION('done'),events:[]});
  w.document.getElementById('file').files=[{type:'image/png',name:'a.png'},{type:'image/png',name:'b.png'}];w.fire('file','change');
  const uploads=w.posted.filter(m=>m.type==='pasteImage');
  const chip=w.document.getElementById('attachments').children[0];chip.children[chip.children.length-1].onclick();
  w.post({type:'attachment',requestId:uploads[1].requestId,path:'/tmp/b.png'});
  w.post({type:'attachment',requestId:uploads[0].requestId,path:'/tmp/a.png'});
  w.document.getElementById('input').value='only b';w.fire('send','click');
  assert.deepEqual(w.posted.filter(m=>m.type==='sendPrompt'),[{type:'sendPrompt',text:'only b',attachments:['/tmp/b.png']}]);
});

test('failed image saving removes the pending chip and preserves typed text',()=>{
  const w=boot();w.document.getElementById('file').files=[{type:'image/png'}];w.fire('file','change');
  w.document.getElementById('input').value='keep this';
  const upload=w.posted.find(m=>m.type==='pasteImage');
  w.post({type:'attachmentError',requestId:upload.requestId,message:'Disk full'});
  assert.equal(w.document.getElementById('attachments').children.length,0);
  assert.equal(w.document.getElementById('input').value,'keep this');
  assert.match(w.document.getElementById('messages').textContent,/Disk full/);
});

test('a thinking estimate feeds the running indicator and never enters the transcript',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'thinking',tokens:1500}});
  assert.equal(w.document.getElementById('thinktokens').textContent,'· 1.5k thinking');
  assert.equal(m.children[0].className,'empty','a transient signal must not become a log row');
  // Clear when the turn ends: the previous turn's number hanging around would look like it's still thinking.
  w.post({type:'sessionUpdated',session:SESSION('done')});
  assert.equal(w.document.getElementById('thinktokens').textContent,'');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a tool row opened before its arguments arrive is filled in, not duplicated',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'command_started',command:'',callId:'c1'}});
  assert.equal(m.children.length,1);
  assert.ok(m.children[0].textContent.includes('…'),'no arguments yet shows …');
  w.post({type:'event',sessionId:'a',event:{type:'command_started',command:'ls -la',callId:'c1'}});
  assert.equal(m.children.length,1,'the second time must overwrite, not build a second row');
  assert.ok(m.children[0].textContent.includes('ls -la'));
  w.post({type:'event',sessionId:'a',event:{type:'command_completed',command:'ls -la',output:'x',exitCode:0,callId:'c1'}});
  assert.equal(m.children.length,1,'the result still lands on that same row');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('two identical tool calls with no callId stay two rows',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'tool_started',tool:'Read',label:'/x.ts'}});
  w.post({type:'event',sessionId:'a',event:{type:'tool_started',tool:'Read',label:'/x.ts'}});
  assert.equal(m.children.length,2,'without an id two different calls must not be merged');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a user message shows the images it was sent with, and a queued image message is not a blank row',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'event',sessionId:'a',event:{type:'user_message',text:'',images:['/att/a.png','/att/b.png'],
    imageSrcs:['vscode-resource://a','vscode-resource://b']}});
  const card=w.document.getElementById('messages').children[0];
  const row=card.children.find((x:any)=>x.className==='uimgs');
  assert.ok(row,'the user\'s message must carry the images it sent');
  assert.deepEqual(row.children.map((i:any)=>i.src),['vscode-resource://a','vscode-resource://b']);
  // An image cleaned up by TTL leaves only alt — the file name still says what was sent.
  assert.deepEqual(row.children.map((i:any)=>i.alt),['a.png','b.png']);
  w.post({type:'queue',items:[{text:'',images:2}]});
  const q=w.document.getElementById('queue').children[0];
  assert.equal(q.textContent.includes('2 image(s)'),true,'an image-only queue entry must not be a blank row, saw: '+q.textContent);
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('on a phone the composer drops the keyboard hint and the context tokens leave the label',()=>{
  const phone=boot(undefined,{touch:true});
  phone.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  // ⏎/⇧⏎ don't exist on phones, and that hint is what pushed the composer to two rows.
  assert.equal(phone.document.getElementById('input').placeholder,'Ask Claude\u2026');
  // The % stays in the label, the token count moves to its own element so narrow CSS can hide the second half without losing the tooltip.
  assert.equal(phone.document.getElementById('ctxtext').textContent,'90%');
  assert.equal(phone.document.getElementById('ctxtokens').textContent,' \u00b7 100/1k');
  const cw=phone.document.getElementById('ctxwrap');
  assert.ok(cw.dataset['aria-label'].includes('Input: 5'),'tokens must still be in the label');
  assert.equal(cw.title,'','no title: the native tooltip is slow and covers the card');
  const ct=phone.document.getElementById('ctxtip').textContent;
  assert.ok(ct.includes('Context window')&&ct.includes('90%')&&ct.includes('100 / 1k')&&ct.includes('Input5'),'the context card is missing numbers, saw: '+ct);
  assert.ok(ct.endsWith('Click to compact'),'the card must say clicking compacts, saw: '+ct);

  const desktop=boot();
  desktop.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.ok(desktop.document.getElementById('input').placeholder.includes('\u23ce send'),'with a keyboard the hint is still worth printing');
});

test('a session with no usage yet clears both halves of the context label',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:{provider:'claude',nativeSessionId:'a',status:'done'},events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.document.getElementById('ctxtext').textContent,'\u2014');
  assert.equal(w.document.getElementById('ctxtokens').textContent,'','old token counts must not stick around');
});

test('a planner view frame redraws one bubble instead of appending three',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const view=(text:string)=>w.post({type:'event',sessionId:'a',event:{type:'assistant_view',text}});
  view('**Hel');view('**Hello** wor');view('**Hello** world');
  const bubbles=w.document.getElementById('messages').children.filter((c:any)=>String(c.className).includes('assistant'));
  // Every frame is the whole answer so far: appending gives three copies of the same sentence.
  assert.equal(bubbles.length,1,'only one bubble');
  assert.equal(bubbles[0].textContent,'Hello world');
  assert.ok(bubbles[0].classList.contains('assistant-streaming'),'not done yet means it is still a streaming bubble');
  w.post({type:'event',sessionId:'a',event:{type:'turn_done'}});
  assert.equal(bubbles[0].classList.contains('assistant-streaming'),false,'turn_done settles the bubble');
  assert.equal(bubbles[0].textContent,'Hello world','settling must still give the right final text');
  assert.deepEqual(w.warnings,[],'there must be no warnings: '+w.warnings.join(' | '));
});

test('recorded quota renders both rings and an old observation stays marked stale',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:{provider:'claude',nativeSessionId:'a',status:'done',usage:{
    quota5hUsedPercentage:27,quota5hObservedAt:1,quota7dUsedPercentage:35,quota7dObservedAt:1,
    contextUsedTokens:123,contextWindowTokens:1000}},events:[]});
  assert.equal(w.document.getElementById('q5wrap').hidden,false);
  assert.equal(w.document.getElementById('q7wrap').hidden,false);
  // The label is its own span so CSS can hide it on phones; the number is still % left.
  assert.equal(w.document.getElementById('q5lab').textContent,'5h');
  assert.equal(w.document.getElementById('q5text').textContent,'~73%');
  assert.equal(w.document.getElementById('q7text').textContent,'~65%');
  assert.match(w.document.getElementById('ctxtokens').textContent,/123/);
});

/** Git chips: only the dirty working tree, and untracked counts toward files but not lines. */
const SCM=(x:any)=>Object.assign({branch:'main',upstream:'origin/main',ahead:0,behind:0,
  files:0,untracked:0,added:0,removed:0,changes:[]},x);

test('no git data means both chips disappear, no 0 drawn',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:2,added:3,removed:1})});
  assert.equal(w.byId.scm.hidden,false);
  w.post({type:'scm'});
  assert.equal(w.byId.scm.hidden,true,'a project that is not a git repo');
  assert.equal(w.byId.branch.hidden,true);
});

test('a clean tree hides the changes chip but still shows the branch and unpushed commit count',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({ahead:3,behind:2})});
  assert.equal(w.byId.scm.hidden,true,'0 changed files means that chip only takes space');
  assert.equal(w.byId.branch.hidden,false);
  assert.equal(w.byId.branch.textContent,'\u2387 main\u21913\u21932');
  assert.match(w.byId.branch.title,/3 commit\(s\) to push/);
});

test('no upstream means the tooltip says outright nothing is pushed, not silence',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({upstream:undefined,branch:'feature/x'})});
  assert.match(w.byId.branch.title,/No upstream/);
});

test('378/14 gives 4 green + 1 grey cell, just like GitHub\'s 5-cell bar',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:12,added:378,removed:14})});
  assert.equal(w.byId.scm.textContent,'12+378\u221214');
  const bar=w.byId.scm.children[3];
  assert.deepEqual(bar.children.map((c:any)=>c.className),['sq add','sq add','sq add','sq add','sq']);
});

test('one side taking the whole diff fills all five cells; a tiny side rounds away, the number stays',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:1,added:0,removed:100})});
  assert.deepEqual(w.byId.scm.children[3].children.map((c:any)=>c.className),
    ['sq del','sq del','sq del','sq del','sq del']);
  // 1/101 isn't enough for a cell. The bar is for skimming; the exact number sits right next to it.
  w.post({type:'scm',status:SCM({files:2,added:1,removed:100})});
  assert.deepEqual(w.byId.scm.children[3].children.map((c:any)=>c.className),
    ['sq del','sq del','sq del','sq del','sq']);
  // Unless the other side is empty too: an all-additions diff must not give a plain grey bar.
  w.post({type:'scm',status:SCM({files:1,added:3,removed:0})});
  assert.deepEqual(w.byId.scm.children[3].children.map((c:any)=>c.className),
    ['sq add','sq add','sq add','sq add','sq add']);
});

test('untracked is spelled out in the tooltip because its lines are not counted',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:5,untracked:2,added:10,removed:1})});
  assert.match(w.byId.scm.title,/2 untracked/);
});

test('clicking the chip opens the file list in the host, the webview builds no menu itself',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:2,added:2,removed:0})});
  w.fire('scm','click');
  assert.deepEqual(w.posted.filter((m:any)=>m.type==='pickChanged'),[{type:'pickChanged'}]);
});

test('redrawing the header for another reason does not wipe the git chip',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:2,added:2,removed:0})});
  w.post({type:'sessionUpdated',session:SESSION('running')});
  assert.equal(w.byId.scm.hidden,false);
  assert.equal(w.byId.scm.textContent,'2+2\u22120');
});

test('when the turn ends the thinking bar stays as a summary footer, it does not disappear',()=>{
  const w=boot();
  const t0=Date.now()-120000;
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.byId.thinking.hidden,false,'while running the bar must show');
  for(const event of [
    {type:'user_message',text:'go',timestamp:t0},
    {type:'command_started',command:'ls',callId:'c1',timestamp:t0+1000},
    {type:'command_completed',command:'ls',exitCode:0,callId:'c1',timestamp:t0+2000},
    {type:'tool_started',tool:'Read',label:'a.ts',callId:'r1',timestamp:t0+3000},
    {type:'tool_completed',tool:'Read',label:'a.ts',callId:'r1',timestamp:t0+4000},
    {type:'tool_started',tool:'Read',label:'b.ts',callId:'r2',timestamp:t0+5000},
    {type:'usage',usage:{inputTokens:20000,outputTokens:1200,costUsd:0.1234},timestamp:t0+60000},
    {type:'turn_done',timestamp:t0+60000},
  ]) w.post({type:'event',sessionId:'a',event});
  w.post({type:'sessionUpdated',session:SESSION('done')});
  assert.equal(w.byId.thinking.hidden,false,'once done the bar must stay');
  assert.equal(w.byId.thinkword.textContent,'Done');
  assert.equal(w.byId.thinktime.textContent,'1m 0s','measured from event timestamps, not the spinner clock');
  const meta=w.byId.thinktokens.textContent;
  // started + completed with the same callId are ONE call: 1 Bash + 2 Read = 3.
  assert.ok(/3 calls/.test(meta),meta);
  assert.ok(/Read 2/.test(meta)&&/Bash 1/.test(meta),meta);
  assert.ok(/21\.2k tok/.test(meta),meta);
  assert.ok(/\$0\.123/.test(meta),meta);
  assert.equal(w.byId.cancel.hidden,true,'nothing left to Stop');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('switching tabs mid-run recomputes the clock for the new session, not reusing the old one',()=>{
  const w=boot();
  const now=Date.now();
  const A=(status:string)=>({provider:'claude',nativeSessionId:'a',status});
  const B=(status:string)=>({provider:'claude',nativeSessionId:'b',status});
  w.post({type:'sessionSelected',session:A('running'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'go',timestamp:now-90000}]});
  assert.equal(w.byId.thinktime.textContent,'1m 30s','the anchor comes from the transcript, not from when the tab opened');
  w.post({type:'event',sessionId:'a',event:{type:'thinking',tokens:1200,timestamp:now}});
  assert.equal(w.byId.thinktokens.textContent,'· 1.2k thinking');
  // Another session, also running: both the time and thinking token count must belong to the NEW session.
  w.post({type:'sessionSelected',session:B('running'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'hi',timestamp:now-5000}]});
  assert.equal(w.byId.thinktime.textContent,'5s','must not keep counting the old session\'s clock');
  assert.equal(w.byId.thinktokens.textContent,'','the old session\'s thinking tokens must be cleared');
  assert.equal(w.timers.filter((t:any)=>t.ms===1000).length,1,'only ONE clock may be running');
  // Going back to the old session still shows the right time, not reset to 0s.
  w.post({type:'sessionSelected',session:A('running'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'go',timestamp:now-90000}]});
  assert.equal(w.byId.thinktime.textContent,'1m 30s');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

/**
 * `SessionManager.resume` emits `sessionUpdated`('running') BEFORE `user_message`, so when the clock
 * starts the transcript still ends at the previous turn. Without re-anchoring, the seconds shown add up
 * both the old turn and the new one.
 */
test('the second turn of the same session counts from the NEW message, not adding the previous turn',()=>{
  const w=boot();
  const now=Date.now();
  const S=(status:string)=>({provider:'claude',nativeSessionId:'a',status});
  w.post({type:'sessionSelected',session:S('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'turn 1',timestamp:now-600000},{type:'turn_done',timestamp:now-590000}]});
  w.post({type:'sessionUpdated',session:S('running')});
  w.post({type:'event',sessionId:'a',event:{type:'user_message',text:'turn 2',timestamp:now-4000}});
  assert.equal(w.byId.thinktime.textContent,'4s','must re-anchor to the new turn\'s message');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('the summary footer only prints what was measured, and says clearly when the turn was stopped',()=>{
  const w=boot();
  // No turn at all (empty transcript) means no empty footer is built.
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.byId.thinking.hidden,true,'no turn yet means fully hidden');
  // A meaningless timestamp (transcript imported from the CLI) drops the time rather than printing a wrong number.
  w.post({type:'sessionSelected',session:SESSION('cancelled'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'go'},{type:'tool_started',tool:'Grep',label:'x'}]});
  assert.equal(w.byId.thinking.hidden,false);
  assert.equal(w.byId.thinkword.textContent,'Stopped');
  assert.equal(w.byId.thinktime.textContent,'','no timestamp means no time printed');
  assert.equal(w.byId.thinktokens.textContent,'· 1 call (Grep 1)');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('the copy ID button only shows with a real session, and its tooltip carries the ID',()=>{
  const w=boot();
  assert.equal(w.document.getElementById('copyid').hidden,true,'a draft has no id to copy');
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const b=w.document.getElementById('copyid');
  assert.equal(b.hidden,false);
  assert.match(b.title,new RegExp(SESSION('done').nativeSessionId));
});

test('the cache chip counts down the TTL like the official extension, and when cold says how much the next turn rewrites',()=>{
  const w=boot();
  const sel=(usage:any)=>w.post({type:'sessionSelected',session:{...SESSION('done'),usage:{...SESSION('done').usage,...usage}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  sel({});
  assert.equal(w.byId.cachewrap.hidden,true,'unknown TTL means hidden, no guessing');
  sel({cacheAnchorAt:Date.now()-10*60000,cacheTtlMs:3600000,cacheTokens:118000});
  assert.equal(w.byId.cachewrap.hidden,false);
  assert.equal(w.byId.cachetext.textContent,'50m');
  const tip=w.byId.cachetip.textContent;
  assert.ok(tip.includes('Prompt cache')&&tip.includes('TTL 1h')&&/Expiresin 50m/.test(tip),'the cache card is missing numbers, saw: '+tip);
  assert.equal(w.timers.some((t:any)=>t.ms===60000),true,'the countdown needs a minute clock');
  sel({cacheAnchorAt:Date.now()-2*3600000,cacheTtlMs:3600000,cacheTokens:118000});
  assert.equal(w.byId.cachetext.textContent,'cold');
  assert.ok(w.byId.cachetip.textContent.includes('re-cache about 118k tokens'),'saw: '+w.byId.cachetip.textContent);
  sel({cacheAnchorAt:0,cacheTtlMs:3600000});
  assert.ok(w.byId.cachetip.textContent.includes('compacted'),'after compact the old cache no longer matches');
});

test('the 5h/7d cards say what % of usage came from parallel sessions and sub-agents',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:{...SESSION('done'),usage:{...SESSION('done').usage,
    quota5hUsedPercentage:20,quota5hObservedAt:Date.now(),quota7dUsedPercentage:25,quota7dObservedAt:Date.now(),
    usageInsights:{observedAt:Date.now(),
      day:{requests:1772,sessions:25,behaviors:[{key:'subagent_heavy',pct:39},{key:'long_context',pct:72}],top:[{group:'skills',name:'impl',pct:12}]},
      week:{requests:18494,sessions:2164,behaviors:[{key:'high_parallel',pct:28}],top:[]}}}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  const d=w.byId.q5tip.textContent,wk=w.byId.q7tip.textContent;
  assert.ok(d.includes('Last 24h')&&d.includes('Subagent-heavy sessions39%')&&d.includes('/impl12%'),'the 5h card takes the 24h window, saw: '+d);
  assert.ok(d.indexOf('At >150k context')<d.indexOf('Subagent-heavy'),'sorted by % descending');
  assert.ok(wk.includes('Last 7d')&&wk.includes('While 4+ sessions ran in parallel28%'),'the 7d card takes the 7-day window, saw: '+wk);
  assert.ok(d.includes('overlapping, not a breakdown'),'the percentages overlap — must say so, or they read as shares');
});

test('local media paths in a reply render as img/video, remote and non-media ones do not',()=>{
  const all=(n:any,out:any[]=[]):any[]=>{for(const c of n.children||[]){out.push(c);all(c,out)}return out};
  const reply='Xong: ![demo](/tmp/a.gif)\n\nVideo `/Users/x/my demo.mp4`, log `/tmp/notes.txt`, ![r](https://x/y.png)';
  const {post,byId}=boot();
  post({type:'sessionSelected',session:SESSION('done'),events:[{type:'assistant_message',text:reply,timestamp:1}]});
  assert.equal(all(byId.messages).filter((n:any)=>n.tag==='img'||n.tag==='video').length,0,'no mediaBase yet means no media built');
  post({type:'mediaBase',base:'https://res'});
  post({type:'sessionSelected',session:SESSION('done'),events:[{type:'assistant_message',text:reply,timestamp:1}]});
  const nodes=all(byId.messages);
  assert.deepEqual(nodes.filter((n:any)=>n.tag==='img').map((n:any)=>n.src),['https://res/tmp/a.gif']);
  assert.deepEqual(nodes.filter((n:any)=>n.tag==='video').map((n:any)=>n.src),['https://res/Users/x/my%20demo.mp4']);
  assert.ok(nodes.some((n:any)=>n.tag==='a'&&n.dataset.href==='https://x/y.png'),'remote images are still just links');
});

test('a streaming tail does not build media until its paragraph is closed',()=>{
  const all=(n:any,out:any[]=[]):any[]=>{for(const c of n.children||[]){out.push(c);all(c,out)}return out};
  const {post,byId}=boot();
  post({type:'mediaBase',base:'https://res'});
  post({type:'sessionSelected',session:SESSION('running'),events:[]});
  post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'![x](/tmp/a.webm)',timestamp:1}});
  assert.equal(all(byId.messages).filter((n:any)=>n.tag==='video').length,0,'the tail redraws on every delta — building video there means constant reloading');
  post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'\n\nxong',timestamp:2}});
  assert.equal(all(byId.messages).filter((n:any)=>n.tag==='video').length,1);
});
