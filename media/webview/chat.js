const vscode=acquireVsCodeApi();
let state={session:null,draft:null,events:[],workspace:null,project:null,scm:null};
const $=id=>document.getElementById(id);
// Thiếu một phần tử từng làm cả script chết, kéo theo Enter mất tác dụng.
const on=(id,ev,fn)=>{const el2=$(id);if(el2)el2.addEventListener(ev,fn);else console.warn('Dev Hub: missing #'+id)};
function el(tag,cls,text){const d=document.createElement(tag);if(cls)d.className=cls;if(text!=null)d.textContent=text;return d}
function compact(n){if(n==null)return '\u2014';if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,'')+'m';if(n>=1e3)return (n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,'')+'k';return String(n)}
function stale(at){return at!=null&&Date.now()-at>15*60*1000}
/* Mọi vòng đều đo phần CÒN LẠI: cung đầy = còn nguyên, cạn dần theo mức tiêu thụ. */
function ringColor(left){return left<0.1?'var(--vscode-editorError-foreground)':left<0.3?'var(--vscode-editorWarning-foreground)':'var(--accent)'}
function inWords(ms){const m=Math.max(0,Math.round(ms/60000));return m<60?m+'m':Math.floor(m/60)+'h '+(m%60)+'m'}
/**
 * Một vòng quota: cung và chữ đều là % quota CÒN LẠI — cùng chiều với vòng context, vì ba
 * vòng giống hệt nhau mà ngược nghĩa thì không ai đọc ra. Lúc nào reset thì để tooltip.
 * Chỉ Claude báo quota — provider khác thì ẩn hẳn, chứ để "5h \u2014" đọc ra như đang load dở.
 */
function renderQuota(key,label,long,used,at,resetsAt,ins){
  const wrap=$(key+'wrap');if(!wrap)return;
  if(used==null){wrap.hidden=true;return}
  wrap.hidden=false;
  const remain=1-Math.max(0,Math.min(1,used/100));
  const until=resetsAt!=null?Math.max(0,resetsAt-Date.now()):null;
  const arc=$(key+'arc');
  arc.setAttribute('stroke-dasharray',(remain*CIRC).toFixed(1)+' '+CIRC.toFixed(1));
  arc.setAttribute('stroke',ringColor(remain));
  // Nhãn tách khỏi số: ở bề ngang điện thoại CSS ẩn nhãn và chỉ giữ %, vì hai chữ "5h"/"7d"
  // là thứ duy nhất trong hàng có thể bỏ mà vẫn còn đọc ra (thứ tự vòng cố định 5h rồi 7d).
  $(key+'lab').textContent=label;
  $(key+'text').textContent=(stale(at)?'~':'')+Math.round(remain*100)+'%';
  // Tooltip nói cả hai con số: status bar và `/status` của CLI đều đọc theo "đã dùng".
  // Không dùng `title`: tooltip native hiện sau ~1s và trông như chú thích hệ điều hành — card
  // riêng hiện ngay khi hover; aria-label giữ câu đầy đủ cho screen reader.
  wrap.setAttribute('aria-label',long+' \u00b7 '+Math.round(remain*100)+'% left \u00b7 '+Math.round(used)+'% used'
    +(resetsAt!=null?' \u00b7 resets '+new Date(resetsAt).toLocaleString()+' (in '+inWords(until)+')':''));
  const tip=$(key+'tip');if(tip)quotaTip(tip,long,remain,used,at,resetsAt,until,ins);
}
// Phần đầu chung của card hover (quota + context): tên, % còn lại to theo màu vòng, thanh.
function tipGauge(tip,head,remain,right,bigText){tip.textContent='';
  tip.appendChild(el('div','qt-head',head));
  const big=el('div','qt-big');const n=el('span','qt-left',bigText||(remain==null?'\u2014':Math.round(remain*100)+'%'));
  if(remain!=null)n.style.color=ringColor(remain);
  big.appendChild(n);big.appendChild(el('span','qt-unit','left'));if(right)big.appendChild(el('span','qt-used',right));tip.appendChild(big);
  const bar=el('div','qt-bar'),fill=el('div','qt-fill');fill.style.width=((remain||0)*100).toFixed(1)+'%';
  if(remain!=null)fill.style.background=ringColor(remain);
  bar.appendChild(fill);tip.appendChild(bar)}
function quotaTip(tip,long,remain,used,at,resetsAt,until,ins){tipGauge(tip,long,remain,Math.round(used)+'% used');
  if(resetsAt!=null){const d=new Date(resetsAt);
    // Dưới một ngày thì giờ là đủ; quota tuần phải có thứ, không thì "11:00" đọc ra là hôm nay.
    const when=until<24*3600*1000?d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})
      :d.toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    const r=el('div','qt-row');r.appendChild(el('span',null,'Resets'));r.appendChild(el('b',null,'in '+inWords(until)));
    r.appendChild(el('span','qt-when',when));tip.appendChild(r)}
  if(stale(at))tip.appendChild(el('div','qt-stale','Observed '+inWords(Date.now()-at)+' ago \u2014 may be outdated'));
  if(ins)insightRows(tip,ins)}
/**
 * `get_usage` của CLI, đúng chữ extension chính thức. Các % là đặc điểm CHỒNG nhau (một request
 * vừa >150k context vừa chạy lúc 4+ session song song), không phải phần chia — cộng lại quá 100
 * là bình thường, nên card phải nói rõ thế. Card 5h lấy cửa sổ 24h, card 7d lấy 7 ngày.
 */
const INSIGHT={cache_miss:'>100k-token cache miss',long_context:'At >150k context',subagent_heavy:'Subagent-heavy sessions',
  high_parallel:'While 4+ sessions ran in parallel',cron:'Sessions active 8h+'};
const INSIGHT_GROUP={agents:n=>'Subagent '+n,skills:n=>'/'+n,plugins:n=>'Plugin '+n,mcp_servers:n=>'MCP '+n};
function insightRows(tip,ins){const w=ins.win;if(!w)return;
  const rows=[];(w.behaviors||[]).forEach(b=>{if(INSIGHT[b.key])rows.push([INSIGHT[b.key],b.pct])});
  (w.top||[]).forEach(t=>{const f=INSIGHT_GROUP[t.group];if(f&&t.pct>0)rows.push([f(t.name),t.pct])});
  rows.sort((a,b)=>b[1]-a[1]);
  const sec=el('div','qt-sec');
  sec.appendChild(el('div','qt-head',(ins.day?'Last 24h':'Last 7d')+(w.requests!=null?' \u00b7 '+compact(w.requests)+' requests':'')
    +(w.sessions!=null?' \u00b7 '+w.sessions+' sessions':'')));
  if(!rows.length)sec.appendChild(el('div','qt-row','Nothing notable in this window'));
  rows.forEach(r=>{const row=el('div','qt-row');row.appendChild(el('span','qt-name',r[0]));row.appendChild(el('b','qt-when',Math.round(r[1])+'%'));sec.appendChild(row)});
  sec.appendChild(el('div','qt-foot','% of usage \u00b7 overlapping, not a breakdown \u00b7 local sessions on this machine'
    +(stale(ins.at)?' \u00b7 as of '+inWords(Date.now()-ins.at)+' ago':'')));
  tip.appendChild(sec)}
/**
 * Còn bao lâu prompt cache hết hạn, tính như extension chính thức: mốc request cuối chạm cache
 * + TTL (5m/1h). Gửi trong khoảng này thì lượt kế đọc lại cache; quá hạn thì ghi lại cả hội thoại.
 */
function cacheState(u,now){if(u.cacheAnchorAt===0)return {kind:'compacted'};
  if(u.cacheAnchorAt==null||!u.cacheTtlMs)return {kind:'unknown'};
  const left=Math.min(u.cacheTtlMs,u.cacheAnchorAt+u.cacheTtlMs-now);
  return left>0?{kind:'warm',left,ttl:u.cacheTtlMs}:{kind:'cold',idle:now-u.cacheAnchorAt}}
function renderCache(u){const wrap=$('cachewrap');if(!wrap)return;
  const now=Date.now(),c=cacheState(u,now);
  if(c.kind==='unknown'){wrap.hidden=true;return}
  wrap.hidden=false;const txt=$('cachetext'),tip=$('cachetip');
  const toks=u.cacheTokens?'about '+compact(u.cacheTokens)+' tokens':'the conversation';
  if(c.kind==='warm'){const m=Math.ceil(c.left/60000),frac=c.left/c.ttl;
    txt.textContent=m+'m';txt.style.color=frac<0.3?ringColor(frac):'';
    wrap.setAttribute('aria-label','Prompt cache warm, about '+m+' min left.');
    if(!tip)return;
    tipGauge(tip,'Prompt cache',frac,'TTL '+(c.ttl>=3600000?'1h':'5m'),m+'m');
    const r=el('div','qt-row');r.appendChild(el('span',null,'Expires'));r.appendChild(el('b',null,'in '+inWords(c.left)));
    r.appendChild(el('span','qt-when',new Date(now+c.left).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})));tip.appendChild(r);
    tip.appendChild(el('div','qt-foot','Send before then and the next turn reads the cache; after, it re-caches '+toks+'.'));return}
  txt.textContent='cold';txt.style.color='var(--vscode-editorWarning-foreground)';
  const msg=c.kind==='compacted'?'The conversation was compacted, so your next message will re-cache it.'
    :'Idle '+inWords(c.idle)+'. The prompt cache has likely expired, so your next message will re-cache '+toks+'.';
  wrap.setAttribute('aria-label',msg);if(!tip)return;
  tipGauge(tip,'Prompt cache',0,c.kind==='compacted'?'compacted':'expired','cold');
  tip.appendChild(el('div','qt-foot',msg))}
