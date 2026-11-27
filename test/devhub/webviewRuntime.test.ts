export {};
declare const global:any;
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const vscodeMock={ViewColumn:{Beside:2},window:{},Uri:{file:(p:string)=>p},workspace:{getConfiguration:()=>({get:(_k:string,d:any)=>d})}};

/**
 * Chạy THẬT script webview trong DOM giả. Test cú pháp không bắt được lỗi runtime —
 * một `$('compact')` trỏ vào id không tồn tại từng giết cả script và làm Enter mất tác dụng.
 */
function boot(initialState?:any,opts?:{touch?:boolean}){
  const listeners:Record<string,[string,Function][]>={};
  const byId:Record<string,any>={};
  const mk=(tag:string):any=>({tag,className:'',dataset:{} as any,title:'',
    // style thật là CSSStyleDeclaration: gán trực tiếp ĐƯỢC, mà setProperty cho biến CSS cũng phải được.
    style:{_v:{} as any,setProperty(k:string,v:string){this._v[k]=v},removeProperty(k:string){delete this._v[k]}},
    value:'',placeholder:'',
    disabled:false,hidden:false,children:[] as any[],_t:'',scrollTop:0,clientHeight:200,
    // Đếm lượt đọc: mỗi lần đọc scrollHeight sau khi sửa DOM là một lần ép browser tính layout.
    _shReads:0,
    get scrollHeight():number{this._shReads++;return (this.children.length||0)*20},
    set textContent(v:string){this._t=v;this.children=[]},
    get textContent():string{return this._t||this.children.map((c:any)=>c.textContent??c.text??'').join('')},
    get lastChild(){return this.children[this.children.length-1]},
    get lastElementChild(){return this.children[this.children.length-1]},
    get firstChild(){return this.children[0]},get firstElementChild(){return this.children[0]},
    // DocumentFragment thật DỜI con của nó sang node đích, không tự thành một child.
    // parentNode như DOM thật: code webview dùng nó để biết dòng còn trong cây hay đã bị prune.
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
    // `focus()` phải dời `activeElement`: chat.js chỉ tin bàn phím khi có ô nhập đang focus.
    focus(){document.activeElement=this},
    // DOM thật: classList và className là CÙNG một chỗ. Mock cũ tách làm hai nên
    // `el(...,'msg assistant assistant-streaming')` rồi `classList.contains(...)` ra false —
    // mọi nhánh "append vào node đang stream" âm thầm không được test.
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
    // Tag của #input phải là textarea thật: `editing()` phân biệt ô nhập bằng `tagName`.
    getElementById:(id:string)=>(byId[id]??=Object.assign(mk(id==='input'?'textarea':id==='file'?'input':'div'),{id})),
    body:mk('body'),activeElement:null,
    addEventListener:(ev:string,fn:Function)=>(listeners.__doc??=[]).push([ev,fn])};
  const posted:any[]=[];
  const win:any={addEventListener:(ev:string,fn:Function)=>(listeners.__win??=[]).push([ev,fn]),innerHeight:900};
  // visualViewport: chỗ DUY NHẤT thấy được vùng còn lại khi bàn phím iOS mở.
  const vv:any={height:900,addEventListener:(ev:string,fn:Function)=>(listeners.__vv??=[]).push([ev,fn])};
  win.visualViewport=vv;
  // Composer đọc `(hover:none)` một lần lúc nạp để biết có bàn phím thật hay không.
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

  // spinner dùng setInterval; nếu để thật thì node không thoát sau khi test xong.
  const timers:any[]=[];
  const fakeSetInterval=(fn:Function,ms:number)=>{const id={fn,ms};timers.push(id);return id};
  const fakeClearInterval=(id:any)=>{const i=timers.indexOf(id);if(i>=0)timers.splice(i,1)};
  // rAF chạy ngay: autoscroll gộp theo frame, để thật thì test không thấy kết quả cuộn.
  const frames:Function[]=[];
  const fakeRaf=(fn:Function)=>{frames.push(fn);fn();return frames.length};
  // setState/getState là chỗ DUY NHẤT sống sót qua Reload Window (DOM thì không) —
  // mock phải lưu thật, không thì không test được draft.
  const store={value:initialState};
  new Function('document','window','acquireVsCodeApi','console','setInterval','clearInterval','setTimeout','requestAnimationFrame',js)(
    document,win,()=>({postMessage:(m:any)=>posted.push(m),
      setState(v:any){store.value=v},getState(){return store.value}}),
    {warn:(...a:any[])=>warnings.push(a.join(' ')),log(){},error:(...a:any[])=>warnings.push('error '+a.join(' '))},
    fakeSetInterval,fakeClearInterval,(fn:Function)=>{fn();return 0},fakeRaf);

  const post=(x:any)=>{for(const [e,f] of (listeners.__win||[]))if(e==='message')f({data:x})};
  const fire=(id:string,ev:string,arg?:any)=>{const hit=(listeners[id]||[]).filter(([e])=>e===ev);
    assert.ok(hit.length,`không có listener ${ev} trên #${id}`);for(const [,f] of hit)f(arg)};
  const keyboard=(height:number)=>{vv.height=height;
    for(const [e,f] of (listeners.__vv||[]))if(e==='resize')f({})};
  /** Bàn phím không mở được khi không có gì focus, nên test phải nói rõ ô nhập đang giữ focus. */
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
  assert.deepEqual(w.warnings,[],'không được có cảnh báo/lỗi: '+w.warnings.join(' | '));
});

test('Enter sends, Shift+Enter does not, and a running turn queues instead of dropping',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const input=w.document.getElementById('input');

  input.value='check prod';w.posted.length=0;
  let prevented=false;
  w.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault:()=>{prevented=true}});
  assert.equal(prevented,true,'Enter phải chặn xuống dòng');
  assert.deepEqual(w.posted,[{type:'sendPrompt',text:'check prod'}]);

  input.value='xuống dòng';w.posted.length=0;
  w.fire('input','keydown',{key:'Enter',shiftKey:true,preventDefault:()=>assert.fail('Shift+Enter không được chặn')});
  assert.deepEqual(w.posted,[],'Shift+Enter chỉ xuống dòng');

  // Trước đây webview tự chặn khi đang chạy nên tin nhắn bốc hơi. Giờ vẫn gửi lên host,
  // host mới quyết định xếp hàng — nhờ vậy chữ đã gõ không mất.
  w.post({type:'sessionUpdated',session:SESSION('running')});
  input.value='lượt hai';w.posted.length=0;
  w.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault(){}});
  assert.deepEqual(w.posted,[{type:'sendPrompt',text:'lượt hai'}],'đang chạy thì gửi lên để host xếp hàng');
  assert.equal(input.value,'','ô nhập phải trống sau khi xếp hàng');
});

