const vscode=acquireVsCodeApi();
let state={session:null,draft:null,events:[],workspace:null,project:null,scm:null};
const $=id=>document.getElementById(id);
// A missing element once killed the whole script, taking Enter down with it.
const on=(id,ev,fn)=>{const el2=$(id);if(el2)el2.addEventListener(ev,fn);else console.warn('Dev Hub: missing #'+id)};
function el(tag,cls,text){const d=document.createElement(tag);if(cls)d.className=cls;if(text!=null)d.textContent=text;return d}
function compact(n){if(n==null)return '\u2014';if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,'')+'m';if(n>=1e3)return (n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,'')+'k';return String(n)}
function stale(at){return at!=null&&Date.now()-at>15*60*1000}
/* Every ring measures what is LEFT: a full arc = untouched, draining as it is used. */
function ringColor(left){return left<0.1?'var(--vscode-editorError-foreground)':left<0.3?'var(--vscode-editorWarning-foreground)':'var(--accent)'}
function inWords(ms){const m=Math.max(0,Math.round(ms/60000));return m<60?m+'m':Math.floor(m/60)+'h '+(m%60)+'m'}
/**
 * One quota ring: arc and number are both the % of quota LEFT — same direction as the context ring, because
 * three identical rings with opposite meanings are unreadable. When it resets goes in the tooltip.
 * Only Claude reports quota — for any other provider hide it entirely; "5h —" would read as still loading.
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
  // Label kept apart from the number: at phone width CSS hides the label and keeps only the %, because "5h"/"7d"
  // are the only things in the row that can go and still be read (ring order is fixed: 5h then 7d).
  $(key+'lab').textContent=label;
  $(key+'text').textContent=(stale(at)?'~':'')+Math.round(remain*100)+'%';
  // The tooltip gives both numbers: the status bar and the CLI's `/status` both read as "used".
  // No `title`: the native tooltip shows after ~1s and looks like an OS caption — a custom card
  // shows immediately on hover; aria-label keeps the full sentence for screen readers.
  wrap.setAttribute('aria-label',long+' \u00b7 '+Math.round(remain*100)+'% left \u00b7 '+Math.round(used)+'% used'
    +(resetsAt!=null?' \u00b7 resets '+new Date(resetsAt).toLocaleString()+' (in '+inWords(until)+')':''));
  const tip=$(key+'tip');if(tip)quotaTip(tip,long,remain,used,at,resetsAt,until,ins);
}
// Shared head of the hover cards (quota + context): name, big % left in the ring colour, bar.
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
    // Under a day the time is enough; the weekly quota needs the weekday, or "11:00" reads as today.
    const when=until<24*3600*1000?d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})
      :d.toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    const r=el('div','qt-row');r.appendChild(el('span',null,'Resets'));r.appendChild(el('b',null,'in '+inWords(until)));
    r.appendChild(el('span','qt-when',when));tip.appendChild(r)}
  if(stale(at))tip.appendChild(el('div','qt-stale','Observed '+inWords(Date.now()-at)+' ago \u2014 may be outdated'));
  if(ins)insightRows(tip,ins)}
/**
 * The CLI's `get_usage`, worded like the official extension. The %s are OVERLAPPING traits (one request
 * can be both >150k context and run while 4+ sessions are in parallel), not shares — summing past 100
 * is normal, so the card has to say so. The 5h card uses the 24h window, the 7d card 7 days.
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
 * How long until the prompt cache expires, computed like the official extension: last request that hit the cache
 * + TTL (5m/1h). Send within it and the next turn reads the cache back; past it the whole conversation is rewritten.
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
  // The `usage` event only arrives once per turn, but the `~` and the countdown in the tooltip follow the clock.
  // The clock only lives while there is a ring to move: a Codex/Planner tab spawns no useless timer.
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
function providerName(p){return p==='codex'?'Codex':p==='planner'?'Planner':'Claude'}
// Brand mark drawn inline: localResourceRoots only opens the media root, other files can't be loaded.
const MARK={claude:'M8.8 12a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0ZM9.9 4a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM2.972 8a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM2.972 16a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM9.9 20a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM16.828 16a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0ZM16.828 8a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0Z',codex:'M3.6 6.6 5.2 5l6.6 6.6-6.6 6.6-1.6-1.6 5-5zM12.4 16.4h8v2.2h-8z',planner:'M12 .5a1.9 1.9 0 0 1 0 3.8 1.9 1.9 0 0 1 0-3.8zM11.15 3h1.7v5.2h-1.7zM7 7h10a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4zM9.2 11.7a1.7 1.7 0 0 0 0 3.4 1.7 1.7 0 0 0 0-3.4zM14.8 11.7a1.7 1.7 0 0 0 0 3.4 1.7 1.7 0 0 0 0-3.4z'};
function mark(p,size){const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');const px=String(size||14);
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width',px);svg.setAttribute('height',px);svg.setAttribute('class','mark');
  const path=document.createElementNS(ns,'path');path.setAttribute('d',MARK[p]||'');path.setAttribute('fill','currentColor');
  svg.appendChild(path);return svg}
const CIRC=2*Math.PI*10;
/** Read once: the pointer type doesn't change within a session, and the composer reads it on every header render. */
const TOUCH=(()=>{try{return !!(window.matchMedia&&window.matchMedia('(hover:none)').matches)}catch(e){return false}})();
const WORDS=['Cooking','Vibing','Noodling','Percolating','Simmering','Brewing','Conjuring','Wrangling','Tinkering','Schlepping','Puzzling','Whirring','Marinating','Spelunking'];
let think={timer:null,at:0,word:0,key:''};
/** One format for both the running and the summary state: two numbers side by side must read the same way. */
function dur(ms){const s2=Math.max(0,Math.round(ms/1000));return s2<60?s2+'s':Math.floor(s2/60)+'m '+(s2%60)+'s'}
/** Spinning logo = running. Still = finished (this bar stays as the turn's summary footer). */
/** Keyed by session: switching tabs midway must restart the clock for the NEW session, not carry on. */
function thinkKey(){const s2=state.session;return s2?s2.provider+'|'+s2.nativeSessionId:''}
/**
 * The turn's start time comes from the transcript, not from when the tab opened — returning to a running tab still
 * shows the right seconds. Same trap as turnSummary: transcripts imported from the CLI can carry meaningless times.
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
    // Change the verb every ~4s so it visibly stays alive rather than hung.
    if(secs&&secs%4===0)$('thinkword').textContent=WORDS[(++think.word)%WORDS.length];
  };
  $('thinkword').textContent=WORDS[think.word];setThinkTokens(null);tick();
  think.timer=setInterval(tick,1000);
}
/**
 * Thinking content is redacted; only an estimated token count is given. It is the ONLY thing that moves in
 * the silence between two tool calls (measured 2.5s before the first tool, 1.5s after each result).
 */