let quotaTimer=null;
function renderQuotas(){const u=(state.session&&state.session.usage)||{};
  const ins=u.usageInsights;
  renderQuota('q5','5h','Five-hour limit',u.quota5hUsedPercentage,u.quota5hObservedAt,u.quota5hResetsAt,ins&&ins.day?{win:ins.day,day:true,at:ins.observedAt}:null);
  renderQuota('q7','7d','Weekly limit',u.quota7dUsedPercentage,u.quota7dObservedAt,u.quota7dResetsAt,ins&&ins.week?{win:ins.week,day:false,at:ins.observedAt}:null);
  renderCache(u);
  // Event `usage` chỉ tới mỗi lượt, mà dấu `~` và đếm ngược trong tooltip chạy theo đồng hồ.
  // Đồng hồ chỉ sống khi có vòng để nhích: tab Planner không đẻ timer vô ích.
  const cw=$('cachewrap');const live=!$('q5wrap').hidden||!$('q7wrap').hidden||(cw&&!cw.hidden);
  if(live&&!quotaTimer)quotaTimer=setInterval(renderQuotas,60*1000);
  else if(!live&&quotaTimer){clearInterval(quotaTimer);quotaTimer=null}}
function tokenTip(u){u=u||{};const p=[];
  const add=(k,v)=>{if(v!=null)p.push(k+': '+compact(v))};
  add('Input',u.inputTokens);add('Cache read',u.cachedInputTokens);add('Cache write',u.cacheWriteInputTokens);
  add('Output',u.outputTokens);add('Reasoning',u.reasoningOutputTokens);
  if(u.costUsd!=null)p.push('Cost: $'+Number(u.costUsd).toFixed(4));
  return p.join('\n')||'No token data yet'}
function remember(e){state.events.push(e);if(state.events.length>1500)state.events.splice(0,state.events.length-1500)}
function providerName(p){return p==='planner'?'Planner':'Claude'}
// Logo hãng vẽ inline: localResourceRoots chỉ mở gốc media, không nạp được file khác.
const MARK={claude:'M8.8 12a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0ZM9.9 4a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM2.972 8a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM2.972 16a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM9.9 20a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM16.828 16a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM16.828 8a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0Z',planner:'M12 .5a1.9 1.9 0 0 1 0 3.8 1.9 1.9 0 0 1 0-3.8zM11.15 3h1.7v5.2h-1.7zM7 7h10a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4zM9.2 11.7a1.7 1.7 0 0 0 0 3.4 1.7 1.7 0 0 0 0-3.4zM14.8 11.7a1.7 1.7 0 0 0 0 3.4 1.7 1.7 0 0 0 0-3.4z'};
function mark(p,size){const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');const px=String(size||14);
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width',px);svg.setAttribute('height',px);svg.setAttribute('class','mark');
  const path=document.createElementNS(ns,'path');path.setAttribute('d',MARK[p]||'');path.setAttribute('fill','currentColor');
  svg.appendChild(path);return svg}
const CIRC=2*Math.PI*10;
/** Đọc một lần: loại con trỏ không đổi giữa phiên, và composer đọc nó mỗi lần vẽ header. */
const TOUCH=(()=>{try{return !!(window.matchMedia&&window.matchMedia('(hover:none)').matches)}catch(e){return false}})();
const WORDS=['Cooking','Vibing','Noodling','Percolating','Simmering','Brewing','Conjuring','Wrangling','Tinkering','Schlepping','Puzzling','Whirring','Marinating','Spelunking'];
let think={timer:null,at:0,word:0,key:''};
/** Một định dạng cho cả lúc chạy và lúc tổng kết: hai con số cạnh nhau phải đọc cùng kiểu. */
function dur(ms){const s2=Math.max(0,Math.round(ms/1000));return s2<60?s2+'s':Math.floor(s2/60)+'m '+(s2%60)+'s'}
/** Logo xoay = đang chạy. Đứng yên = đã xong (thanh này ở lại làm footer tổng kết lượt). */
/** Khoá theo phiên: đổi tab giữa chừng thì đồng hồ phải tính lại cho phiên MỚI, không dùng tiếp. */
function thinkKey(){const s2=state.session;return s2?s2.provider+'|'+s2.nativeSessionId:''}
/**
 * Mốc đầu lượt lấy từ transcript chứ không phải lúc mở tab — quay lại một tab đang chạy vẫn ra
 * đúng số giây. Cùng cái bẫy của turnSummary: transcript nhập từ CLI có thể mang mốc vô nghĩa.
 */
function turnStart(){const ev=state.events||[];
  for(let i=ev.length-1;i>=0;i--)if(ev[i].type==='user_message'){
    const t=ev[i].timestamp||0,d=Date.now()-t;
    return (t&&d>=0&&d<24*3600*1000)?t:Date.now()}
  return Date.now()}
function startThinking(){
  const key=thinkKey();
  if(think.timer){if(think.key===key)return;clearInterval(think.timer);think.timer=null}
  think.key=key;think.at=turnStart();think.word=Math.floor(Math.random()*WORDS.length);
  const sp=$('spinner');sp.textContent='';const p=(state.session&&state.session.provider)||'claude';sp.appendChild(mark(p));
  const box=$('thinking');box.hidden=false;box.classList.remove('done');box.title='';
  const cn=$('cancel');if(cn)cn.hidden=false;
  const tick=()=>{
    const secs=Math.round((Date.now()-think.at)/1000);
    $('thinktime').textContent=dur(Date.now()-think.at);
    // Đổi động từ mỗi ~4s để thấy nó còn sống chứ không treo.
    if(secs&&secs%4===0)$('thinkword').textContent=WORDS[(++think.word)%WORDS.length];
  };
  $('thinkword').textContent=WORDS[think.word];setThinkTokens(null);tick();
  think.timer=setInterval(tick,1000);
}
/**
 * Nội dung thinking bị bịt, chỉ có số token ước lượng. Đó là thứ DUY NHẤT nhúc nhích trong
 * khoảng lặng giữa hai tool call (đo được 2,5s trước tool đầu, 1,5s sau mỗi kết quả).
 */
function setThinkTokens(n){const e2=$('thinktokens');if(!e2)return;
  e2.textContent=n==null?'':'· '+(n<1000?String(n):(n/1000).toFixed(1).replace(/\.0$/,'')+'k')+' thinking'}
/**
 * `sessionUpdated`('running') tới TRƯỚC `user_message` của lượt mới (SessionManager phát theo
 * thứ tự đó), nên lúc đồng hồ khởi động, `state.events` còn kết thúc ở lượt TRƯỚC — mốc lấy ra
 * là mốc cũ và giây hiển thị thành thời gian cộng dồn của hai lượt. Tin của lượt mới tới thì
 * neo lại; `startThinking` không làm hộ được vì nó thoát sớm khi cùng một phiên.
 */
function reanchorThinking(at){if(!think.timer)return;const t=Number(at)||Date.now();
  if(!(t>think.at&&Date.now()-t>=0))return;
  think.at=t;$('thinktime').textContent=dur(Date.now()-think.at)}
function stopThinking(){if(think.timer){clearInterval(think.timer);think.timer=null}think.key='';setThinkTokens(null);renderTurnSummary()}
/**
 * Tổng kết lượt CUỐI, tính lại từ chính transcript: không cần host gửi thêm event nào, và mở
 * lại một tab cũ vẫn dựng ra đúng con số đó. Mốc đầu lượt là `user_message` gần nhất.
 * Một lượt gọi đếm MỘT lần: `*_started` và `*_completed` của nó cùng `callKey`.
 */