test('Cmd+C copies a selection inside the frame instead of trusting the workbench to',()=>{
  const w=boot();let copies=0,sel='';
  w.document.execCommand=(c:string)=>{if(c==='copy')copies++;return true};
  w.win.getSelection=()=>({isCollapsed:!sel,toString:()=>sel});
  const key=(k:any)=>w.docFire('keydown',Object.assign({keyCode:67,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false},k));
  key({metaKey:true});assert.equal(copies,0,'không bôi đen thì để VS Code lo');
  sel='một đoạn';key({metaKey:true});assert.equal(copies,1,'Cmd+C có bôi đen phải tự copy');
  key({ctrlKey:true});assert.equal(copies,2,'Ctrl+C cũng vậy');
  key({metaKey:true,shiftKey:true});key({metaKey:true,keyCode:86});assert.equal(copies,2,'phím khác không đụng');
});

test('the host owns the queue: webview only renders what it is told, and can remove one',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'queue',items:['một','hai']});
  const rows=w.document.getElementById('queue').children;
  assert.equal(rows.length,2,'hai tin trong hàng chờ');
  assert.ok(rows[1].textContent.includes('hai'));
  w.posted.length=0;
  rows[0].children[2].onclick();
  assert.deepEqual(w.posted,[{type:'dequeue',index:0}]);
  // Host là nguồn sự thật: webview không tự xoá khỏi DOM trước khi host xác nhận.
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
    assert.ok(w.posted.some(p=>p.type===type),`#${id} phải gửi ${type}`);
  }
  // Vòng context CHÍNH LÀ nút compact — nhưng phải là thao tác compact thật, không phải
  // gửi chuỗi "/compact" làm prompt.
  w.posted.length=0;w.fire('ctxwrap','click',{});
  assert.deepEqual(w.posted,[{type:'compact'}],'bấm vòng context gửi compact');

  w.posted.length=0;
  w.fire('input','paste',{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>({type:'image/png',name:'a.png'})}]},preventDefault(){}});
  assert.ok(w.posted.some(p=>p.type==='pasteImage'),'paste ảnh phải gửi pasteImage');

  w.document.getElementById('input').value='/';w.posted.length=0;
  w.fire('input','input',{});
  assert.ok(w.posted.some(p=>p.type==='pickSlash'),'gõ "/" mở picker');
});

test('a pasted image rides along on send instead of sitting in the textarea',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'attachment',path:'/tmp/shot.png'});
  const input=w.document.getElementById('input');
  assert.equal(input.value,'','đường dẫn không được nhét vào ô nhập');
  input.value='xem ảnh này';w.posted.length=0;
  w.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault(){}});
  // Ảnh là trường riêng; host mới quyết định nối path vào prompt thế nào.
  assert.deepEqual(w.posted,[{type:'sendPrompt',text:'xem ảnh này',attachments:['/tmp/shot.png']}]);
});

test('a long transcript is built off-document instead of reflowing once per event',()=>{
  const w=boot();
  const events=Array.from({length:300},(_,i)=>({type:'assistant_message',text:'dòng '+i}));
  const m=w.document.getElementById('messages');
  m._shReads=0;
  w.post({type:'sessionSelected',session:SESSION('done'),events,workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,300,'phải dựng đủ event');
  // Cách cũ: addEvent gán m.scrollTop=m.scrollHeight sau TỪNG event -> 300 lần đo layout.
  assert.ok(m._shReads<=2,`mở transcript dài chỉ được đo layout 1 lần, thấy ${m._shReads}`);
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a truncated transcript offers older pages and keeps the reader in place when they arrive',()=>{
  const w=boot();
  const ev=(n:number,from:number)=>Array.from({length:n},(_,i)=>({type:'assistant_message',text:'m'+(from+i)}));
  const m=w.document.getElementById('messages');
  w.post({type:'sessionSelected',session:SESSION('done'),events:ev(200,250),older:250,workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,201,'200 event + nút tải thêm');
  assert.ok(String(m.children[0].className).includes('older'),'nút phải nằm trên cùng');
  w.fire('button','click');
  assert.deepEqual(w.posted.filter((x:any)=>x.type==='loadOlder'),[{type:'loadOlder'}]);
  assert.equal(m.children[0].disabled,true,'bấm rồi thì khoá, không bắn hai lần');
  m.scrollTop=1000;const fromEnd=m.scrollHeight-m.scrollTop;
  w.post({type:'sessionSelected',session:SESSION('done'),events:ev(400,50),older:50,keepScroll:true,workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.scrollHeight-m.scrollTop,fromEnd,'nạp thêm phía trên không được làm nhảy chỗ đang đọc');
  w.post({type:'sessionSelected',session:SESSION('done'),events:ev(3,0),workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,3,'không có `older` (panel) thì không có nút');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('streaming does not yank the view down while the user is reading further up',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  for(let i=0;i<30;i++)w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'x'+i}});
  m.scrollTop=0;w.fire('messages','scroll',{});   // người dùng cuộn lên đọc lại
  w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'mới'}});
  assert.equal(m.scrollTop,0,'đang đọc phía trên thì không được giật xuống cuối');
  // Cuộn về đáy lại thì phải dính đáy trở lại.
  m.scrollTop=m.scrollHeight;w.fire('messages','scroll',{});
  m.scrollTop=m.scrollHeight-1;
  w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'mới nữa'}});
  assert.equal(m.scrollTop,m.scrollHeight,'ở đáy thì tiếp tục dính đáy');
});

test('sending your own message always scrolls it into view',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  for(let i=0;i<30;i++)w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'x'+i}});
  m.scrollTop=0;                        // đang cuộn lên đọc lại
  w.post({type:'event',sessionId:'a',event:{type:'user_message',text:'câu mới của tôi'}});
  // Cuộn có điều kiện là đúng cho output của agent, nhưng tin của chính mình mà nằm
  // dưới màn hình thì trông như mất tin.
  assert.ok(m.scrollTop>0,'tin của mình phải được cuộn tới');
  w.post({type:'event',sessionId:'a',event:{type:'assistant_message',text:'trả lời'}});
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('an attachment chip opens the image, and only once the host has saved it',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const box=w.document.getElementById('attachments');
  // Dán ảnh: chip hiện ngay, nhưng chưa có path -> chưa bấm được.
  w.fire('input','paste',{clipboardData:{items:[{kind:'file',type:'image/png',
    getAsFile:()=>({type:'image/png',name:'a.png'})}]},preventDefault(){}});
  assert.equal(box.children.length,1);
  assert.equal(typeof box.children[0].onclick,'undefined','chưa có path thì không được gửi openFile');

  w.post({type:'attachment',path:'/tmp/shot.png'});
  const chip=box.children[0];
  assert.equal(typeof chip.onclick,'function','host lưu xong thì chip mở được ảnh');
  w.posted.length=0;
  chip.onclick({target:{className:'thumb'}});
  assert.deepEqual(w.posted,[{type:'openFile',path:'/tmp/shot.png'}]);
  // Bấm nút xoá không được mở ảnh kèm theo.
  w.posted.length=0;
  chip.onclick({target:{className:'attx'}});
  assert.deepEqual(w.posted,[]);
});