function setThinkTokens(n){const e2=$('thinktokens');if(!e2)return;
  e2.textContent=n==null?'':'· '+(n<1000?String(n):(n/1000).toFixed(1).replace(/\.0$/,'')+'k')+' thinking'}
/**
 * `sessionUpdated`('running') arrives BEFORE the new turn's `user_message` (SessionManager emits in
 * that order), so when the clock starts, `state.events` still ends at the PREVIOUS turn — the time taken
 * is the old one and the seconds shown become the sum of two turns. When the new turn's message arrives,
 * re-anchor; `startThinking` can't do it because it returns early for the same session.
 */
function reanchorThinking(at){if(!think.timer)return;const t=Number(at)||Date.now();
  if(!(t>think.at&&Date.now()-t>=0))return;
  think.at=t;$('thinktime').textContent=dur(Date.now()-think.at)}
function stopThinking(){if(think.timer){clearInterval(think.timer);think.timer=null}think.key='';setThinkTokens(null);renderTurnSummary()}
/**
 * Summary of the LAST turn, recomputed from the transcript itself: the host sends no extra event, and
 * reopening an old tab rebuilds the same numbers. The turn starts at the latest `user_message`.
 * One call counts ONCE: its `*_started` and `*_completed` share a `callKey`.
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
  // Transcripts imported from the CLI can carry meaningless times — better no time than a wrong one.
  return {ms:(at&&ms>0&&ms<24*3600*1000)?ms:null,calls:calls,names:names,usage:usage};
}
/**
 * When a turn ends the thinking bar does NOT disappear: it becomes the summary footer. Only print pieces
 * that were measured — missing tokens or cost drops that piece entirely; don't print "—" to look like a number.
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
  // The three most-used tool names are enough to tell what the turn did; the rest go in the tooltip.
  if(s.calls)bits.push(s.calls+(s.calls===1?' call':' calls')
    +(s.names.length?' ('+s.names.slice(0,3).map(n=>n[0]+' '+n[1]).join(', ')+(s.names.length>3?', \u2026':'')+')':''));
  if(tok)bits.push(compact(tok)+' tok');
  if(u.costUsd!=null)bits.push('$'+Number(u.costUsd).toFixed(Number(u.costUsd)<1?3:2));
  const meta=$('thinktokens');if(meta)meta.textContent=bits.length?'\u00b7 '+bits.join(' \u00b7 '):'';
  box.title=(s.ms!=null?'Turn took '+dur(s.ms)+'\n':'')
    +(s.names.length?s.names.map(n=>n[0]+' \u00d7 '+n[1]).join('\n')+'\n':'')
    // `costUsd` is the number the CLI reports at the end of the turn, NOT a sum computed by Dev Hub.
    +tokenTip(s.usage);
}

/**
 * VS Code keeps this state across Reload Window and hands it back to the host-side serializer.
 * The DOM survives a hidden tab (retainContextWhenHidden:true) but NOT a Reload
 * Window, so text being typed has to live here to come back.
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
/** Same threshold as the @media in chat.css: there the composerbar is ONE row that only fits when effort
 *  is 3 characters. Cut straight, no ellipsis — "med"/"hig" still read, "me…" doesn't.
 *  Full name in the tooltip. `matchMedia` rather than innerWidth: the panel is an iframe, and its width
 *  is what CSS measures. */