function turnSummary(){
  const ev=state.events||[];let start=-1;
  for(let i=ev.length-1;i>=0;i--)if(ev[i].type==='user_message'){start=i;break}
  if(start<0)return null;
  const at=ev[start].timestamp||0;
  const seen={},counts={};let calls=0,usage=null,end=at;
  for(let i=start+1;i<ev.length;i++){const e=ev[i];
    if(e.timestamp)end=e.timestamp;
    if(e.type==='usage'){usage=Object.assign({},usage||{},e.usage||{});continue}
    if(!/^(tool|command)_(started|completed)$/.test(e.type))continue;
    const name=e.type.indexOf('command')===0?'Bash':String(e.tool||'Tool');
    const k=name+'\u0000'+callKey(e);
    if(seen[k])continue;seen[k]=1;calls++;
    counts[name]=(counts[name]||0)+1}
  const names=Object.keys(counts).map(n=>[n,counts[n]]).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1));
  const ms=end-at;
  // Transcript nhập từ CLI có thể mang mốc thời gian vô nghĩa — thà không in giờ hơn in sai.
  return {ms:(at&&ms>0&&ms<24*3600*1000)?ms:null,calls:calls,names:names,usage:usage};
}
/**
 * Xong lượt thì thanh thinking KHÔNG mất đi: nó đổi vai thành footer tổng kết. Chỉ in mảnh
 * nào đo được — thiếu token hay giá thì bỏ hẳn mảnh đó, chứ đừng in "—" cho ra vẻ có số.
 */
function renderTurnSummary(){
  const box=$('thinking');if(!box)return;
  const s=turnSummary(),st=(state.session&&state.session.status)||'';
  const u=(s&&s.usage)||{};
  const tok=(Number(u.inputTokens)||0)+(Number(u.outputTokens)||0);
  if(!s||(!s.calls&&s.ms==null&&!tok&&u.costUsd==null)){box.hidden=true;box.title='';return}
  box.hidden=false;box.classList.add('done');
  const cn=$('cancel');if(cn)cn.hidden=true;
  const sp=$('spinner');sp.textContent='';sp.appendChild(mark((state.session&&state.session.provider)||'claude'));
  $('thinkword').textContent=st==='failed'?'Failed':st==='cancelled'?'Stopped':'Done';
  $('thinktime').textContent=s.ms!=null?dur(s.ms):'';
  const bits=[];
  // Ba tên tool nhiều nhất là đủ để biết lượt đó làm gì; phần còn lại ở tooltip.
  if(s.calls)bits.push(s.calls+(s.calls===1?' call':' calls')
    +(s.names.length?' ('+s.names.slice(0,3).map(n=>n[0]+' '+n[1]).join(', ')+(s.names.length>3?', \u2026':'')+')':''));
  if(tok)bits.push(compact(tok)+' tok');
  if(u.costUsd!=null)bits.push('$'+Number(u.costUsd).toFixed(Number(u.costUsd)<1?3:2));
  const meta=$('thinktokens');if(meta)meta.textContent=bits.length?'\u00b7 '+bits.join(' \u00b7 '):'';
  box.title=(s.ms!=null?'Turn took '+dur(s.ms)+'\n':'')
    +(s.names.length?s.names.map(n=>n[0]+' \u00d7 '+n[1]).join('\n')+'\n':'')
    // `costUsd` là số CLI báo ở cuối lượt, KHÔNG phải phép cộng của Dev Hub.
    +tokenTip(s.usage);
}

/**
 * VS Code giữ state này qua Reload Window và trả lại cho serializer phía host.
 * DOM sống sót khi ẩn tab (retainContextWhenHidden:true) nhưng KHÔNG sống qua Reload
 * Window, nên chữ đang gõ phải nằm ở đây mới quay lại được.
 */
function saveState(){const s=state.session;const d=state.draft;
  const draftText=($('input')&&$('input').value)||'';
  const atts=pending.filter(a=>a.path).map(a=>a.path);
  if(!s&&!d&&!draftText&&!atts.length){vscode.setState(null);return}
  const draft=(!s&&d&&d.workspace&&d.project)
    ?{draft:{workspaceId:d.workspace.id,projectId:d.project.id,provider:d.provider}}:{};
  vscode.setState(Object.assign(s?{provider:s.provider,nativeSessionId:s.nativeSessionId}:draft,
    {model:state.model,effort:state.effort,draftText:draftText,atts:atts}))}
let saveTimer=null;
function saveStateSoon(){if(saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;saveState()},250)}
function restoreDraft(){const st=vscode.getState();if(!st)return;
  if(typeof st.draftText==='string'&&st.draftText){$('input').value=st.draftText;measure();grow()}
  if(Array.isArray(st.atts))for(const p2 of st.atts)
    if(typeof p2==='string')pending.push({path:p2,name:String(p2).split('/').pop()});
  renderAttachments()}
/** Cùng ngưỡng với @media trong chat.css: ở đó composerbar là MỘT hàng chỉ vừa khi effort
 *  còn 3 ký tự. Cắt thẳng chứ không ellipsis — "med"/"hig" vẫn đọc ra, "me\u2026" thì không.
 *  Tên đầy đủ ở tooltip. `matchMedia` chứ không phải innerWidth: panel là iframe, bề rộng
 *  của nó mới là cái CSS đo. */
const NARROW=window.matchMedia?window.matchMedia('(max-width:560px)'):null;
/** `claude-opus-5-5` → `Opus 5.5`. Suy từ id chứ không tra bảng: CLI lên bản mới là nhãn tự đúng.
 *  Mỗi số phiên bản tối đa 2 chữ số để đuôi ngày (`haiku-4-5-20251001`) không thành "4.5.20251001". */
function modelLabel(id){const m=/^claude-([a-z]+)-(\d{1,2}(?:-\d{1,2})*)(?![0-9])/.exec(id||'');
  return m?m[1].charAt(0).toUpperCase()+m[1].slice(1)+' '+m[2].replace(/-/g,'.'):''}
function renderOptions(){const me=$('model'),pick=state.model||'',run=state.session&&state.session.usage&&state.session.usage.model,lab=modelLabel(run);
  // Chỉ thay alias khi id cùng họ: vừa đổi picker sang sonnet thì id vẫn là opus của lượt trước.
  const fam=lab&&(!pick||pick===run||pick===lab.split(' ')[0].toLowerCase());
  me.textContent=fam?lab:(state.model||'auto');me.title=fam?'Model: '+(state.model||'auto')+' \u2192 '+run:'Model';
  const ef=state.effort||'auto',el=$('effort');
  el.textContent=NARROW&&NARROW.matches?ef.slice(0,3):ef;el.title='Thinking effort: '+ef;
  const sl=$('slash');if(sl)sl.hidden=!state.slash}
// Panel co giãn được, và Safari đổi bề rộng khi quay máy: chữ effort phải theo.
if(NARROW){const h=()=>renderOptions();
  if(NARROW.addEventListener)NARROW.addEventListener('change',h);else if(NARROW.addListener)NARROW.addListener(h)}
function ctxTip(tip,u,used,win){const known=used!=null&&!!win;
  tipGauge(tip,'Context window',known?1-Math.max(0,Math.min(1,used/win)):null,known?compact(used)+' / '+compact(win):null);
  let rows=0;const add=(k,v,fmt)=>{if(v==null)return;rows++;const r=el('div','qt-row');r.appendChild(el('span',null,k));r.appendChild(el('b','qt-when',fmt?fmt(v):compact(v)));tip.appendChild(r)};
  add('Input',u.inputTokens);add('Cache read',u.cachedInputTokens);add('Cache write',u.cacheWriteInputTokens);
  add('Output',u.outputTokens);add('Reasoning',u.reasoningOutputTokens);
  add('Cost',u.costUsd,v=>'$'+Number(v).toFixed(4));
  if(!rows)tip.appendChild(el('div','qt-row','No token data yet'));
  tip.appendChild(el('div','qt-foot','Click to compact'))}
function renderContext(){const u=(state.session&&state.session.usage)||{};
  const used=u.contextUsedTokens,win=u.contextWindowTokens;
  // Bảng token bỏ chi tiết vào tooltip vòng context — hàng #usage cũ từng giữ chỗ này.
  // Như vòng quota: card riêng thay `title` (native chậm, chồng lên card); aria-label giữ đủ chữ.
  $('ctxwrap').setAttribute('aria-label','Context left — click to compact\n'+tokenTip(u));
  const tip=$('ctxtip');if(tip)ctxTip(tip,u,used,win);
  renderQuotas();
  // Số token tách khỏi % vì màn hình hẹp chỉ còn chỗ cho %; CSS ẩn nửa sau, tooltip vẫn đủ.
  const tok=$('ctxtokens');
  // Chưa biết thì vòng rỗng — vòng đầy ở đây có nghĩa "còn nguyên context", không phải "chưa rõ".
  if(used==null||!win){$('arc').setAttribute('stroke-dasharray','0 '+CIRC.toFixed(1));$('ctxtext').textContent='—';if(tok)tok.textContent='';return}
  const remain=1-Math.max(0,Math.min(1,used/win));
  $('arc').setAttribute('stroke-dasharray',(remain*CIRC).toFixed(1)+' '+CIRC.toFixed(1));
  $('arc').setAttribute('stroke',ringColor(remain));
  $('ctxtext').textContent=Math.round(remain*100)+'%';
  if(tok)tok.textContent=' · '+compact(used)+'/'+compact(win)}
