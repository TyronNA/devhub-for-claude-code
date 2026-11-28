#!/usr/bin/env node
// Review past agent sessions to answer "did it do fine?" without opening every tab.
//   node scripts/audit-sessions.js [--days 1 | --since <ISO>] [--provider codex|claude]
//                                   [--id <session id>] [--json]
// Reads the CLIs' transcripts DIRECTLY (~/.codex/sessions, ~/.claude/projects) rather than
// Dev Hub's sessions.json: that store only holds metadata, not a single word of content.
const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os');

const argv=process.argv.slice(2);
const arg=(k,d)=>{const i=argv.indexOf('--'+k);return i>=0&&argv[i+1]?argv[i+1]:d;};
const DAYS=Number(arg('days',1)); const ONLY=arg('provider',''); const ID=arg('id',''); const JSONOUT=argv.includes('--json');
// `--since` pins a cutoff: data from before a tool fix is noise from the old build, and mixing it in
// leaves no way to tell which numbers describe the current system.
const SINCE=arg('since','')?Date.parse(arg('since','')):Date.now()-DAYS*86400000;
if(Number.isNaN(SINCE)){console.error('--since needs an ISO time, e.g. 2026-09-12T11:40:05+07:00');process.exit(2);}

const walk=(dir,out=[])=>{ let items; try{items=fs.readdirSync(dir,{withFileTypes:true});}catch{return out;}
  for(const it of items){ const p=path.join(dir,it.name);
    if(it.isDirectory())walk(p,out); else if(it.name.endsWith('.jsonl'))out.push(p); }
  return out; };
const lines=f=>{ try{return fs.readFileSync(f,'utf8').split('\n');}catch{return [];} };

/** Codex rollout: one file = one thread. Counted per turn, because "did it do fine" is a per-turn question. */
function codexRow(file){
  // The rollout file name IS the thread id, and that is what you paste into a trace box. `session_meta`
  // can't be trusted for child threads: a fork copies the parent's record, so the id read is the parent's.
  const r={provider:'codex',file,
    id:(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(path.basename(file))||[,path.basename(file,'.jsonl')])[1],
    cwd:'',turns:0,done:0,aborted:0,errors:0,cmds:0,cmdFail:0,files:0,spawned:[],finished:new Set(),
    tokens:0,first:0,last:0,originator:''};
  for(const l of lines(file)){ if(!l.trim())continue; let j; try{j=JSON.parse(l);}catch{continue;}
    const p=j.payload; if(!p||typeof p!=='object')continue;
    const t=Date.parse(j.timestamp||'')||0; if(t){ if(!r.first)r.first=t; r.last=t; }
    // A child thread (`fork_turns:"all"`) copies the parent's ENTIRE history, `task_started` and all.
    // Two `session_meta` records in one file = this is a fork, not a separate session;
    // counting it as a session inflates the turn count and counts one parent turn several times.
    if(j.type==='session_meta'){ r.cwd=p.cwd||r.cwd; r.originator=p.originator||''; r.metas=(r.metas||0)+1;
      if(r.metas>1)r.forked=true; }

    if(p.type==='task_started')r.turns++;
    else if(p.type==='task_complete')r.done++;
    else if(p.type==='turn_aborted')r.aborted++;
    else if(p.type==='error')r.errors++;
    else if(p.type==='token_count'){ const u=p.info&&p.info.total_token_usage; if(u&&u.total_tokens)r.tokens=u.total_tokens; }
    else if(p.type==='item_completed'&&p.item){ const it=p.item;
      if(it.type==='CommandExecution'){ r.cmds++; if(it.exit_code)r.cmdFail++; }
      else if(it.type==='FileChange')r.files+=Object.keys(it.changes||{}).length;
      else if(it.type==='Error')r.errors++;
      else if(it.type==='SubAgentActivity'){ const k=String(it.kind||'').toLowerCase();
        if(k==='started')r.spawned.push({path:it.agent_path||'',thread:it.agent_thread_id||''});
        else if(k==='completed')r.finished.add(it.agent_thread_id||''); } } }
  return r;
}