const NARROW=window.matchMedia?window.matchMedia('(max-width:560px)'):null;
/** `claude-opus-5-5` → `Opus 5.5`. Derived from the id rather than a lookup table: a new CLI release labels itself correctly.
 *  Each version number has at most 2 digits so a date suffix (`haiku-4-5-20251001`) doesn't become "4.5.20251001". */
function modelLabel(id){const m=/^claude-([a-z]+)-(\d{1,2}(?:-\d{1,2})*)(?![0-9])/.exec(id||'');
  return m?m[1].charAt(0).toUpperCase()+m[1].slice(1)+' '+m[2].replace(/-/g,'.'):''}
function renderOptions(){const me=$('model'),pick=state.model||'',run=state.session&&state.session.usage&&state.session.usage.model,lab=modelLabel(run);
  // Only replace the alias when the id is the same family: right after switching the picker to sonnet the id is still the previous turn's opus.
  const fam=lab&&(!pick||pick===run||pick===lab.split(' ')[0].toLowerCase());
  me.textContent=fam?lab:(state.model||'auto');me.title=fam?'Model: '+(state.model||'auto')+' \u2192 '+run:'Model';
  const ef=state.effort||'auto',el=$('effort');
  el.textContent=NARROW&&NARROW.matches?ef.slice(0,3):ef;el.title='Thinking effort: '+ef;
  const sl=$('slash');if(sl)sl.hidden=!state.slash}
// The panel resizes, and Safari changes width on rotation: the effort label has to follow.
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
  // The token table moves into the context ring's tooltip — the old #usage row used to hold this.
  // Like the quota ring: a custom card instead of `title` (native is slow and overlaps the card); aria-label keeps the full text.
  $('ctxwrap').setAttribute('aria-label','Context left — click to compact\n'+tokenTip(u));
  const tip=$('ctxtip');if(tip)ctxTip(tip,u,used,win);
  renderQuotas();
  // Token counts split from the % because a narrow screen only has room for the %; CSS hides the second half, the tooltip keeps all of it.
  const tok=$('ctxtokens');
  // Unknown means an empty ring — a full ring here means "context untouched", not "unknown".
  if(used==null||!win){$('arc').setAttribute('stroke-dasharray','0 '+CIRC.toFixed(1));$('ctxtext').textContent='—';if(tok)tok.textContent='';return}
  const remain=1-Math.max(0,Math.min(1,used/win));
  $('arc').setAttribute('stroke-dasharray',(remain*CIRC).toFixed(1)+' '+CIRC.toFixed(1));
  $('arc').setAttribute('stroke',ringColor(remain));
  $('ctxtext').textContent=Math.round(remain*100)+'%';
  if(tok)tok.textContent=' · '+compact(used)+'/'+compact(win)}