/**
 * Chip git: cây làm việc BẨN (chưa commit), không phải diff cả branch — con số phải nhúc
 * nhích ngay trong lúc agent sửa file, đó mới là thứ đáng nhìn ở đây. File untracked được
 * đếm vào số file nhưng KHÔNG vào số dòng (`git diff HEAD` không thấy nó); tooltip nói rõ.
 */
function renderScm(){
  const st=state.scm,b=$('branch'),s=$('scm');
  if(!b||!s)return;
  b.hidden=!(st&&st.branch);
  if(st&&st.branch){
    b.textContent='';
    b.appendChild(el('span','scmbranch','\u2387 '+st.branch));
    if(st.ahead)b.appendChild(el('span','scmahead','\u2191'+st.ahead));
    if(st.behind)b.appendChild(el('span','scmbehind','\u2193'+st.behind));
    b.title=st.upstream
      ? st.branch+' \u2192 '+st.upstream+'\n'+st.ahead+' commit(s) to push \u00b7 '+st.behind+' to pull'
      : st.branch+'\nNo upstream \u2014 nothing of this branch is pushed';
  }
  s.hidden=!(st&&st.files);
  if(s.hidden)return;
  s.textContent='';
  s.appendChild(el('span','scmfiles',String(st.files)));
  s.appendChild(el('span','scmadd','+'+st.added));
  s.appendChild(el('span','scmdel','\u2212'+st.removed));
  s.appendChild(scmBar(st.added,st.removed));
  s.title=st.files+' changed file'+(st.files>1?'s':'')+' since HEAD \u00b7 +'+st.added+' \u2212'+st.removed
    +(st.untracked?'\n'+st.untracked+' untracked \u2014 counted as files, lines not counted':'')
    +'\nClick to open one';
}
/** Năm ô như GitHub. Một phía làm tròn xuống 0 ô thì chỉ cứu khi phía kia cũng trống:
 *  378/14 phải ra 4 xanh + 1 xám, ép lên 1 đỏ là mất đúng cái ô xám đó. */
function scmBar(added,removed){
  const total=added+removed;
  let g=total?Math.floor(added/total*5):0,r=total?Math.floor(removed/total*5):0;
  if(added&&!g&&!r)g=1; if(removed&&!r&&!g)r=1;
  const bar=el('span','scmbar');
  for(let i=0;i<5;i++)bar.appendChild(el('span','sq'+(i<g?' add':i<g+r?' del':'')));
  return bar;
}
function renderHeader(){const s=state.session,d=state.draft,p=(s&&s.provider)||(d&&d.provider);
  const pv=$('provider');pv.textContent='';
  if(p){pv.appendChild(mark(p,p==='planner'?18:14));pv.title='Provider: '+providerName(p)+' \u2014 click to change';pv.classList.add('iconly')}
  else{pv.appendChild(el('span',null,'Dev Hub'));pv.classList.remove('iconly');pv.title='Change provider'}
  document.body.setAttribute('data-provider',p||'');
  const ws=state.workspace?state.workspace.name:(d?d.workspace.name:'');const pr=state.project?state.project.name:(d?d.project.name:'');
  $('crumb').textContent=(ws||pr)?(ws+' / '+pr):'\u2014';
  $('status').textContent=s?s.status:(d?'new':'');
  // Chưa có session thì chưa có ID để chép; nháp mới không mang id nào.
  const cid=$('copyid');cid.hidden=!s;if(s)cid.title='Copy session ID\n'+s.nativeSessionId;
  const running=!!s&&s.status==='running';
  // Không disable nữa: gửi trong lúc đang chạy sẽ vào hàng chờ ở host.
  $('send').title=running?'Queue this message (\u23ce)':'Send (\u23ce)';
  if(running)startThinking();else stopThinking();
  // Không có con trỏ thật thì ⏎/⇧⏎ vô nghĩa, mà hint chiếm hai dòng của composer trên điện thoại.
  $('input').placeholder='Ask '+(p?providerName(p):'Claude')+'\u2026'+(TOUCH?'':'  (\u23ce send \u00b7 \u21e7\u23ce newline \u00b7 paste an image)');
  renderOptions();renderContext();renderScm();saveState()}
/** Output dài thì gói trong <details> — tránh cuộn vô tận và tránh dựng nghìn node. */
/**
 * Markdown tối thiểu, dựng bằng createElement nên KHÔNG có bề mặt injection.
 * Chỉ nhận những gì agent thực sự phát: heading, list, fence, bold/italic/code, link.
 */
/**
 * Media agent nhắc bằng đường dẫn tuyệt đối (`![](/tmp/a.gif)`, `` `/x/demo.mp4` ``) vẽ thẳng vào
 * bong bóng. Host đưa gốc URI qua `mediaBase` (panel: asWebviewUri('/'), mobile: `/api/file?f=`);
 * quyền đọc vẫn do host chốt. Đuôi đang stream KHÔNG dựng: nó vẽ lại mỗi delta, video sẽ nạp lại liên tục.
 * Video KHÔNG muted: nó không autoplay (chỉ autoplay mới cần muted), và agent hay đưa audio dưới dạng mp4.
 */
let mediaBase='',noMedia=false;
const MEDIA_RE=/\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i,VIDEO_RE=/\.(mp4|m4v|mov|webm)$/i;
function mediaPath(href){let p=String(href||'').trim();
  if(p.indexOf('file://')===0){try{p=decodeURIComponent(p.slice(7))}catch(e){return ''}}
  return p.charAt(0)==='/'&&p.indexOf('\n')<0&&MEDIA_RE.test(p)?p:''}
function mediaFallback(node,p){const b=el('button','path','\u25B6 '+p);b.dataset.path=p;if(node.parentNode)node.parentNode.replaceChild(b,node)}
function addMedia(parent,href,alt){if(noMedia||!mediaBase)return false;const p=mediaPath(href);if(!p)return false;
  const src=mediaBase+p.split('/').map(encodeURIComponent).join('/');let n;
  if(VIDEO_RE.test(p)){n=document.createElement('video');n.controls=true;n.loop=true;n.setAttribute('playsinline','');n.preload='metadata'}
  else{n=document.createElement('img');n.alt=alt||p.split('/').pop();n.loading='lazy';n.title=p;
    n.addEventListener('click',()=>vscode.postMessage({type:'openFile',path:p}))}
  // File không còn, nằm ngoài gốc host mở, hoặc Electron của VS Code thiếu codec (H.264 trong
  // .mp4/.mov): một nút mở file còn hơn ô đen câm.
  n.addEventListener('error',()=>mediaFallback(n,p));
  n.className='assistant-image';n.src=src;parent.appendChild(n);return true}