test('the thinking spinner starts and stops with the turn, leaving no timer behind',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.timers.length,1,'đang chạy phải có đúng 1 đồng hồ');
  assert.equal(w.document.getElementById('thinking').hidden,false);
  w.post({type:'sessionUpdated',session:SESSION('done')});
  assert.equal(w.timers.length,0,'xong lượt phải huỷ đồng hồ, không để rò');
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
  assert.equal(w.byId.q5lab.textContent+' '+w.byId.q5text.textContent,'5h 46%','chữ là quota CÒN LẠI, không phải đã dùng');
  const [dash]=String(w.byId.q5arc.dataset['stroke-dasharray']).split(' ').map(Number);
  assert.ok(Math.abs(dash-CIRC*0.46)<1,'cung 5h phải là 46% vòng khi đã dùng 54%, thấy: '+dash);
  const label=w.byId.q5wrap.dataset['aria-label'];
  assert.ok(label.includes('46% left · 54% used'),'nhãn phải nói cả hai chiều, thấy: '+label);
  assert.ok(/in 2h 3[0-9]m/.test(label),'lúc reset chuyển hẳn vào nhãn, thấy: '+label);
  assert.equal(w.byId.q5wrap.title,'','không để title: tooltip native chậm và đè lên card');
  const tip=w.byId.q5tip.textContent;
  assert.ok(tip.includes('Five-hour limit')&&tip.includes('46%')&&tip.includes('54% used'),'card hover thiếu số, thấy: '+tip);
  assert.ok(/Resetsin 2h 3[0-9]m/.test(tip),'card hover phải có đếm ngược reset, thấy: '+tip);
  assert.ok(!w.byId.q7tip.textContent.includes('Resets'),'thiếu resetsAt thì card 7d không bịa dòng reset');
  // Cung không còn dính tới resetsAt: thiếu nó thì vẫn vẽ theo % còn lại.
  const [d7]=String(w.byId.q7arc.dataset['stroke-dasharray']).split(' ').map(Number);
  assert.ok(Math.abs(d7-CIRC*0.69)<1,'thiếu resetsAt vẫn vẽ theo 69% còn lại, thấy: '+d7);
  // Ba vòng cùng chiều: context dùng 100/1000 thì cung là 90% vòng.
  const [dc]=String(w.byId.arc.dataset['stroke-dasharray']).split(' ').map(Number);
  assert.ok(Math.abs(dc-CIRC*0.9)<1,'vòng context cũng đo phần còn lại, thấy: '+dc);
  assert.equal(w.byId.ctxtext.textContent,'90%');
  assert.equal(w.timers.some((t:any)=>t.ms===60000),true,'vẫn giữ đồng hồ cho dấu ~ và đếm ngược');

  w.post({type:'sessionSelected',session:{provider:'planner',nativeSessionId:'b',status:'done',usage:{}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.byId.q5wrap.hidden,true,'session không có quota — ẩn hẳn, không hiện "5h —"');
  assert.equal(w.byId.q7wrap.hidden,true);
  assert.equal(w.timers.some((t:any)=>t.ms===60000),false,'không còn vòng thì không giữ đồng hồ');
});

test('AskUserQuestion renders its options and answering sends them back',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.posted.length=0;
  w.post({type:'permission',request:{requestId:'q1',toolName:'AskUserQuestion',input:{questions:[
    {question:'Tabs or spaces?',header:'Indent',options:[
      {label:'Spaces',description:'two of them'},{label:'Tabs',description:'one of them'}]}]}}});

  const card=w.document.getElementById('messages').children.find((c:any)=>c.className==='perm');
  assert.ok(card,'phải dựng thẻ câu hỏi');
  const box=card.children.find((c:any)=>c.className==='qbox');
  assert.equal(box.children[0].textContent,'Tabs or spaces?');
  const opts=box.children[1].children;
  assert.equal(opts.length,2,'đúng số lựa chọn');
  assert.equal(opts[0].children[0].textContent,'Spaces');
  assert.equal(opts[0].children[1].textContent,'two of them','mô tả phải hiện');
  assert.equal(w.posted.length,0,'chưa chọn thì chưa gửi gì');

  opts[1].onclick();
  assert.deepEqual(w.posted,[{type:'permissionResponse',requestId:'q1',allow:true,answers:{'Tabs or spaces?':'Tabs'}}]);
});

test('a plain tool permission still gets Allow/Deny, not question options',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.posted.length=0;
  w.post({type:'permission',request:{requestId:'p1',toolName:'Bash',input:{command:'rm -rf /'}}});
  const card=w.document.getElementById('messages').children.find((c:any)=>c.className==='perm');
  assert.equal(card.children.some((c:any)=>c.className==='qbox'),false,'không phải câu hỏi');
  const acts=card.children.find((c:any)=>c.className==='pacts');
  assert.deepEqual(acts.children.map((b:any)=>b.textContent),['Allow','Deny']);
});

test('unsent text survives the panel being destroyed when the tab is hidden',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const input=w.document.getElementById('input');
  input.value='câu chưa gửi';
  w.fire('input','input',{});
  assert.equal(w.store.value.draftText,'câu chưa gửi','chữ đang gõ phải nằm trong webview state');
  assert.equal(w.store.value.nativeSessionId,'a','vẫn giữ session để serializer nhận lại đúng tab');

  // Ẩn tab huỷ DOM; mở lại là script chạy từ đầu với đúng state đó.
  const again=boot(w.store.value);
  assert.equal(again.document.getElementById('input').value,'câu chưa gửi');
});