/**
 * Git chip: the DIRTY working tree (uncommitted), not the whole branch diff — the number must move
 * while the agent edits files, that's what is worth watching here. Untracked files are
 * counted in the file count but NOT in the line count (`git diff HEAD` doesn't see them); the tooltip says so.
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
/** Five cells like GitHub. A side rounding down to 0 cells is only rescued when the other side is empty too:
 *  378/14 must give 4 green + 1 grey; forcing 1 red loses exactly that grey cell. */
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
  // No session yet means no ID to copy; a fresh draft carries no id.
  const cid=$('copyid');cid.hidden=!s;if(s)cid.title='Copy session ID\n'+s.nativeSessionId;
  const running=!!s&&s.status==='running';
  // No longer disabled: sending while running goes into the host's queue.
  $('send').title=running?'Queue this message (\u23ce)':'Send (\u23ce)';
  if(running)startThinking();else stopThinking();
  // Without a real pointer ⏎/⇧⏎ mean nothing, and the hint takes two lines of the composer on a phone.
  $('input').placeholder='Ask '+(p?providerName(p):'Claude')+'\u2026'+(TOUCH?'':'  (\u23ce send \u00b7 \u21e7\u23ce newline \u00b7 paste an image)');
  renderOptions();renderContext();renderScm();saveState()}
/** Long output is wrapped in <details> — avoids endless scrolling and building thousands of nodes. */
/**
 * Minimal markdown, built with createElement so there is NO injection surface.
 * Only accepts what agents actually emit: headings, lists, fences, bold/italic/code, links.
 */
/**
 * Media the agent names by absolute path (`![](/tmp/a.gif)`, `` `/x/demo.mp4` ``) renders straight into
 * the bubble. The host provides the URI base via `mediaBase` (panel: asWebviewUri('/'), mobile: `/api/file?f=`);
 * read permission is still the host's call. The streaming tail does NOT build it: it redraws on every delta, so a video would reload forever.
 * Video is NOT muted: it doesn't autoplay (only autoplay requires muted), and agents often hand over audio as mp4.
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
  // The file is gone, outside the roots the host opened, or VS Code's Electron lacks the codec (H.264 in
  // .mp4/.mov): a button that opens the file beats a silent black box.
  n.addEventListener('error',()=>mediaFallback(n,p));
  n.className='assistant-image';n.src=src;parent.appendChild(n);return true}
function inline(parent,text){
  const re=/(\\[\\`*_~\[\]()#+\-.!])|(\*\*\*[^*]+\*\*\*|___[^_]+___)|(\*\*[^*]+\*\*|__[^_]+__)|(~~[^~]+~~)|(`+[^`]+`+)|(\*[^*\n]+\*|_[^_\n]+_(?![A-Za-z0-9]))|(!?\[[^\]]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let last=0,m;
  while((m=re.exec(text))){
    // `snake_case_word` is not italic. This condition used to be written with lookbehind, but WebKit
    // only has lookbehind since Safari 16.4 — such a literal is a SyntaxError that kills the whole script
    // (the webview on iPhone/iPad runs iOS's engine). Step lastIndex back 1 character so the next `_` pair still
    // gets a chance to match, just as the engine does when lookbehind fails.
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
  const stack=[];                        // [{node,ordered,indent}] for nested lists
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

    // Merge adjacent lines into ONE paragraph, the way markdown works.
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
/** Claude Code prints ONE line per tool call and folds the output. Follow that style exactly. */
function oneLine(text,max){const t=String(text==null?'':text).replace(/\s+/g,' ').trim();
  return t.length>max?t.slice(0,max-1)+'\u2026':t}
function toolRow(parent,name,arg,output,exitCode){
  const full=String(arg==null?'':arg);
  const short=oneLine(full,110);
  const head=el('div','trow');
  head.appendChild(el('span','tname',name));
  // Empty = block_start just arrived, the arguments are still streaming.
  head.appendChild(el('span','targ','('+(short||'\u2026')+')'));
  // A multi-KB heredoc gets squeezed to 110 characters by `oneLine`; if it can't be expanded the script body vanishes
  // from the UI, even when the transcript is reopened.
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
  // The exit badge MUST be independent of the line count: a failed command with 20 lines of stderr used to show only
  // "+19 lines", looking exactly like a successful one.
  if(exitCode!=null&&exitCode!==0)sum.appendChild(el('span','morecount bad','exit '+exitCode));
  det.appendChild(sum);
  det.appendChild(el('pre','mono full',out||('exit '+exitCode)));
  parent.appendChild(det);
}
/**
 * One tool call = ONE row. `*_started` builds the row, `*_completed` writes into that same row.
 * Without a callId (old transcripts) match loosely by name/command.
 */