function inline(parent,text){
  const re=/(\\[\\`*_~\[\]()#+\-.!])|(\*\*\*[^*]+\*\*\*|___[^_]+___)|(\*\*[^*]+\*\*|__[^_]+__)|(~~[^~]+~~)|(`+[^`]+`+)|(\*[^*\n]+\*|_[^_\n]+_(?![A-Za-z0-9]))|(!?\[[^\]]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let last=0,m;
  while((m=re.exec(text))){
    // `snake_case_word` không phải italic. Điều kiện này từng viết bằng lookbehind, mà WebKit
    // chỉ có lookbehind từ Safari 16.4 — một literal như thế là SyntaxError, chết cả script
    // (webview trên iPhone/iPad chạy engine của iOS). Lùi lastIndex 1 ký tự để cặp `_` sau vẫn
    // có cơ hội khớp, đúng như engine làm khi lookbehind fail.
    if(m[6]&&m[0].charAt(0)==='_'&&/[A-Za-z0-9]/.test(text.charAt(m.index-1))){re.lastIndex=m.index+1;continue}
    if(m.index>last)parent.appendChild(document.createTextNode(text.slice(last,m.index)));
    const tk=m[0];
    if(m[1])parent.appendChild(document.createTextNode(tk.slice(1)));                 // \* -> *
    else if(m[2]){const st=el('strong');st.appendChild(el('em',null,tk.slice(3,-3)));parent.appendChild(st)}
    else if(m[3])parent.appendChild(el('strong',null,tk.slice(2,-2)));
    else if(m[4])parent.appendChild(el('s',null,tk.slice(2,-2)));
    else if(m[5]){const n=tk.length-tk.replace(/^\u0060+/,'').length;parent.appendChild(el('code',null,tk.slice(n,-n)));addMedia(parent,tk.slice(n,-n))}
    else if(m[6])parent.appendChild(el('em',null,tk.slice(1,-1)));
    else if(m[7]){const img=tk[0]==='!';const t=img?tk.slice(1):tk;const k=t.indexOf(']');
      const label=t.slice(1,k)||t.slice(k+2,-1);const href=t.slice(k+2,-1);
      if(!(img&&addMedia(parent,href,t.slice(1,k)))){const a=el('a',null,(img?'\u{1F5BC} ':'')+label);a.dataset.href=href;a.title=href;parent.appendChild(a);if(!img)addMedia(parent,href,label)}}
    else{const a=el('a',null,tk);a.dataset.href=tk;a.title=tk;parent.appendChild(a)}
    last=m.index+tk.length;
  }
  if(last<text.length)parent.appendChild(document.createTextNode(text.slice(last)));
}
function isTableSep(l){return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l)&&l.indexOf('-')>=0}
function cells(l){return l.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(c=>c.trim())}
function markdown(parent,src){
  const lines=String(src==null?'':src).split('\n');
  let i=0;
  const stack=[];                        // [{node,ordered,indent}] cho list lồng nhau
  const flush=()=>{stack.length=0};
  while(i<lines.length){
    const line=lines[i];

    const fence=/^\s*(?:\u0060{3,}|~{3,})(\w*)\s*$/.exec(line);
    if(fence){flush();const buf=[];const close=line.trim()[0];i++;
      while(i<lines.length&&!(lines[i].trim()[0]===close&&/^\s*(?:\u0060{3,}|~{3,})\s*$/.test(lines[i])))buf.push(lines[i++]);
      i++;const pre=el('pre','mono',buf.join('\n'));if(fence[1])pre.dataset.lang=fence[1];parent.appendChild(pre);continue}

    if(/^\s*(?:[-*_]\s*){3,}$/.test(line)&&!(i>0&&lines[i-1].indexOf('|')>=0)){flush();parent.appendChild(el('hr','md-hr'));i++;continue}

    const bq=/^\s*>\s?(.*)$/.exec(line);
    if(bq){flush();const box=el('blockquote','md-quote');const buf=[bq[1]];i++;
      while(i<lines.length&&/^\s*>\s?/.test(lines[i])){buf.push(lines[i].replace(/^\s*>\s?/,''));i++}
      markdown(box,buf.join('\n'));parent.appendChild(box);continue}

    const h=/^(#{1,6})\s+(.*)$/.exec(line);
    if(h){flush();const el2=el('div','md-h'+Math.min(h[1].length,4));inline(el2,h[2]);parent.appendChild(el2);i++;continue}

    if(line.indexOf('|')>=0&&i+1<lines.length&&isTableSep(lines[i+1])){
      flush();const head=cells(line);i+=2;
      const tbl=el('table','md-table');const thead=el('thead');const hr=el('tr');
      for(const c of head){const th=el('th');inline(th,c);hr.appendChild(th)}
      thead.appendChild(hr);tbl.appendChild(thead);const tb=el('tbody');
      while(i<lines.length&&lines[i].indexOf('|')>=0&&lines[i].trim()){
        const tr=el('tr');for(const c of cells(lines[i])){const td=el('td');inline(td,c);tr.appendChild(td)}
        tb.appendChild(tr);i++}
      tbl.appendChild(tb);parent.appendChild(tbl);continue}

    const li=/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if(li){
      const indent=li[1].replace(/\t/g,'  ').length, ordered=!li[2];
      while(stack.length&&stack[stack.length-1].indent>indent)stack.pop();
      let top=stack[stack.length-1];
      if(!top||top.indent<indent||top.ordered!==ordered){
        const node=el(ordered?'ol':'ul','md-list');
        (top&&top.indent<indent?top.node.lastChild||top.node:parent).appendChild(node);
        top={node,ordered,indent};stack.push(top);
      }
      const item=el('li');
      const task=/^\[([ xX])\]\s+(.*)$/.exec(li[4]);
      if(task){item.className='md-task';
        item.appendChild(el('span','md-box',task[1]===' '?'\u2610':'\u2611'));
        const sp=el('span');inline(sp,task[2]);item.appendChild(sp)}
      else inline(item,li[4]);
      top.node.appendChild(item);i++;continue}

    if(!line.trim()){flush();i++;continue}

    // Gộp các dòng liền kề thành MỘT đoạn, đúng cách markdown hoạt động.
    flush();const buf=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(\s*(?:[-*+]|\d+[.)])\s|#{1,6}\s|\s*>|\s*(?:\u0060{3,}|~{3,}))/.test(lines[i])
          &&!(lines[i].indexOf('|')>=0&&i+1<lines.length&&isTableSep(lines[i+1])))buf.push(lines[i++]);
    const para=el('div','md-p');inline(para,buf.join(' '));parent.appendChild(para);
  }
}
function body(parent,text,mono,maxLines){const t=String(text==null?'':text);const lines=t.split('\n');
  const cls=mono?'mono':'';
  if(lines.length<=(maxLines||20)){parent.appendChild(el('pre',cls,t));return}
  const n=maxLines||20;
  const det=document.createElement('details');
  const sum=document.createElement('summary');
  sum.appendChild(el('pre',cls+' peek',lines.slice(0,n).join('\n')));
  sum.appendChild(el('span','morecount','+'+(lines.length-n)+' lines'));
  det.appendChild(sum);det.appendChild(el('pre',cls+' full',t));
  parent.appendChild(det)}
/** Claude Code chỉ in MỘT dòng cho tool call rồi gập output. Bám đúng kiểu đó. */
function oneLine(text,max){const t=String(text==null?'':text).replace(/\s+/g,' ').trim();
  return t.length>max?t.slice(0,max-1)+'\u2026':t}
function toolRow(parent,name,arg,output,exitCode){
  const full=String(arg==null?'':arg);
  const short=oneLine(full,110);
  const head=el('div','trow');
  head.appendChild(el('span','tname',name));
  // Rỗng = block_start vừa tới, tham số còn đang stream ra.
  head.appendChild(el('span','targ','('+(short||'\u2026')+')'));
  // Heredoc nhiều KB bị `oneLine` ép về 110 ký tự; không bung được thì thân script mất hẳn
  // khỏi UI, kể cả khi mở lại transcript.
  if(full.trim()&&full.trim()!==short){
    const cdet=document.createElement('details');
    const csum=document.createElement('summary');csum.appendChild(head);
    cdet.appendChild(csum);cdet.appendChild(el('pre','mono full',full));
    parent.appendChild(cdet);
  } else parent.appendChild(head);
  const out=String(output==null?'':output).replace(/\s+$/,'');
  if(!out&&exitCode==null)return;
  const lines=out?out.split('\n'):[];
  const det=document.createElement('details');
  const sum=document.createElement('summary');
  sum.appendChild(el('span','tout',lines.length?oneLine(lines[0],110):'exit '+exitCode));
  if(lines.length>1)sum.appendChild(el('span','morecount','+'+(lines.length-1)+' lines'));
  // Badge exit PHẢI độc lập với số dòng: lệnh fail kèm 20 dòng stderr trước đây chỉ hiện
  // "+19 lines", nhìn y hệt lệnh chạy ngon.
  if(exitCode!=null&&exitCode!==0)sum.appendChild(el('span','morecount bad','exit '+exitCode));
  det.appendChild(sum);
  det.appendChild(el('pre','mono full',out||('exit '+exitCode)));
  parent.appendChild(det);
}
/**
 * Một tool call = MỘT dòng. `*_started` dựng dòng, `*_completed` ghi lại đúng dòng đó.
 * Không có callId (transcript cũ) thì khớp tạm bằng tên/command.
 */
let pendingRows=new Map();
function callKey(e){
  if(e.callId)return 'id:'+e.callId;
  if(e.type==='command_started'||e.type==='command_completed')return 'cmd:'+String(e.command||'');
  return 'tool:'+String(e.tool||'')+'\u0000'+String(e.label||'');
}

/** Chỉ tự cuộn khi người dùng đang ở cuối; đang đọc phía trên thì đừng giật xuống. */
/**
 * Dính đáy. Đọc scrollHeight ngay sau khi sửa DOM là ép browser tính lại layout; làm thế
 * mỗi event thì 1000 event = 1000 lần layout (đo trong Chrome: 1001 layout / ~520ms).
 * Nên trạng thái "đang ở đáy" lấy từ event `scroll` của chính người dùng, và việc cuộn
 * gộp về một lần mỗi frame. Tin của chính mình thì cuộn ngay, không chờ frame.
 */
let stuckToBottom=true,scrollQueued=false;
function noteScroll(m){stuckToBottom=m.scrollHeight-m.scrollTop-m.clientHeight<40}
function autoscroll(m,force){
  if(force){stuckToBottom=true;m.scrollTop=m.scrollHeight;return}
  if(!stuckToBottom||scrollQueued)return;
  scrollQueued=true;
  requestAnimationFrame(()=>{scrollQueued=false;m.scrollTop=m.scrollHeight});
}
/** Fence mở mà chưa đóng: dòng trắng bên trong code block KHÔNG phải ranh giới khối. */
function openFence(s){const f=s.match(/^\s*(?:\u0060{3,}|~{3,})/gm);return !!f&&f.length%2===1}
/**
 * Vừa stream vừa render markdown, thay vì dán text thô rồi format một cục ở turn_done —
 * đang chạy thì người đọc thấy `**bold**`, backtick và bảng ở dạng nguồn.
 * Phần trước dấu ngắt khối cuối cùng đã chốt nên chỉ vẽ MỘT lần vào .stream-done; chỉ khối
 * đang gõ mới vẽ lại mỗi delta, nên chi phí theo độ dài một khối chứ không theo cả tin nhắn.
 */
function streamInto(d,text){
  d._raw=(d._raw||'')+text;
  let head=d._head||0;
  const cut=d._raw.lastIndexOf('\n\n');
  if(cut>head&&!openFence(d._raw.slice(0,cut))){
    const frag=document.createDocumentFragment();
    markdown(frag,d._raw.slice(head,cut));
    d.querySelector('.stream-done').appendChild(frag);
    head=d._head=cut+2;
  }
  const rest=d._raw.slice(head),inFence=openFence(rest);
  // Code block chưa đóng là khối DUY NHẤT có thể dài vô hạn (một file, một diff) mà không
  // có dòng trắng để chốt. Thân fence là verbatim nên chỉ cần nối chữ, khỏi parse lại cả khối.
  if(inFence&&d._pre){d._pre.textContent+=text;return}
  const tail=d.querySelector('.stream-tail');
  tail.textContent='';noMedia=true;try{markdown(tail,rest)}finally{noMedia=false}
  d._pre=inFence?tail.lastElementChild:null;
}
/**
 * into = DocumentFragment khi dựng cả transcript: node chưa nằm trong document nên
 * không sinh layout, và KHÔNG đọc scrollHeight sau từng event (đó là chỗ ép reflow
 * liên tục khi mở transcript dài).
 */
function addEvent(e,into){const m=$('messages');const host=into||m;
  const blank=host.querySelector('.empty');if(blank)host.removeChild(blank);
  if(e.type==='turn_done'){const last=host.lastElementChild;
    if(last&&last.classList.contains('assistant-streaming')){
      // Vẽ lại một lượt từ text gốc: DOM cuối cùng phải y hệt lúc mở lại transcript.
      const raw=last._raw||'';
      last.textContent='';markdown(last,raw);last.classList.remove('assistant-streaming')}
    return}
  if(e.type==='usage'){if(state.session){state.session.usage=Object.assign({},state.session.usage||{},e.usage);renderHeader()}return}
  // View frame là TOÀN BỘ phần đã sinh (planner sửa message tại chỗ), nên vẽ lại từ đầu
  // vào ĐÚNG bong bóng đang stream — nối thêm sẽ ra ba bản của cùng một câu.
  if(e.type==='assistant_view'){const last=host.lastElementChild;
    const d0=(last&&last.classList.contains('assistant-streaming'))?last:host.appendChild(el('div','msg assistant assistant-streaming'));
    d0._raw=String(e.text||'');d0._head=0;d0._pre=null;
    d0.textContent='';markdown(d0,d0._raw);
    if(!into)autoscroll(m);return}
  if(e.type==='assistant_delta'){const last=host.lastElementChild;
    if(last&&last.classList.contains('assistant-streaming')){streamInto(last,e.text);if(!into)autoscroll(m);return}
    const d=el('div','msg assistant assistant-streaming');
    d.appendChild(el('div','stream-done'));d.appendChild(el('div','stream-tail'));
    streamInto(d,e.text);host.appendChild(d);if(!into)autoscroll(m);return}
  const d=document.createElement('div');let cls='msg ',label='';
  if(e.type==='user_message'){cls+='user';
    if(e.text)body(d,e.text,false);
    // imageSrcs do host dựng (webview URI); e.images là đường dẫn thật, chỉ dùng làm alt.
    const srcs=e.imageSrcs||[];
    if(srcs.length){const row=el('div','uimgs');
      srcs.forEach((src,i)=>{const im=document.createElement('img');im.className='uimg';im.src=src;
        im.alt=String((e.images&&e.images[i])||'image').split('/').pop();im.loading='lazy';row.appendChild(im)});
      d.appendChild(row)}}
  else if(e.type==='assistant_message'){cls+='assistant';markdown(d,e.text)}
  else if(e.type==='assistant_image'){
    cls+='assistant';
    // Không có src = host không đổi được đường dẫn thành webview URI. Một dòng chữ còn hơn
    // một ô ảnh vỡ không nói được gì.
    if(!e.src){body(d,'[image: '+(e.alt||'generated')+']',false)}
    else{const img=document.createElement('img');img.className='assistant-image';img.alt=e.alt||'Generated image';img.src=e.src;img.loading='lazy';d.appendChild(img);}
  }
  else if(e.type==='tool_started'||e.type==='tool_completed'||e.type==='command_started'||e.type==='command_completed'){
    const isCmd=e.type.indexOf('command')===0;
    const key=callKey(e);
    const done=e.type.slice(-9)==='completed';
    // Ghi đè một `*_started` cũ chỉ an toàn khi có callId. Không có id thì `key` là tên+nhãn,
    // và hai lần gọi giống hệt nhau trong một lượt sẽ gộp mất một dòng.
    const row=(done||e.callId)?pendingRows.get(key):undefined;
    // Dòng đã bị prune khỏi DOM thì ghi vào nó là mất tin — chèn dòng mới.
    // `*_started` cũng có thể tới hai lần: một lần rỗng ở `content_block_start`, một lần đủ
    // tham số ở `assistant`. Lần sau ghi đè lần trước, không dựng dòng thứ hai.
    if(row&&row.parentNode){if(done)pendingRows.delete(key);row.textContent='';
      if(isCmd)toolRow(row,'Bash',e.command,e.output,e.exitCode);else toolRow(row,e.tool||'Tool',e.label||'',e.summary,null);
      if(!into)autoscroll(m);return}
    cls+=isCmd?'command':'tool';label='';
    if(isCmd)toolRow(d,'Bash',e.command,e.output,e.exitCode);else toolRow(d,e.tool||'Tool',e.label||'',e.summary,null);
    if(e.type.slice(-7)==='started')pendingRows.set(key,d);
  }
  else if(e.type==='file_changed'){cls+='file';label='File '+e.change;const b=el('button','path',e.path);b.dataset.path=e.path;d.appendChild(b)}
  else if(e.type==='warning'){cls+='warning';label='Warning';body(d,e.message,false)}
  else if(e.type==='error'){cls+='error';label='Error';body(d,e.message,false)}
  else return;
  d.className=cls;if(label)d.insertBefore(el('div','meta',label),d.firstChild);host.appendChild(d);
  if(into)return;
  while(m.children.length>1500)m.removeChild(m.firstElementChild);
  // Tin nhắn của CHÍNH mình thì luôn nhảy xuống — nếu không, gửi lúc đang cuộn lên đọc
  // thì nó nằm dưới màn hình và trông như mất tin.
  autoscroll(m,e.type==='user_message')}
function renderAll(){const m=$('messages');m.textContent='';pendingRows=new Map();
  if(!state.events||!state.events.length)m.appendChild(el('div','empty','No messages yet.'));
  else{const frag=document.createDocumentFragment();
    // Chỉ trang mobile gửi `older` (nó chỉ nhận đuôi transcript); panel không bao giờ thấy nút này.
    if(state.older>0){const b=el('button','chip older','Load '+Math.min(state.older,200)+' earlier ('+state.older+' hidden)');
      b.addEventListener('click',()=>{b.disabled=true;vscode.postMessage({type:'loadOlder'})});frag.appendChild(b)}
    for(const e of state.events)addEvent(e,frag);
    m.appendChild(frag);
    while(m.children.length>1500)m.removeChild(m.firstElementChild);
    m.scrollTop=m.scrollHeight}
  renderHeader()}
window.addEventListener('message',ev=>{const x=ev.data;
  // Tới sau transcript (panel cũ, hoặc trang mobile tải trước khi server có nó): vẽ lại cho media hiện.
  if(x.type==='mediaBase'){const b=String(x.base||'');if(b!==mediaBase){mediaBase=b;if(state.events.length)renderAll()}return}
  if(x.type==='sessionSelected'){const m=$('messages'),fromEnd=x.keepScroll?m.scrollHeight-m.scrollTop:0;
    state={session:x.session,draft:null,events:x.events||[],older:x.older||0,workspace:x.workspace,project:x.project,model:state.model,effort:state.effort,scm:state.scm};renderAll();
    // Tải thêm phía trên: giữ nguyên chỗ đang đọc thay vì nhảy xuống đáy như lúc mở session.
    if(x.keepScroll)m.scrollTop=m.scrollHeight-fromEnd}
  else if(x.type==='draftSelected'){state={session:null,draft:x.draft,events:[],workspace:x.draft.workspace,project:x.draft.project,model:state.model,effort:state.effort,scm:state.scm};renderAll()}
  else if(x.type==='sessionUpdated'){state.session=x.session;renderHeader()}
  else if(x.type==='event'){
    // Không remember: chỉ báo nhất thời, mở lại transcript không được thấy nó.
    if(x.event.type==='thinking'){setThinkTokens(x.event.tokens);return}
    if(x.event.type==='user_message')reanchorThinking(x.event.timestamp);
    remember(x.event);addEvent(x.event);renderHeader()}
  else if(x.type==='eventBatch'){const items=x.items||[];for(const i of items){if(state.session&&i.sessionId===state.session.nativeSessionId){remember(i.event);addEvent(i.event)}}renderHeader()}
  else if(x.type==='optionsChanged'){state.model=x.model;state.effort=x.effort;state.slash=!!x.slash;renderOptions();renderHeader()}
  else if(x.type==='insertText'){const t=$('input');t.value=x.text+t.value.replace(/^\/\s*/,'');measure();grow();t.focus();
    t.setSelectionRange(t.value.length,t.value.length)}
  else if(x.type==='permission'){addPermission(x.request)}
  else if(x.type==='permissionClosed'){closePermission(x.requestId,x.note)}
  else if(x.type==='attachmentError'){attachmentError(x.requestId,x.message)}
  else if(x.type==='attachment'){addAttachment(x.path,x.requestId)}
  else if(x.type==='queue'){queued=Array.isArray(x.items)?x.items:[];renderQueue();return}
  else if(x.type==='empty'){state={session:null,draft:null,events:[],workspace:null,project:null,model:state.model,effort:state.effort,scm:null};renderAll()}
  else if(x.type==='scm'){state.scm=x.status||null;renderScm()}
  else if(x.type==='error'){showError(x.message)}});
/** CLI đang chờ: không trả lời thì nó treo. Nút bấm xong khoá thẻ lại để khỏi bấm hai lần. */
/** AskUserQuestion đi qua cùng kênh permission nhưng cần UI riêng: câu hỏi + nút chọn. */
function addQuestion(req,parent){
  const qs=(req.input&&req.input.questions)||[];
  if(!qs.length)return false;
  const picked={};
  parent.appendChild(el('div','ptitle','Claude is asking'));
  qs.forEach((q,qi)=>{
    const box=el('div','qbox');
    box.appendChild(el('div','qtext',q.question||('Question '+(qi+1))));
    const opts=el('div','qopts');
    (q.options||[]).forEach(o=>{
      const b=el('button','qopt');
      b.appendChild(el('span','qlabel',o.label||''));
      if(o.description)b.appendChild(el('span','qdesc',o.description));
      b.onclick=()=>{
        picked[q.question]=o.label;
        for(const sib of opts.children)sib.classList.remove('sel');
        b.classList.add('sel');
        // Trả lời ngay khi mọi câu đã chọn — không bắt bấm thêm nút xác nhận.
        if(qs.every(x=>picked[x.question]!==undefined)){
          vscode.postMessage({type:'permissionResponse',requestId:req.requestId,allow:true,answers:picked});
          parent.classList.add('answered');
          parent.appendChild(el('div','meta',Object.values(picked).join(' · ')));
        }
      };
      opts.appendChild(b);
    });
    box.appendChild(opts);
    parent.appendChild(box);
  });
  const skip=el('button','deny','Skip');
  skip.onclick=()=>{vscode.postMessage({type:'permissionResponse',requestId:req.requestId,allow:false});
    parent.classList.add('answered');parent.appendChild(el('div','meta','skipped'))};
  const acts=el('div','pacts');acts.appendChild(skip);parent.appendChild(acts);
  return true;
}
function addPermission(req){const m=$('messages');const blank=m.querySelector('.empty');if(blank)m.removeChild(blank);
  // Host gửi lại các request còn treo sau mỗi lần render lại; đừng vẽ thành hai thẻ.
  for(const c of m.children)if(c.dataset&&c.dataset.req===String(req.requestId))return;
  const d=el('div','perm');d.dataset.req=req.requestId;
  if(req.toolName==='AskUserQuestion'&&addQuestion(req,d)){m.appendChild(d);m.scrollTop=m.scrollHeight;return}
  d.appendChild(el('div','ptitle',(req.displayName||req.toolName)+' wants to run'));
  if(req.description)d.appendChild(el('div',null,req.description));
  const inp=req.input||{};
  const shown=typeof inp.command==='string'?inp.command:JSON.stringify(inp,null,1);
  d.appendChild(el('pre',null,String(shown).slice(0,4000)));
  // CLI coi thẻ riêng của tool là chỗ trả lời; allow một-nhịp ở đây có thể bị nó đổi thành deny.
  if(req.requiresUserInteraction)d.appendChild(el('div','phint','This tool wants to be answered on its own card — Allow may be refused.'));
  const acts=el('div','pacts');
  const allow=el('button','allow','Allow');const deny=el('button','deny','Deny');
  const answer=v=>{vscode.postMessage({type:'permissionResponse',requestId:req.requestId,allow:v});
    d.classList.add('answered');d.appendChild(el('div','meta',v?'allowed':'denied'))};
  allow.onclick=()=>answer(true);deny.onclick=()=>answer(false);
  acts.appendChild(allow);acts.appendChild(deny);d.appendChild(acts);
  m.appendChild(d);m.scrollTop=m.scrollHeight}
/** Host báo không còn ai chờ request này (lượt kết thúc / hết hạn). Khoá thẻ kèm lý do,
 *  không thì thẻ trông vẫn bấm được mà bấm xong chẳng có gì xảy ra. */
function closePermission(requestId,note){const m=$('messages');
  for(const c of m.children)if(c.dataset&&c.dataset.req===String(requestId)){
    if(c.classList.contains('answered'))return;
    c.classList.add('answered');c.appendChild(el('div','meta',note||'no longer waiting'));return}}
const pending=[];
let queued=[];
/** Chỉ vẽ lại từ danh sách host gửi — webview không tự thêm/bớt phần tử nào. */
function renderQueue(){const box=$('queue');if(!box)return;box.textContent='';
  queued.forEach((q,i)=>{const row=el('div','qitem');
    const text=q&&typeof q==='object'?String(q.text||''):String(q||'');
    const n=q&&typeof q==='object'?(q.images||0):0;
    // Tin chỉ có ảnh thì text rỗng — không ghi gì thì hàng chờ hiện ra một dòng trắng.
    const shown=text||(n?n+' ảnh':'(trống)');
    row.appendChild(el('span','qn',(i+1)+'.'));
    if(n&&text)row.appendChild(el('span','qn','\u{1F4CE}'+n));
    const t=el('span','qtext',shown);t.title=shown;row.appendChild(t);
    const x=el('button',null,'\u00d7');x.title='Remove from queue';
    x.onclick=()=>vscode.postMessage({type:'dequeue',index:i});
    row.appendChild(x);box.appendChild(row)})}
function renderAttachments(){const box=$('attachments');box.textContent='';
  pending.forEach((a,i)=>{const chip=el('span','att');
    if(a.thumb){const img=document.createElement('img');img.src=a.thumb;img.className='thumb';chip.appendChild(img)}
    chip.appendChild(el('span',null,a.name));
    if(a.dim)chip.appendChild(el('span','attdim',a.dim));
    // Bấm vào chip mở ảnh trong editor. a.path chỉ có sau khi host lưu xong, nên
    // trước đó chip chưa bấm được — bấm sớm sẽ gửi path undefined.
    if(a.path){chip.classList.add('open');chip.title='Open '+a.path;
      chip.onclick=(ev)=>{if(ev&&ev.target&&ev.target.className==='attx')return;
        vscode.postMessage({type:'openFile',path:a.path})}}
    const x=el('button','attx','\u00d7');x.title='Remove';
    x.onclick=()=>{pending.splice(i,1);renderAttachments();saveState()};
    chip.appendChild(x);box.appendChild(chip)})}
function addAttachment(p,requestId){const name=String(p).split('/').pop();
  const slot=requestId?pending.find(a=>a.requestId===requestId):pending.find(a=>!a.path);
  if(requestId&&!slot)return;
  if(slot){slot.path=p;slot.name=name}else pending.push({path:p,name});
  renderAttachments();saveState();$('input').focus()}
$('messages').addEventListener('scroll',()=>noteScroll($('messages')));
$('messages').addEventListener('click',e=>{
  const b=e.target.closest('button.path');if(b){vscode.postMessage({type:'openFile',path:b.dataset.path});return}
  const a=e.target.closest('a[data-href]');if(a)vscode.postMessage({type:'openLink',href:a.dataset.href})});
on('provider','click',()=>vscode.postMessage({type:'pickProvider'}));
on('crumb','click',()=>vscode.postMessage({type:'pickProject'}));
on('scm','click',()=>vscode.postMessage({type:'pickChanged'}));
on('copyid','click',()=>vscode.postMessage({type:'copySessionId'}));
on('history','click',()=>vscode.postMessage({type:'pickHistory'}));
on('newtab','click',()=>vscode.postMessage({type:'newTab'}));
on('slash','click',()=>vscode.postMessage({type:'pickSlash'}));
on('ctxwrap','click',()=>vscode.postMessage({type:'compact'}));
// Màn cảm ứng không có hover: chạm để bật/tắt card quota, mở cái này thì đóng cái kia.
['q5','q7','cache'].forEach(k=>on(k+'wrap','click',()=>{['q5','q7','cache'].forEach(o=>{const x=$(o+'wrap');if(x&&o!==k)x.classList.remove('open')});
  $(k+'wrap').classList.toggle('open')}));
on('model','click',()=>vscode.postMessage({type:'pickModel'}));
on('effort','click',()=>vscode.postMessage({type:'pickEffort'}));
on('send','click',()=>send());
on('cancel','click',()=>vscode.postMessage({type:'cancel'}));
/**
 * iOS KHÔNG co layout viewport khi bàn phím mở — `100dvh`/`innerHeight` vẫn là cả màn hình,
 * nên composer nằm dưới bàn phím. visualViewport là chỗ duy nhất thấy được vùng còn nhìn thấy.
 * Chỉ ghi đè khi nó thực sự nhỏ hơn (tức có bàn phím/thanh công cụ che); desktop giữ nguyên.
 */
// Panel nằm trong iframe cross-origin; không có gì bảo đảm visualViewport của nó báo con số
// có nghĩa. Dưới ngưỡng này thì coi là rác — thà giữ 100dvh còn hơn ghi height:0 rồi panel trắng.
const MIN_VIEW_H=180;
/** Bàn phím chỉ mở được khi có ô nhập đang focus. Không có thì con số nhỏ của visualViewport
 *  là rác — iOS bắn `scroll` với chiều cao cũ SAU khi bàn phím đóng, và giữ nó lại thì cả app
 *  kẹt trong một dải ở đỉnh màn hình, composer treo lửng giữa trang. */
function editing(){const a=document.activeElement;
  return !!a&&(a.tagName==='TEXTAREA'||a.tagName==='INPUT'||a.isContentEditable)}
function keyboardH(){const v=window.visualViewport;
  if(!v||!editing())return 0;
  const h=Math.round(v.height||0);
  return h>=MIN_VIEW_H&&h<window.innerHeight-40?h:0}
function viewH(){return keyboardH()||window.innerHeight}
function syncViewport(){if(!window.visualViewport)return;
  const h=keyboardH();
  document.body.dataset.keyboard=h?'open':'';
  if(h)document.body.style.setProperty('height',h+'px');
  else document.body.style.removeProperty('height');
  grow();
}
if(window.visualViewport){window.visualViewport.addEventListener('resize',syncViewport);
  window.visualViewport.addEventListener('scroll',syncViewport)}
// Mất focus là bàn phím đóng; iOS không chắc bắn thêm `resize` nào nữa nên phải tự bỏ đè.
document.addEventListener('focusout',()=>setTimeout(syncViewport,0));
window.addEventListener('orientationchange',()=>setTimeout(syncViewport,120));
/** Chiều cao nội dung của ô nhập, đo bằng cách kẹp về 0 rồi đọc `scrollHeight`.
 *  KHÔNG đo bằng `height:auto`: `auto` của textarea là `rows="3"`, tức 73px kể cả khi ô rỗng —
 *  `grow()` cũ vì thế nới ô đang 34px lên 73px. Đo một lần khi giá trị đổi, không đo trong
 *  `syncViewport`: iOS bắn resize/scroll liên tục lúc bàn phím trồi lên, và đổi hình học của
 *  chính element đang focus giữa animation thì WebKit hủy present (tap 1 không lên, tap 2 mới
 *  lên vì lúc đó ô đã ở đúng cỡ nên không còn ghi gì). */
let contentH=0,lastH='';
function measure(){const t=$('input'),keep=t.style.height;
  t.style.height='0px';contentH=t.scrollHeight;t.style.height=keep}
function grow(){const t=$('input');
  if(!contentH)measure();
  const px=Math.min(contentH,Math.round(viewH()*0.4))+'px';
  // So với giá trị ĐÃ ghi, không so với offsetHeight: min-height kẹp lại nên hai số có thể
  // lệch nhau mãi mãi và ta ghi lại mỗi event. Mỗi lần ghi là một relayout ô đang focus.
  if(px!==lastH){lastH=px;t.style.height=px}}
$('input').addEventListener('input',()=>{measure();grow();saveStateSoon();
  // "/" là ký tự đầu tiên -> mở picker của host (QuickPick đã có sẵn filter).
  if($('input').value==='/')vscode.postMessage({type:'pickSlash'})});
$('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
// VS Code (Electron) chặn Cmd+C trong webview, nhờ workbench copy hộ, mà workbench chỉ làm khi
// còn coi webview là đang focus. Tự copy trong frame để khỏi phụ thuộc vào đó.
document.addEventListener('keydown',e=>{
  if(!(e.metaKey||e.ctrlKey)||e.shiftKey||e.altKey||e.keyCode!==67)return;
  const s=window.getSelection();if(!s||s.isCollapsed||!String(s))return;
  try{document.execCommand('copy')}catch(_){}},true);
/** Host chỉ nhận 4 mime này (webviewProtocol); loại khác bị bỏ IM LẶNG nếu không chặn ở đây. */
const IMG_MIME={'image/png':1,'image/jpeg':1,'image/gif':1,'image/webp':1};
let attachmentSeq=0;
/** Lỗi cũng là bản ghi: `remember` để đổi tab hay vẽ lại vẫn còn thấy nó. */
function showError(message){const e={type:'error',message:String(message||'')};remember(e);addEvent(e)}
function attachmentError(requestId,message){const i=pending.findIndex(a=>a.requestId===requestId);
  if(i<0)return;
  pending.splice(i,1);renderAttachments();saveState();
  showError(message||'Không lưu được ảnh. Hãy chọn lại ảnh.');
}
function attachImage(f){
  if(!f)return false;
  if(!IMG_MIME[f.type]){showError('Không gửi được '+(f.type||'file này')+' — chỉ nhận PNG, JPEG, GIF, WebP.');return false}
  if(f.size>9*1024*1024){showError('Ảnh quá lớn — tối đa 9 MiB mỗi ảnh.');return false}
  const item={requestId:String(++attachmentSeq),name:f.name||'image.png'};
  pending.push(item);renderAttachments();
  const fail=()=>attachmentError(item.requestId,'Không đọc được ảnh. Hãy chọn lại ảnh.');
  const r=new FileReader();r.onerror=fail;r.onabort=fail;
  r.onload=()=>{if(!pending.includes(item))return;
    const s=String(r.result),i=s.indexOf(',');if(i<0){fail();return}
    if(s.length-i-1>12*1024*1024){attachmentError(item.requestId,'Ảnh quá lớn — tối đa 9 MiB mỗi ảnh.');return}
    item.thumb=s;renderAttachments();
    const probe=new Image();probe.onload=()=>{item.dim=probe.naturalWidth+'\u00d7'+probe.naturalHeight;renderAttachments()};probe.src=s;
    vscode.postMessage({type:'pasteImage',requestId:item.requestId,mime:f.type,data:s.slice(i+1)})};
  try{r.readAsDataURL(f)}catch{fail();return false}return true;
}
$('input').addEventListener('paste',e=>{const items=(e.clipboardData&&e.clipboardData.items)||[];
  for(const it of items){if(it.kind==='file'&&it.type.indexOf('image/')===0){const f=it.getAsFile();if(!f)continue;
    e.preventDefault();attachImage(f);return}}});
// iOS không phát `paste` kèm file — file input là đường DUY NHẤT gắn ảnh trên điện thoại.
on('attach','click',()=>$('file').click());
on('file','change',()=>{const inp=$('file');const files=inp.files||[];
  for(const f of files)attachImage(f);
  inp.value='';});
function send(){const t=$('input');const typed=t.value.trim();
  if(pending.some(a=>!a.path)){showError('Ảnh đang được lưu. Đợi một chút rồi gửi lại.');return}
  const paths=pending.filter(a=>a.path).map(a=>a.path);
  if(!typed&&!paths.length)return; if($('send').disabled)return;
  // Ảnh đi thành trường riêng; host mới nối vào prompt.
  vscode.postMessage(paths.length?{type:'sendPrompt',text:typed,attachments:paths}:{type:'sendPrompt',text:typed});
  t.value='';pending.length=0;renderAttachments();measure();grow();saveState()}
restoreDraft();
// Ô rỗng phải nghỉ ở ĐÚNG cỡ mà grow() sẽ tính, nếu không lần tap đầu trên iOS kéo theo một
// lần relayout giữa animation bàn phím: `rows="3"` là 73px, nội dung rỗng chỉ 32px.
measure();grow();
vscode.postMessage({type:'ready'});renderAll();