/** Claude transcript: `Agent` is a sub-agent; a sidechain is the child's own turn, not the parent's. */
function claudeRow(file){
  const r={provider:'claude',file,id:path.basename(file,'.jsonl'),cwd:'',turns:0,done:0,aborted:0,
    errors:0,cmds:0,cmdFail:0,files:0,spawned:[],finished:new Set(),tokens:0,first:0,last:0,originator:''};
  const open=new Map();
  for(const l of lines(file)){ if(!l.trim())continue; let j; try{j=JSON.parse(l);}catch{continue;}
    const t=Date.parse(j.timestamp||'')||0; if(t){ if(!r.first)r.first=t; r.last=t; }
    r.cwd=j.cwd||r.cwd;
    if(j.isSidechain)continue;                       // sub-agent turns, counted separately via `spawned`
    const m=j.message||{}; const content=Array.isArray(m.content)?m.content:[];
    if(j.type==='user'){ const c=m.content;
      const txt=typeof c==='string'?c:(Array.isArray(c)?c.filter(x=>x&&x.type==='text').map(x=>String(x.text||'')).join(''):'');
      // The CLI records an interrupted turn as a `user` message with text — don't count it as a new turn.
      if(/^\[Request interrupted/.test(txt.trim()))r.aborted++;
      // Every tool_result also comes back under role `user`; only a message with real text is a turn.
      else if(txt.trim()&&!j.isMeta)r.turns++; }
    // API errors (out of quota, overloaded…) come back as `<synthetic>` assistant rows with this flag.
    if(j.isApiErrorMessage)r.errors++;
    const u=m.usage; if(u)r.tokens+=(u.input_tokens||0)+(u.output_tokens||0);
    for(const part of content){ if(!part||typeof part!=='object')continue;
      if(part.type==='tool_use'){ const n=String(part.name||'');
        if(n==='Bash')r.cmds++;
        if(n==='Write'||n==='Edit'||n==='NotebookEdit')r.files++;
        if(n==='Agent'||n==='Task'){ const i=part.input||{};
          r.spawned.push({path:[i.description,i.subagent_type&&`(${i.subagent_type})`].filter(Boolean).join(' '),thread:part.id||''});
          open.set(part.id,true); } }
      else if(part.type==='tool_result'){ const id=part.tool_use_id;
        if(part.is_error)r.cmdFail++;
        if(open.has(id)){ r.finished.add(id); open.delete(id); } } } }
  r.done=Math.max(0,r.turns-r.aborted); return r;
}

const roots=[[path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),codexRow,'codex'],
             [path.join(os.homedir(),'.claude','projects'),claudeRow,'claude']];
const rows=[];
for(const [root,fn,name] of roots){ if(ONLY&&ONLY!==name)continue;
  for(const f of walk(root)){ let st; try{st=fs.statSync(f);}catch{continue;}
    if(st.mtimeMs<SINCE&&!ID)continue;
    const r=fn(f); if(ID&&r.id!==ID&&!r.file.includes(ID))continue;
    if(!r.turns&&!r.cmds&&!ID)continue; rows.push(r); } }
rows.sort((a,b)=>a.last-b.last);

// No `process.exit` right after stdout: 1,000 transcripts make JSON larger than the pipe buffer and it gets cut.
if(JSONOUT)process.stdout.write(JSON.stringify(rows.map(r=>({...r,finished:[...r.finished]})),null,2)+'\n');

if(!JSONOUT){
const hhmm=t=>t?new Date(t).toTimeString().slice(0,5):'--:--';
const short=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s.padEnd(n);
console.log(`# ${rows.length} sessions, last ${DAYS} days\n`);
let flagged=0;
for(const r of rows){
  // A spawned child with no completion marker = it died with the turn (Codex) or the turn was cut (Claude).
  const orphans=r.spawned.filter(s=>!r.finished.has(s.thread));
  const bad=r.aborted||r.errors||orphans.length||(r.cmds&&r.cmdFail/r.cmds>0.3);
  if(bad)flagged++;
  console.log(`${bad?'!':' '} ${hhmm(r.first)}–${hhmm(r.last)} ${(r.forked?'↳sub':r.provider).padEnd(6)} ${short(r.id,38)} ${short(path.basename(r.cwd||'?'),22)}`);
  // A child thread's rollout copies the parent's entire history, so the turns/commands/files here are the total of
  // both and CAN'T be separated (the copied part is spread over a few milliseconds, with no clean cutoff).
  // Better print nothing than a wrong number; `aborted` is still real because it only happens at run time.
  const bits=r.forked?['child thread — turns/commands cannot be separated from the parent history']:[`${r.turns} turns`];
  if(r.aborted)bits.push(`${r.aborted} aborted`);
  if(r.errors)bits.push(`${r.errors} errors`);
  if(!r.forked&&r.cmds)bits.push(`${r.cmds} commands${r.cmdFail?` (${r.cmdFail} fail)`:''}`);
  if(!r.forked&&r.files)bits.push(`${r.files} file`);
  if(r.tokens)bits.push(`${(r.tokens/1000).toFixed(0)}k tok`);
  console.log(`    ${bits.join(' · ')}`);
  for(const s of (r.forked?[]:r.spawned))
    console.log(`    sub-agent ${r.finished.has(s.thread)?'✓':'✗ NEVER REPORTED DONE'}  ${s.path||s.thread}${s.thread&&s.path?`  ${s.thread}`:''}`);
}
console.log(`\n${flagged}/${rows.length} sessions show signs worth a look (rows marked \`!\`).`);
}