let pendingRows=new Map();
function callKey(e){
  if(e.callId)return 'id:'+e.callId;
  if(e.type==='command_started'||e.type==='command_completed')return 'cmd:'+String(e.command||'');
  return 'tool:'+String(e.tool||'')+'\u0000'+String(e.label||'');
}

/** Only auto-scroll when the user is at the bottom; if they are reading above, don't yank them down. */
/**
 * Stick to the bottom. Reading scrollHeight right after a DOM change forces a layout; doing that
 * per event means 1000 events = 1000 layouts (measured in Chrome: 1001 layouts / ~520ms).
 * So "at the bottom" comes from the user's own `scroll` events, and scrolling is
 * batched to once per frame. Your own message scrolls immediately, without waiting for a frame.
 */
let stuckToBottom=true,scrollQueued=false;
function noteScroll(m){stuckToBottom=m.scrollHeight-m.scrollTop-m.clientHeight<40}
function autoscroll(m,force){
  if(force){stuckToBottom=true;m.scrollTop=m.scrollHeight;return}
  if(!stuckToBottom||scrollQueued)return;
  scrollQueued=true;
  requestAnimationFrame(()=>{scrollQueued=false;m.scrollTop=m.scrollHeight});
}
/** An open, unclosed fence: a blank line inside a code block is NOT a block boundary. */
function openFence(s){const f=s.match(/^\s*(?:\u0060{3,}|~{3,})/gm);return !!f&&f.length%2===1}
/**
 * Render markdown while streaming, instead of pasting raw text and formatting it all at turn_done —
 * otherwise a reader sees `**bold**`, backticks and tables as source while it runs.
 * Everything before the last block break is settled, so it is drawn ONCE into .stream-done; only the block
 * being typed is redrawn on each delta, so the cost scales with one block, not the whole message.
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
  // An unclosed code block is the ONLY block that can grow without bound (a file, a diff) with no
  // blank line to settle it. A fence body is verbatim, so appending text is enough — no need to re-parse the block.
  if(inFence&&d._pre){d._pre.textContent+=text;return}
  const tail=d.querySelector('.stream-tail');
  tail.textContent='';noMedia=true;try{markdown(tail,rest)}finally{noMedia=false}
  d._pre=inFence?tail.lastElementChild:null;
}
/**
 * into = DocumentFragment when building a whole transcript: nodes not yet in the document
 * cause no layout, and scrollHeight is NOT read after each event (that is what forced reflow
 * over and over when opening a long transcript).
 */
function addEvent(e,into){const m=$('messages');const host=into||m;
  const blank=host.querySelector('.empty');if(blank)host.removeChild(blank);
  if(e.type==='turn_done'){const last=host.lastElementChild;
    if(last&&last.classList.contains('assistant-streaming')){
      // Redraw a turn from the original text: the final DOM must match a reopened transcript exactly.
      const raw=last._raw||'';
      last.textContent='';markdown(last,raw);last.classList.remove('assistant-streaming')}
    return}
  if(e.type==='usage'){if(state.session){state.session.usage=Object.assign({},state.session.usage||{},e.usage);renderHeader()}return}
  // A view frame is EVERYTHING generated so far (the planner edits the message in place), so redraw from scratch
  // into the SAME streaming bubble — appending would give three copies of the same sentence.
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
    // imageSrcs are built by the host (webview URIs); e.images are real paths, used only as alt.
    const srcs=e.imageSrcs||[];
    if(srcs.length){const row=el('div','uimgs');
      srcs.forEach((src,i)=>{const im=document.createElement('img');im.className='uimg';im.src=src;
        im.alt=String((e.images&&e.images[i])||'image').split('/').pop();im.loading='lazy';row.appendChild(im)});
      d.appendChild(row)}}
  else if(e.type==='assistant_message'){cls+='assistant';markdown(d,e.text)}
  else if(e.type==='assistant_image'){
    cls+='assistant';
    // No src = the host couldn't turn the path into a webview URI. A line of text beats
    // a broken image box that says nothing.
    if(!e.src){body(d,'[image: '+(e.alt||'generated')+']',false)}
    else{const img=document.createElement('img');img.className='assistant-image';img.alt=e.alt||'Generated image';img.src=e.src;img.loading='lazy';d.appendChild(img);}
  }
  else if(e.type==='tool_started'||e.type==='tool_completed'||e.type==='command_started'||e.type==='command_completed'){
    const isCmd=e.type.indexOf('command')===0;
    const key=callKey(e);
    const done=e.type.slice(-9)==='completed';
    // Overwriting an earlier `*_started` is only safe with a callId. Without one `key` is name+label,
    // and two identical calls in one turn would merge into a single row.
    const row=(done||e.callId)?pendingRows.get(key):undefined;
    // Writing into a row already pruned from the DOM loses the message — insert a new row.
    // `*_started` can also arrive twice: once empty at `content_block_start`, once with full
    // arguments at `assistant`. The second overwrites the first; no second row is built.
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
  // Your OWN message always jumps to the bottom — otherwise sending while scrolled up to read
  // leaves it below the screen and it looks lost.
  autoscroll(m,e.type==='user_message')}