test('a pending attachment comes back with the draft, and send clears both',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'attachment',path:'/tmp/shot.png'});
  w.document.getElementById('input').value='kèm ảnh';
  w.fire('input','input',{});
  assert.deepEqual(w.store.value.atts,['/tmp/shot.png']);

  const again=boot(w.store.value);
  assert.equal(again.document.getElementById('input').value,'kèm ảnh');
  again.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  again.posted.length=0;
  again.fire('input','keydown',{key:'Enter',shiftKey:false,preventDefault(){}});
  assert.deepEqual(again.posted,[{type:'sendPrompt',text:'kèm ảnh',attachments:['/tmp/shot.png']}],
    'ảnh khôi phục từ state vẫn gửi kèm được');
  assert.equal(again.store.value.draftText,'','gửi xong phải xoá draft, không thì lần sau tự điền lại');
  assert.deepEqual(again.store.value.atts,[]);
});

test('a tool call stays one row: the result rewrites the started row, live and on replay',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'command_started',command:'ls -la',callId:'c1'}});
  assert.equal(m.children.length,1);
  w.post({type:'event',sessionId:'a',event:{type:'command_completed',command:'ls -la',output:'a\nb\nc',exitCode:0,callId:'c1'}});
  assert.equal(m.children.length,1,'started + completed phải là MỘT dòng, không in hai lần');
  assert.ok(m.children[0].textContent.includes('a'),'dòng đó phải mang output');
  // Không callId (transcript cũ) thì khớp bằng chính command.
  w.post({type:'event',sessionId:'a',event:{type:'tool_started',tool:'Read',label:'/x.ts'}});
  w.post({type:'event',sessionId:'a',event:{type:'tool_completed',tool:'Read',label:'/x.ts',summary:'ok'}});
  assert.equal(m.children.length,2);
  // Mở lại session: replay cũng phải gộp, nếu không transcript dài gấp đôi.
  w.post({type:'sessionSelected',session:SESSION('done'),events:[
    {type:'command_started',command:'npm test',callId:'c9'},
    {type:'command_completed',command:'npm test',output:'pass',exitCode:0,callId:'c9'}],
    workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.length,1,'replay cũng chỉ một dòng');
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

  // Host gửi lại cùng request khi thẻ vẫn còn trên DOM.
  w.post(REQ);
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,1,'không được nhân đôi');

  // Render lại xoá DOM; replay phải dựng lại thẻ, nếu không câu hỏi biến mất mà CLI vẫn chặn.
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,0);
  w.post(REQ);
  assert.equal(m.children.filter((c:any)=>c.className==='perm').length,1,'phải hiện lại sau render');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a dead request card is locked with a reason instead of staying clickable',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'permission',request:{requestId:'q1',toolName:'AskUserQuestion',input:{questions:[
    {question:'Tabs or spaces?',options:[{label:'Tabs'}]}]}}});
  const card=w.document.getElementById('messages').children[0];
  w.post({type:'permissionClosed',requestId:'q1',note:'the turn ended'});
  assert.ok(card.classList.contains('answered'),'thẻ phải bị khoá');
  assert.ok(card.textContent.includes('the turn ended'),'và nói rõ vì sao');
  // Gửi lại lần nữa không được chồng thêm ghi chú.
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
  assert.ok(!plain.textContent.includes('Allow may be refused'),'tool thường không được dán nhãn này');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

/** Gom (tag, class) của cả cây con — đủ để biết markdown đã thành element hay còn là text. */
function shape(n:any,out:string[]=[]){for(const c of n.children||[]){
  if(c.tag)out.push(c.tag+(c.className?'.'+c.className:''));shape(c,out)}return out}