function renderAll(){const m=$('messages');m.textContent='';pendingRows=new Map();
  if(!state.events||!state.events.length)m.appendChild(el('div','empty','No messages yet.'));
  else{const frag=document.createDocumentFragment();
    // Only the mobile page sends `older` (it only receives the transcript tail); the panel never sees this button.
    if(state.older>0){const b=el('button','chip older','Load '+Math.min(state.older,200)+' earlier ('+state.older+' hidden)');
      b.addEventListener('click',()=>{b.disabled=true;vscode.postMessage({type:'loadOlder'})});frag.appendChild(b)}
    for(const e of state.events)addEvent(e,frag);
    m.appendChild(frag);
    while(m.children.length>1500)m.removeChild(m.firstElementChild);
    m.scrollTop=m.scrollHeight}
  renderHeader()}
window.addEventListener('message',ev=>{const x=ev.data;
  // Arrives after the transcript (old panel, or a mobile page loaded before the server had it): redraw so media shows.
  if(x.type==='mediaBase'){const b=String(x.base||'');if(b!==mediaBase){mediaBase=b;if(state.events.length)renderAll()}return}
  if(x.type==='sessionSelected'){const m=$('messages'),fromEnd=x.keepScroll?m.scrollHeight-m.scrollTop:0;
    state={session:x.session,draft:null,events:x.events||[],older:x.older||0,workspace:x.workspace,project:x.project,model:state.model,effort:state.effort,scm:state.scm};renderAll();
    // Loading more above: keep the reading position instead of jumping to the bottom as when opening a session.
    if(x.keepScroll)m.scrollTop=m.scrollHeight-fromEnd}
  else if(x.type==='draftSelected'){state={session:null,draft:x.draft,events:[],workspace:x.draft.workspace,project:x.draft.project,model:state.model,effort:state.effort,scm:state.scm};renderAll()}
  else if(x.type==='sessionUpdated'){state.session=x.session;renderHeader()}
  else if(x.type==='event'){
    // Not remembered: a transient notice; a reopened transcript must not show it.
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
/** The CLI is waiting: without an answer it hangs. A clicked button locks the card so it can't be clicked twice. */
/** AskUserQuestion travels over the same permission channel but needs its own UI: the question + option buttons. */
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
        // Answer as soon as every question has a choice — no extra confirm button.
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
  // The host re-posts pending requests after every re-render; don't draw them as two cards.
  for(const c of m.children)if(c.dataset&&c.dataset.req===String(req.requestId))return;
  const d=el('div','perm');d.dataset.req=req.requestId;
  if(req.toolName==='AskUserQuestion'&&addQuestion(req,d)){m.appendChild(d);m.scrollTop=m.scrollHeight;return}
  d.appendChild(el('div','ptitle',(req.displayName||req.toolName)+' wants to run'));
  if(req.description)d.appendChild(el('div',null,req.description));
  const inp=req.input||{};
  const shown=typeof inp.command==='string'?inp.command:JSON.stringify(inp,null,1);
  d.appendChild(el('pre',null,String(shown).slice(0,4000)));
  // The CLI treats the tool's own card as the place to answer; a one-shot allow here may be turned into a deny.
  if(req.requiresUserInteraction)d.appendChild(el('div','phint','This tool wants to be answered on its own card — Allow may be refused.'));
  const acts=el('div','pacts');
  const allow=el('button','allow','Allow');const deny=el('button','deny','Deny');
  const answer=v=>{vscode.postMessage({type:'permissionResponse',requestId:req.requestId,allow:v});
    d.classList.add('answered');d.appendChild(el('div','meta',v?'allowed':'denied'))};
  allow.onclick=()=>answer(true);deny.onclick=()=>answer(false);
  acts.appendChild(allow);acts.appendChild(deny);d.appendChild(acts);
  m.appendChild(d);m.scrollTop=m.scrollHeight}
/** The host says nobody is waiting on this request any more (turn ended / expired). Lock the card with the reason,
 *  or it still looks clickable and clicking does nothing. */
function closePermission(requestId,note){const m=$('messages');
  for(const c of m.children)if(c.dataset&&c.dataset.req===String(requestId)){
    if(c.classList.contains('answered'))return;
    c.classList.add('answered');c.appendChild(el('div','meta',note||'no longer waiting'));return}}
const pending=[];
let queued=[];
/** Only redraws from the list the host sends — the webview adds or removes nothing itself. */
function renderQueue(){const box=$('queue');if(!box)return;box.textContent='';
  queued.forEach((q,i)=>{const row=el('div','qitem');
    const text=q&&typeof q==='object'?String(q.text||''):String(q||'');
    const n=q&&typeof q==='object'?(q.images||0):0;
    // An image-only message has empty text — without a label the queue would show a blank row.
    const shown=text||(n?n+' image(s)':'(empty)');
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
    // Clicking the chip opens the image in an editor. a.path only exists once the host has saved it, so
    // before that the chip isn't clickable — clicking early would send an undefined path.
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
// Touch screens have no hover: tap toggles the quota card, opening one closes the other.
['q5','q7','cache'].forEach(k=>on(k+'wrap','click',()=>{['q5','q7','cache'].forEach(o=>{const x=$(o+'wrap');if(x&&o!==k)x.classList.remove('open')});
  $(k+'wrap').classList.toggle('open')}));
on('model','click',()=>vscode.postMessage({type:'pickModel'}));
on('effort','click',()=>vscode.postMessage({type:'pickEffort'}));
on('send','click',()=>send());
on('cancel','click',()=>vscode.postMessage({type:'cancel'}));
/**
 * iOS does NOT shrink the layout viewport when the keyboard opens — `100dvh`/`innerHeight` stay full screen,
 * so the composer sits under the keyboard. visualViewport is the only place that sees the visible area.
 * Only override when it is actually smaller (i.e. a keyboard/toolbar covers it); desktop is unchanged.
 */
// The panel is in a cross-origin iframe; nothing guarantees its visualViewport reports a meaningful
// number. Below this threshold treat it as junk — better keep 100dvh than write height:0 and blank the panel.
const MIN_VIEW_H=180;
/** The keyboard can only be open while an input has focus. Without that, a small visualViewport number
 *  is junk — iOS fires `scroll` with the old height AFTER the keyboard closes, and keeping it leaves the whole app
 *  stuck in a strip at the top of the screen with the composer floating mid-page. */
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
// Losing focus means the keyboard closed; iOS may not fire another `resize`, so drop the override ourselves.
document.addEventListener('focusout',()=>setTimeout(syncViewport,0));
window.addEventListener('orientationchange',()=>setTimeout(syncViewport,120));
/** Content height of the input, measured by clamping to 0 and reading `scrollHeight`.
 *  NOT measured with `height:auto`: a textarea's `auto` is `rows="3"`, i.e. 73px even when empty —
 *  that is why the old `grow()` stretched a 34px box to 73px. Measure once when the value changes, not in
 *  `syncViewport`: iOS fires resize/scroll continuously while the keyboard rises, and changing the geometry of
 *  the focused element mid-animation makes WebKit drop the present (tap 1 doesn't raise it, tap 2 does
 *  because by then the box is already the right size and nothing is written). */
let contentH=0,lastH='';
function measure(){const t=$('input'),keep=t.style.height;
  t.style.height='0px';contentH=t.scrollHeight;t.style.height=keep}
function grow(){const t=$('input');
  if(!contentH)measure();
  const px=Math.min(contentH,Math.round(viewH()*0.4))+'px';
  // Compare with the value ALREADY written, not offsetHeight: min-height clamps, so the two numbers can
  // differ forever and we would write on every event. Each write is a relayout of the focused box.
  if(px!==lastH){lastH=px;t.style.height=px}}
$('input').addEventListener('input',()=>{measure();grow();saveStateSoon();
  // "/" as the first character -> open the host's picker (the QuickPick already has a filter).
  if($('input').value==='/')vscode.postMessage({type:'pickSlash'})});
$('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
// VS Code (Electron) blocks Cmd+C in a webview and asks the workbench to copy, which it only does while
// it still considers the webview focused. Copy inside the frame to avoid depending on that.
document.addEventListener('keydown',e=>{
  if(!(e.metaKey||e.ctrlKey)||e.shiftKey||e.altKey||e.keyCode!==67)return;
  const s=window.getSelection();if(!s||s.isCollapsed||!String(s))return;
  try{document.execCommand('copy')}catch(_){}},true);
/** The host only accepts these 4 mime types (webviewProtocol); anything else is dropped SILENTLY unless blocked here. */
const IMG_MIME={'image/png':1,'image/jpeg':1,'image/gif':1,'image/webp':1};
let attachmentSeq=0;
/** Errors are records too: `remember` so switching tabs or redrawing still shows them. */
function showError(message){const e={type:'error',message:String(message||'')};remember(e);addEvent(e)}
function attachmentError(requestId,message){const i=pending.findIndex(a=>a.requestId===requestId);
  if(i<0)return;
  pending.splice(i,1);renderAttachments();saveState();
  showError(message||'Could not save the image. Please pick it again.');
}
function attachImage(f){
  if(!f)return false;
  if(!IMG_MIME[f.type]){showError('Cannot send '+(f.type||'this file')+' — only PNG, JPEG, GIF and WebP are accepted.');return false}
  if(f.size>9*1024*1024){showError('Image too large — 9 MiB max per image.');return false}
  const item={requestId:String(++attachmentSeq),name:f.name||'image.png'};
  pending.push(item);renderAttachments();
  const fail=()=>attachmentError(item.requestId,'Could not read the image. Please pick it again.');
  const r=new FileReader();r.onerror=fail;r.onabort=fail;
  r.onload=()=>{if(!pending.includes(item))return;
    const s=String(r.result),i=s.indexOf(',');if(i<0){fail();return}
    if(s.length-i-1>12*1024*1024){attachmentError(item.requestId,'Image too large — 9 MiB max per image.');return}
    item.thumb=s;renderAttachments();
    const probe=new Image();probe.onload=()=>{item.dim=probe.naturalWidth+'\u00d7'+probe.naturalHeight;renderAttachments()};probe.src=s;
    vscode.postMessage({type:'pasteImage',requestId:item.requestId,mime:f.type,data:s.slice(i+1)})};
  try{r.readAsDataURL(f)}catch{fail();return false}return true;
}
$('input').addEventListener('paste',e=>{const items=(e.clipboardData&&e.clipboardData.items)||[];
  for(const it of items){if(it.kind==='file'&&it.type.indexOf('image/')===0){const f=it.getAsFile();if(!f)continue;
    e.preventDefault();attachImage(f);return}}});
// iOS fires no `paste` with a file — the file input is the ONLY way to attach an image on a phone.
on('attach','click',()=>$('file').click());
on('file','change',()=>{const inp=$('file');const files=inp.files||[];
  for(const f of files)attachImage(f);
  inp.value='';});
function send(){const t=$('input');const typed=t.value.trim();
  if(pending.some(a=>!a.path)){showError('The image is still being saved. Wait a moment and send again.');return}
  const paths=pending.filter(a=>a.path).map(a=>a.path);
  if(!typed&&!paths.length)return; if($('send').disabled)return;
  // Images travel as a separate field: Codex attaches them with -i, the host joins them into Claude's prompt.
  vscode.postMessage(paths.length?{type:'sendPrompt',text:typed,attachments:paths}:{type:'sendPrompt',text:typed});
  t.value='';pending.length=0;renderAttachments();measure();grow();saveState()}
restoreDraft();
// An empty box must rest at EXACTLY the size grow() will compute, or the first tap on iOS triggers a
// relayout mid keyboard animation: `rows="3"` is 73px, empty content is only 32px.
measure();grow();
vscode.postMessage({type:'ready'});renderAll();