test('a half-written answer is formatted while it streams, not left as raw markdown',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  const send=(text:string)=>w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text}});
  send('`docker prune` xoá **stopped containers**:\n\n');
  send('| Container | Size |\n|---|---|\n| `api` | **491 MB** |\n');
  const card=m.children[0];
  const tags=shape(card);
  assert.ok(tags.includes('code')&&tags.includes('strong'),'đang chạy đã phải có code/strong: '+tags.join(','));
  assert.ok(tags.includes('table.md-table'),'bảng phải là bảng thật, không phải đống dấu |');
  assert.ok(!card.textContent.includes('**'),'không được còn dấu ** trong text');
  assert.ok(!card.textContent.includes('\u0060'),'không được còn backtick trong text');

  // Khối đã chốt chỉ vẽ một lần: delta sau không được nhân đôi đoạn đầu.
  send('\ncòn nữa\n');
  assert.equal(shape(m.children[0]).filter(t=>t==='table.md-table').length,1);

  // turn_done vẽ lại từ text gốc; kết quả phải trùng với lúc mở lại transcript.
  const raw='`docker prune` xoá **stopped containers**:\n\n| Container | Size |\n|---|---|\n| `api` | **491 MB** |\n\ncòn nữa\n';
  w.post({type:'event',sessionId:'a',event:{type:'turn_done'}});
  const live=shape(m.children[0]);
  w.post({type:'sessionSelected',session:SESSION('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'assistant_message',text:raw}]});
  assert.deepEqual(live,shape(w.document.getElementById('messages').children[0]),'live và replay phải ra cùng một DOM');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('an assistant image event renders an inline preview',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'event',sessionId:'a',event:{type:'assistant_image',src:'data:image/png;base64,aGk=',alt:'image.png'}});
  const card=w.document.getElementById('messages').children[0];
  const img=card.children.find((x:any)=>x.tag==='img');
  assert.ok(img,'phải có thẻ img trong message assistant');
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
  assert.equal(tags.filter(t=>t.startsWith('pre')).length,1,'fence chưa đóng vẫn là MỘT block: '+tags.join(','));
  assert.ok(m.children[0].textContent.includes('docker df'),'phần sau dòng trắng phải nằm trong block');
  // Nối thêm vào fence đang mở rồi đóng lại: nội dung phải khớp từng ký tự với nguồn.
  w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'docker volume ls\n'}});
  w.post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'```\n\nxong.\n'}});
  w.post({type:'event',sessionId:'a',event:{type:'turn_done'}});
  const live=m.children[0].textContent;
  w.post({type:'sessionSelected',session:SESSION('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'assistant_message',
      text:'```sh\ndocker ps\n\ndocker df\ndocker volume ls\n```\n\nxong.\n'}]});
  assert.equal(live,w.document.getElementById('messages').children[0].textContent,
    'stream và replay phải ra cùng nội dung');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('underscores in identifiers are not italics, without needing regex lookbehind',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'assistant_message',text:'last_token_usage và total_token_usage, còn _đây_ là nhấn.'}]});
  const card=w.document.getElementById('messages').children[0];
  const tags=shape(card);
  assert.equal(tags.filter(t=>t==='em').length,1,'chỉ MỘT chỗ được thành <em>: '+tags.join(','));
  assert.ok(card.textContent.includes('last_token_usage'),'tên biến phải giữ nguyên gạch dưới');
  assert.ok(card.textContent.includes('total_token_usage'));
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('the iOS keyboard shrinks the panel instead of pushing the composer off-screen',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const body=w.document.body,input=w.document.getElementById('input');
  // Trần của textarea là 40% vùng nhìn thấy; cho nội dung "cao vô hạn" để thấy đúng cái trần.
  Object.defineProperty(input,'scrollHeight',{get:()=>9999});
  assert.equal(body.style._v['height'],undefined,'chưa có bàn phím thì không ghi đè gì');

  w.keyboard(420);                       // chưa focus: 420px là số rác, không phải bàn phím
  assert.equal(body.style._v['height'],undefined,'không có ô nhập focus thì không có bàn phím nào');

  w.focusInput();
  w.keyboard(420);                       // bàn phím mở: vùng nhìn thấy còn 420px
  assert.equal(body.style._v['height'],'420px','phải chốt chiều cao theo visualViewport');
  assert.equal(body.dataset.keyboard,'open','mobile footer phải biết keyboard đang mở');
  assert.equal(input.style.height,Math.round(420*0.4)+'px','trần textarea phải theo vùng thật, không theo innerHeight');

  w.keyboard(900);                       // đóng bàn phím
  assert.equal(body.style._v['height'],undefined,'đóng bàn phím thì trả lại 100dvh');
  assert.equal(body.dataset.keyboard,'','đóng keyboard phải trả lại safe-area');

  // iOS bắn `scroll` với chiều cao CŨ sau khi bàn phím đóng; không có chốt focus thì cả app
  // kẹt trong dải 420px ở đỉnh màn hình.
  w.keyboard(420);
  assert.equal(body.style._v['height'],'420px','vẫn đang focus thì 420px là thật');
  w.blurInput();
  assert.equal(body.style._v['height'],undefined,'mất focus là bỏ đè, kể cả visualViewport còn nhỏ');
  w.focusInput();

  // Số rác từ một iframe cross-origin không được biến thành height:0 (panel trắng trơn).
  for(const junk of [0,1,120]){
    w.keyboard(junk);
    assert.equal(body.style._v['height'],undefined,`visualViewport=${junk} phải bị bỏ qua`);
    assert.equal(input.style.height,Math.round(900*0.4)+'px','và trần textarea vẫn theo innerHeight');
  }
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a keyboard opening does not resize the focused composer',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const input=w.document.getElementById('input');
  Object.defineProperty(input,'scrollHeight',{get:()=>40,configurable:true});
  w.fire('input','input',{});                      // đo lại: cỡ nghỉ của ô là 40px
  const writes:string[]=[];let cur=input.style.height;
  Object.defineProperty(input.style,'height',{configurable:true,get:()=>cur,set(v:string){writes.push(v);cur=v}});

  // 0.29.18 để `height:34px` trong CSS còn grow() đo `height:auto` (= `rows="3"` = 73px), nên
  // MỖI event visualViewport nới ô đang focus lên 73px. iOS bắn resize/scroll liên tục lúc bàn
  // phím trồi lên, và đúng một lần relayout đó đủ để WebKit hủy present: tap 1 không lên, tap 2
  // mới lên (lúc đó ô đã ở 73px nên không còn gì để ghi).
  w.focusInput();w.keyboard(420);
  assert.deepEqual(writes,[],'bàn phím trồi lên không được đổi hình học ô đang focus');

  // Nhưng trần theo vùng nhìn thấy thì vẫn phải kẹp khi nội dung dài hơn nó.
  writes.length=0;
  Object.defineProperty(input,'scrollHeight',{get:()=>9999,configurable:true});
  w.fire('input','input',{});
  // `0px` rồi `40px` là phép đo (kẹp về 0 để đọc scrollHeight rồi trả lại): nó CHỈ chạy khi giá
  // trị ô đổi, chứ không phải mỗi event visualViewport — đó là toàn bộ điểm của assert trên.
  assert.deepEqual(writes,['0px','40px',Math.round(420*0.4)+'px'],'nội dung dài thì trần vẫn theo vùng thật');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('on touch there is a file picker, because iOS never fires paste with a file',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const file=w.document.getElementById('file');

  w.fire('attach','click');
  assert.equal(file._clicks,1,'nút kẹp ghim phải mở đúng file input');

  file.files=[{type:'image/png',name:'photo.png'}];
  w.fire('file','change');
  const sent=w.posted.filter((m:any)=>m.type==='pasteImage');
  assert.equal(sent.length,1,'ảnh phải đi lên host qua đúng kênh của paste');
  assert.equal(sent[0].mime,'image/png');
  assert.equal(sent[0].data,'aGk=');
  assert.equal(file.value,'','phải reset để chọn lại cùng một ảnh vẫn kích change');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a picked file the host would reject is refused out loud, not dropped',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const file=w.document.getElementById('file');
  file.files=[{type:'image/heic',name:'IMG_0001.HEIC'}];
  w.fire('file','change');
  assert.equal(w.posted.filter((m:any)=>m.type==='pasteImage').length,0,'mime host không nhận thì đừng gửi');
  const rows=w.document.getElementById('messages').children;
  const last=rows[rows.length-1];
  assert.ok(String(last.className).includes('error'),'phải có dòng lỗi: '+last.className);
  assert.ok(last.textContent.includes('image/heic'),'và nói rõ loại nào bị từ chối');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('the webview boots with every control it listens to, and reports no viewport',()=>{
  const w=boot();
  // `on()` cảnh báo khi thiếu phần tử: sau khi bỏ nút `‹`, warnings rỗng mới chứng minh
  // không còn listener nào trỏ vào id đã biến mất (thiếu một cái là cả script chết).
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
  assert.equal(m.children[0].className,'empty','chỉ báo nhất thời không được thành dòng log');
  // Xong lượt thì xoá: số của lượt trước treo lại sẽ trông như vẫn đang nghĩ.
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
  assert.ok(m.children[0].textContent.includes('…'),'chưa có tham số thì hiện …');
  w.post({type:'event',sessionId:'a',event:{type:'command_started',command:'ls -la',callId:'c1'}});
  assert.equal(m.children.length,1,'lần hai phải ghi đè, không dựng dòng thứ hai');
  assert.ok(m.children[0].textContent.includes('ls -la'));
  w.post({type:'event',sessionId:'a',event:{type:'command_completed',command:'ls -la',output:'x',exitCode:0,callId:'c1'}});
  assert.equal(m.children.length,1,'kết quả vẫn về đúng dòng đó');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('two identical tool calls with no callId stay two rows',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const m=w.document.getElementById('messages');
  w.post({type:'event',sessionId:'a',event:{type:'tool_started',tool:'Read',label:'/x.ts'}});
  w.post({type:'event',sessionId:'a',event:{type:'tool_started',tool:'Read',label:'/x.ts'}});
  assert.equal(m.children.length,2,'không có id thì không được gộp hai lần gọi khác nhau');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('a user message shows the images it was sent with, and a queued image message is not a blank row',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'event',sessionId:'a',event:{type:'user_message',text:'',images:['/att/a.png','/att/b.png'],
    imageSrcs:['vscode-resource://a','vscode-resource://b']}});
  const card=w.document.getElementById('messages').children[0];
  const row=card.children.find((x:any)=>x.className==='uimgs');
  assert.ok(row,'tin của người dùng phải mang theo ảnh nó đã gửi');
  assert.deepEqual(row.children.map((i:any)=>i.src),['vscode-resource://a','vscode-resource://b']);
  // Ảnh bị dọn theo TTL thì chỉ còn alt — tên file vẫn nói được đã gửi gì.
  assert.deepEqual(row.children.map((i:any)=>i.alt),['a.png','b.png']);
  w.post({type:'queue',items:[{text:'',images:2}]});
  const q=w.document.getElementById('queue').children[0];
  assert.equal(q.textContent.includes('2 ảnh'),true,'hàng chờ chỉ-ảnh không được là dòng trống, thấy: '+q.textContent);
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('on a phone the composer drops the keyboard hint and the context tokens leave the label',()=>{
  const phone=boot(undefined,{touch:true});
  phone.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  // ⏎/⇧⏎ không tồn tại trên điện thoại, và hint đó là thứ đẩy composer thành hai dòng.
  assert.equal(phone.document.getElementById('input').placeholder,'Ask Claude\u2026');
  // % ở lại nhãn, số token sang phần tử riêng để CSS hẹp ẩn được nửa sau mà không mất tooltip.
  assert.equal(phone.document.getElementById('ctxtext').textContent,'90%');
  assert.equal(phone.document.getElementById('ctxtokens').textContent,' \u00b7 100/1k');
  const cw=phone.document.getElementById('ctxwrap');
  assert.ok(cw.dataset['aria-label'].includes('Input: 5'),'token vẫn phải còn trong nhãn');
  assert.equal(cw.title,'','không để title: tooltip native chậm và đè lên card');
  const ct=phone.document.getElementById('ctxtip').textContent;
  assert.ok(ct.includes('Context window')&&ct.includes('90%')&&ct.includes('100 / 1k')&&ct.includes('Input5'),'card context thiếu số, thấy: '+ct);
  assert.ok(ct.endsWith('Click to compact'),'card phải nói click là compact, thấy: '+ct);

  const desktop=boot();
  desktop.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.ok(desktop.document.getElementById('input').placeholder.includes('\u23ce send'),'có bàn phím thì hint vẫn đáng in');
});

test('a session with no usage yet clears both halves of the context label',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:{provider:'claude',nativeSessionId:'a',status:'done'},events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.document.getElementById('ctxtext').textContent,'\u2014');
  assert.equal(w.document.getElementById('ctxtokens').textContent,'','số token cũ không được kẹt lại');
});

test('a planner view frame redraws one bubble instead of appending three',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const view=(text:string)=>w.post({type:'event',sessionId:'a',event:{type:'assistant_view',text}});
  view('**Hel');view('**Hello** wor');view('**Hello** world');
  const bubbles=w.document.getElementById('messages').children.filter((c:any)=>String(c.className).includes('assistant'));
  // Mỗi frame là toàn bộ câu trả lời tới lúc đó: nối lại là ba bản của cùng một câu.
  assert.equal(bubbles.length,1,'chỉ được một bong bóng');
  assert.equal(bubbles[0].textContent,'Hello world');
  assert.ok(bubbles[0].classList.contains('assistant-streaming'),'chưa xong thì vẫn là bong bóng đang stream');
  w.post({type:'event',sessionId:'a',event:{type:'turn_done'}});
  assert.equal(bubbles[0].classList.contains('assistant-streaming'),false,'turn_done chốt bong bóng');
  assert.equal(bubbles[0].textContent,'Hello world','chốt lại vẫn phải ra đúng text cuối');
  assert.deepEqual(w.warnings,[],'không được có cảnh báo: '+w.warnings.join(' | '));
});

test('recorded quota renders both rings and an old observation stays marked stale',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:{provider:'claude',nativeSessionId:'a',status:'done',usage:{
    quota5hUsedPercentage:27,quota5hObservedAt:1,quota7dUsedPercentage:35,quota7dObservedAt:1,
    contextUsedTokens:123,contextWindowTokens:1000}},events:[]});
  assert.equal(w.document.getElementById('q5wrap').hidden,false);
  assert.equal(w.document.getElementById('q7wrap').hidden,false);
  // Nhãn nằm span riêng để CSS ẩn được trên điện thoại; số vẫn là % còn lại.
  assert.equal(w.document.getElementById('q5lab').textContent,'5h');
  assert.equal(w.document.getElementById('q5text').textContent,'~73%');
  assert.equal(w.document.getElementById('q7text').textContent,'~65%');
  assert.match(w.document.getElementById('ctxtokens').textContent,/123/);
});

/** Chip git: chỉ là cây làm việc bẩn, và untracked chỉ vào số file chứ không vào số dòng. */
const SCM=(x:any)=>Object.assign({branch:'main',upstream:'origin/main',ahead:0,behind:0,
  files:0,untracked:0,added:0,removed:0,changes:[]},x);

test('không có dữ liệu git thì cả hai chip biến mất, không vẽ số 0',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:2,added:3,removed:1})});
  assert.equal(w.byId.scm.hidden,false);
  w.post({type:'scm'});
  assert.equal(w.byId.scm.hidden,true,'project không phải repo git');
  assert.equal(w.byId.branch.hidden,true);
});

test('cây sạch giấu chip thay đổi nhưng vẫn cho thấy branch và số commit chưa push',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({ahead:3,behind:2})});
  assert.equal(w.byId.scm.hidden,true,'0 file đổi thì chip kia chỉ chiếm chỗ');
  assert.equal(w.byId.branch.hidden,false);
  assert.equal(w.byId.branch.textContent,'\u2387 main\u21913\u21932');
  assert.match(w.byId.branch.title,/3 commit\(s\) to push/);
});

test('không có upstream thì tooltip nói thẳng là chưa push gì, không im lặng',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({upstream:undefined,branch:'feature/x'})});
  assert.match(w.byId.branch.title,/No upstream/);
});

test('378/14 ra 4 ô xanh + 1 ô xám, đúng như thanh 5 ô của GitHub',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:12,added:378,removed:14})});
  assert.equal(w.byId.scm.textContent,'12+378\u221214');
  const bar=w.byId.scm.children[3];
  assert.deepEqual(bar.children.map((c:any)=>c.className),['sq add','sq add','sq add','sq add','sq']);
});

test('một phía chiếm trọn diff thì lấp cả năm ô; phía quá nhỏ bị làm tròn mất, số vẫn còn',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:1,added:0,removed:100})});
  assert.deepEqual(w.byId.scm.children[3].children.map((c:any)=>c.className),
    ['sq del','sq del','sq del','sq del','sq del']);
  // 1/101 không đủ một ô. Thanh là thứ đọc lướt; con số chính xác nằm ngay cạnh nó.
  w.post({type:'scm',status:SCM({files:2,added:1,removed:100})});
  assert.deepEqual(w.byId.scm.children[3].children.map((c:any)=>c.className),
    ['sq del','sq del','sq del','sq del','sq']);
  // Trừ khi phía kia cũng trắng: một diff toàn-thêm không được ra thanh xám trơn.
  w.post({type:'scm',status:SCM({files:1,added:3,removed:0})});
  assert.deepEqual(w.byId.scm.children[3].children.map((c:any)=>c.className),
    ['sq add','sq add','sq add','sq add','sq add']);
});

test('untracked được nói rõ trong tooltip vì số dòng của nó không được đếm',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:5,untracked:2,added:10,removed:1})});
  assert.match(w.byId.scm.title,/2 untracked/);
});

test('bấm chip mở danh sách file ở host, không tự dựng menu trong webview',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:2,added:2,removed:0})});
  w.fire('scm','click');
  assert.deepEqual(w.posted.filter((m:any)=>m.type==='pickChanged'),[{type:'pickChanged'}]);
});

test('vẽ lại header vì lý do khác không xoá mất chip git',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  w.post({type:'scm',status:SCM({files:2,added:2,removed:0})});
  w.post({type:'sessionUpdated',session:SESSION('running')});
  assert.equal(w.byId.scm.hidden,false);
  assert.equal(w.byId.scm.textContent,'2+2\u22120');
});

test('xong lượt thì thanh thinking ở lại làm footer tổng kết, không biến mất',()=>{
  const w=boot();
  const t0=Date.now()-120000;
  w.post({type:'sessionSelected',session:SESSION('running'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.byId.thinking.hidden,false,'đang chạy thì thanh phải hiện');
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
  assert.equal(w.byId.thinking.hidden,false,'xong rồi thanh vẫn phải ở lại');
  assert.equal(w.byId.thinkword.textContent,'Done');
  assert.equal(w.byId.thinktime.textContent,'1m 0s','đo theo mốc thời gian của event, không theo đồng hồ spinner');
  const meta=w.byId.thinktokens.textContent;
  // started + completed cùng callId là MỘT lượt gọi: 1 Bash + 2 Read = 3.
  assert.ok(/3 calls/.test(meta),meta);
  assert.ok(/Read 2/.test(meta)&&/Bash 1/.test(meta),meta);
  assert.ok(/21\.2k tok/.test(meta),meta);
  assert.ok(/\$0\.123/.test(meta),meta);
  assert.equal(w.byId.cancel.hidden,true,'không còn gì để Stop');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('đổi tab giữa lúc chạy thì đồng hồ tính lại cho phiên mới, không xài tiếp của phiên cũ',()=>{
  const w=boot();
  const now=Date.now();
  const A=(status:string)=>({provider:'claude',nativeSessionId:'a',status});
  const B=(status:string)=>({provider:'claude',nativeSessionId:'b',status});
  w.post({type:'sessionSelected',session:A('running'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'go',timestamp:now-90000}]});
  assert.equal(w.byId.thinktime.textContent,'1m 30s','mốc lấy từ transcript, không phải lúc mở tab');
  w.post({type:'event',sessionId:'a',event:{type:'thinking',tokens:1200,timestamp:now}});
  assert.equal(w.byId.thinktokens.textContent,'· 1.2k thinking');
  // Phiên khác, cũng đang chạy: cả giờ lẫn số token thinking phải là của phiên MỚI.
  w.post({type:'sessionSelected',session:B('running'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'hi',timestamp:now-5000}]});
  assert.equal(w.byId.thinktime.textContent,'5s','không được đếm tiếp đồng hồ của phiên cũ');
  assert.equal(w.byId.thinktokens.textContent,'','token thinking của phiên cũ phải sạch');
  assert.equal(w.timers.filter((t:any)=>t.ms===1000).length,1,'chỉ được còn MỘT đồng hồ chạy');
  // Quay lại phiên cũ vẫn ra đúng giờ, không reset về 0s.
  w.post({type:'sessionSelected',session:A('running'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'go',timestamp:now-90000}]});
  assert.equal(w.byId.thinktime.textContent,'1m 30s');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

/**
 * `SessionManager.resume` phát `sessionUpdated`('running') TRƯỚC `user_message`, nên lúc đồng hồ
 * khởi động thì transcript còn kết thúc ở lượt trước. Không neo lại là giây hiển thị cộng dồn
 * cả lượt cũ lẫn lượt mới.
 */
test('lượt thứ hai của cùng một phiên đếm từ tin MỚI, không cộng dồn lượt trước',()=>{
  const w=boot();
  const now=Date.now();
  const S=(status:string)=>({provider:'claude',nativeSessionId:'a',status});
  w.post({type:'sessionSelected',session:S('done'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'lượt 1',timestamp:now-600000},{type:'turn_done',timestamp:now-590000}]});
  w.post({type:'sessionUpdated',session:S('running')});
  w.post({type:'event',sessionId:'a',event:{type:'user_message',text:'lượt 2',timestamp:now-4000}});
  assert.equal(w.byId.thinktime.textContent,'4s','phải neo lại vào tin của lượt mới');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('footer tổng kết chỉ in thứ đo được, và nói rõ lượt bị dừng',()=>{
  const w=boot();
  // Không có lượt nào (transcript rỗng) thì không dựng footer rỗng.
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  assert.equal(w.byId.thinking.hidden,true,'chưa có lượt nào thì ẩn hẳn');
  // Mốc thời gian vô nghĩa (transcript nhập từ CLI) thì bỏ giờ, không in số sai.
  w.post({type:'sessionSelected',session:SESSION('cancelled'),workspace:{name:'W'},project:{name:'P'},
    events:[{type:'user_message',text:'go'},{type:'tool_started',tool:'Grep',label:'x'}]});
  assert.equal(w.byId.thinking.hidden,false);
  assert.equal(w.byId.thinkword.textContent,'Stopped');
  assert.equal(w.byId.thinktime.textContent,'','không có mốc thời gian thì không in giờ');
  assert.equal(w.byId.thinktokens.textContent,'· 1 call (Grep 1)');
  assert.deepEqual(w.warnings,[],w.warnings.join(' | '));
});

test('nút copy ID chỉ hiện khi có session thật, và tooltip mang luôn ID',()=>{
  const w=boot();
  assert.equal(w.document.getElementById('copyid').hidden,true,'nháp chưa có id nào để chép');
  w.post({type:'sessionSelected',session:SESSION('done'),events:[],workspace:{name:'W'},project:{name:'P'}});
  const b=w.document.getElementById('copyid');
  assert.equal(b.hidden,false);
  assert.match(b.title,new RegExp(SESSION('done').nativeSessionId));
});

test('chip cache đếm ngược TTL như extension chính thức, nguội thì nói lượt kế ghi lại bao nhiêu',()=>{
  const w=boot();
  const sel=(usage:any)=>w.post({type:'sessionSelected',session:{...SESSION('done'),usage:{...SESSION('done').usage,...usage}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  sel({});
  assert.equal(w.byId.cachewrap.hidden,true,'chưa biết TTL thì ẩn, không đoán');
  sel({cacheAnchorAt:Date.now()-10*60000,cacheTtlMs:3600000,cacheTokens:118000});
  assert.equal(w.byId.cachewrap.hidden,false);
  assert.equal(w.byId.cachetext.textContent,'50m');
  const tip=w.byId.cachetip.textContent;
  assert.ok(tip.includes('Prompt cache')&&tip.includes('TTL 1h')&&/Expiresin 50m/.test(tip),'card cache thiếu số, thấy: '+tip);
  assert.equal(w.timers.some((t:any)=>t.ms===60000),true,'đếm ngược cần đồng hồ phút');
  sel({cacheAnchorAt:Date.now()-2*3600000,cacheTtlMs:3600000,cacheTokens:118000});
  assert.equal(w.byId.cachetext.textContent,'cold');
  assert.ok(w.byId.cachetip.textContent.includes('re-cache about 118k tokens'),'thấy: '+w.byId.cachetip.textContent);
  sel({cacheAnchorAt:0,cacheTtlMs:3600000});
  assert.ok(w.byId.cachetip.textContent.includes('compacted'),'compact xong thì cache cũ không còn khớp');
});

test('card 5h/7d nói bao nhiêu % usage đến từ session song song và sub-agent',()=>{
  const w=boot();
  w.post({type:'sessionSelected',session:{...SESSION('done'),usage:{...SESSION('done').usage,
    quota5hUsedPercentage:20,quota5hObservedAt:Date.now(),quota7dUsedPercentage:25,quota7dObservedAt:Date.now(),
    usageInsights:{observedAt:Date.now(),
      day:{requests:1772,sessions:25,behaviors:[{key:'subagent_heavy',pct:39},{key:'long_context',pct:72}],top:[{group:'skills',name:'impl',pct:12}]},
      week:{requests:18494,sessions:2164,behaviors:[{key:'high_parallel',pct:28}],top:[]}}}},
    events:[],workspace:{name:'W'},project:{name:'P'}});
  const d=w.byId.q5tip.textContent,wk=w.byId.q7tip.textContent;
  assert.ok(d.includes('Last 24h')&&d.includes('Subagent-heavy sessions39%')&&d.includes('/impl12%'),'card 5h lấy cửa sổ 24h, thấy: '+d);
  assert.ok(d.indexOf('At >150k context')<d.indexOf('Subagent-heavy'),'xếp % giảm dần');
  assert.ok(wk.includes('Last 7d')&&wk.includes('While 4+ sessions ran in parallel28%'),'card 7d lấy cửa sổ 7 ngày, thấy: '+wk);
  assert.ok(d.includes('overlapping, not a breakdown'),'các % chồng nhau — phải nói, kẻo đọc ra phần chia');
});

test('local media paths in a reply render as img/video, remote and non-media ones do not',()=>{
  const all=(n:any,out:any[]=[]):any[]=>{for(const c of n.children||[]){out.push(c);all(c,out)}return out};
  const reply='Xong: ![demo](/tmp/a.gif)\n\nVideo `/Users/x/my demo.mp4`, log `/tmp/notes.txt`, ![r](https://x/y.png)';
  const {post,byId}=boot();
  post({type:'sessionSelected',session:SESSION('done'),events:[{type:'assistant_message',text:reply,timestamp:1}]});
  assert.equal(all(byId.messages).filter((n:any)=>n.tag==='img'||n.tag==='video').length,0,'chưa có mediaBase thì không dựng media');
  post({type:'mediaBase',base:'https://res'});
  post({type:'sessionSelected',session:SESSION('done'),events:[{type:'assistant_message',text:reply,timestamp:1}]});
  const nodes=all(byId.messages);
  assert.deepEqual(nodes.filter((n:any)=>n.tag==='img').map((n:any)=>n.src),['https://res/tmp/a.gif']);
  assert.deepEqual(nodes.filter((n:any)=>n.tag==='video').map((n:any)=>n.src),['https://res/Users/x/my%20demo.mp4']);
  assert.ok(nodes.some((n:any)=>n.tag==='a'&&n.dataset.href==='https://x/y.png'),'ảnh remote vẫn chỉ là link');
});

test('a streaming tail does not build media until its paragraph is closed',()=>{
  const all=(n:any,out:any[]=[]):any[]=>{for(const c of n.children||[]){out.push(c);all(c,out)}return out};
  const {post,byId}=boot();
  post({type:'mediaBase',base:'https://res'});
  post({type:'sessionSelected',session:SESSION('running'),events:[]});
  post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'![x](/tmp/a.webm)',timestamp:1}});
  assert.equal(all(byId.messages).filter((n:any)=>n.tag==='video').length,0,'đuôi vẽ lại mỗi delta — dựng video ở đây là nạp lại liên tục');
  post({type:'event',sessionId:'a',event:{type:'assistant_delta',text:'\n\nxong',timestamp:2}});
  assert.equal(all(byId.messages).filter((n:any)=>n.tag==='video').length,1);
});
