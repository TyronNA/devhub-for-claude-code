#!/usr/bin/env node
// Soi lại các phiên agent đã chạy, để trả lời "nó có làm ổn không" mà không phải mở từng tab.
//   node scripts/audit-sessions.js [--days 1 | --since <ISO>] [--provider codex|claude]
//                                   [--id <session id>] [--json]
// Đọc TRỰC TIẾP transcript của CLI (~/.codex/sessions, ~/.claude/projects) chứ không đọc
// sessions.json của Dev Hub: store đó chỉ có metadata, không giữ một chữ nội dung nào.
const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os');

const argv=process.argv.slice(2);
const arg=(k,d)=>{const i=argv.indexOf('--'+k);return i>=0&&argv[i+1]?argv[i+1]:d;};
const DAYS=Number(arg('days',1)); const ONLY=arg('provider',''); const ID=arg('id',''); const JSONOUT=argv.includes('--json');
// `--since` để chốt một mốc: dữ liệu trước lúc sửa tool là nhiễu của bản cũ, trộn vào thì
// không biết con số nào nói về hệ thống hiện tại.
const SINCE=arg('since','')?Date.parse(arg('since','')):Date.now()-DAYS*86400000;
if(Number.isNaN(SINCE)){console.error('--since cần mốc ISO, ví dụ 2026-09-12T11:40:05+07:00');process.exit(2);}

const walk=(dir,out=[])=>{ let items; try{items=fs.readdirSync(dir,{withFileTypes:true});}catch{return out;}
  for(const it of items){ const p=path.join(dir,it.name);
    if(it.isDirectory())walk(p,out); else if(it.name.endsWith('.jsonl'))out.push(p); }
  return out; };
const lines=f=>{ try{return fs.readFileSync(f,'utf8').split('\n');}catch{return [];} };

/** Codex rollout: một file = một thread. Đếm theo lượt vì "ổn hay không" là câu hỏi theo lượt. */
function codexRow(file){
  // Tên file rollout CHÍNH LÀ thread id, và đó là thứ dán vào ô trace được. `session_meta`
  // không tin được cho thread con: fork chép luôn record của cha nên id đọc ra là của cha.
  const r={provider:'codex',file,
    id:(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(path.basename(file))||[,path.basename(file,'.jsonl')])[1],
    cwd:'',turns:0,done:0,aborted:0,errors:0,cmds:0,cmdFail:0,files:0,spawned:[],finished:new Set(),
    tokens:0,first:0,last:0,originator:''};
  for(const l of lines(file)){ if(!l.trim())continue; let j; try{j=JSON.parse(l);}catch{continue;}
    const p=j.payload; if(!p||typeof p!=='object')continue;
    const t=Date.parse(j.timestamp||'')||0; if(t){ if(!r.first)r.first=t; r.last=t; }
    // Thread con (`fork_turns:"all"`) chép NGUYÊN lịch sử của cha, `task_started` và tất cả.
    // Hai record `session_meta` trong một file = đây là bản fork, không phải một phiên riêng;
    // đếm nó như phiên thì số lượt bị thổi lên và một lượt của cha bị tính nhiều lần.
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

/** Claude transcript: `Agent` là sub-agent; sidechain là chính lượt của con, không phải của cha. */
function claudeRow(file){
  const r={provider:'claude',file,id:path.basename(file,'.jsonl'),cwd:'',turns:0,done:0,aborted:0,
    errors:0,cmds:0,cmdFail:0,files:0,spawned:[],finished:new Set(),tokens:0,first:0,last:0,originator:''};
  const open=new Map();
  for(const l of lines(file)){ if(!l.trim())continue; let j; try{j=JSON.parse(l);}catch{continue;}
    const t=Date.parse(j.timestamp||'')||0; if(t){ if(!r.first)r.first=t; r.last=t; }
    r.cwd=j.cwd||r.cwd;
    if(j.isSidechain)continue;                       // lượt của sub-agent, đếm riêng qua `spawned`
    const m=j.message||{}; const content=Array.isArray(m.content)?m.content:[];
    if(j.type==='user'){ const c=m.content;
      const txt=typeof c==='string'?c:(Array.isArray(c)?c.filter(x=>x&&x.type==='text').map(x=>String(x.text||'')).join(''):'');
      // CLI ghi lượt bị ngắt thành một tin `user` có chữ — không đếm nó là lượt mới.
      if(/^\[Request interrupted/.test(txt.trim()))r.aborted++;
      // Mọi tool_result cũng về dưới role `user`; chỉ tin nhắn có chữ thật mới là một lượt.
      else if(txt.trim()&&!j.isMeta)r.turns++; }
    // Lỗi API (hết quota, overloaded…) về thành hàng assistant `<synthetic>` gắn cờ này.
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

// Không `process.exit` ngay sau stdout: 1.000 transcript làm JSON vượt pipe buffer và bị cắt.
if(JSONOUT)process.stdout.write(JSON.stringify(rows.map(r=>({...r,finished:[...r.finished]})),null,2)+'\n');

if(!JSONOUT){
const hhmm=t=>t?new Date(t).toTimeString().slice(0,5):'--:--';
const short=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s.padEnd(n);
console.log(`# ${rows.length} phiên, ${DAYS} ngày gần nhất\n`);
let flagged=0;
for(const r of rows){
  // Con spawn mà không có mốc hoàn tất = nó chết theo lượt (Codex) hoặc lượt bị cắt (Claude).
  const orphans=r.spawned.filter(s=>!r.finished.has(s.thread));
  const bad=r.aborted||r.errors||orphans.length||(r.cmds&&r.cmdFail/r.cmds>0.3);
  if(bad)flagged++;
  console.log(`${bad?'!':' '} ${hhmm(r.first)}–${hhmm(r.last)} ${(r.forked?'↳sub':r.provider).padEnd(6)} ${short(r.id,38)} ${short(path.basename(r.cwd||'?'),22)}`);
  // Rollout của thread con chép nguyên lịch sử của cha, nên lượt/lệnh/file ở đây là tổng của
  // cả hai và KHÔNG tách ra được (phần chép lại rải qua vài mili-giây, không có mốc cắt sạch).
  // Thà không in còn hơn in một con số sai; `bị cắt` thì vẫn thật vì nó chỉ xảy ra lúc chạy.
  const bits=r.forked?['thread con — lượt/lệnh không tách được khỏi lịch sử cha']:[`${r.turns} lượt`];
  if(r.aborted)bits.push(`${r.aborted} bị cắt`);
  if(r.errors)bits.push(`${r.errors} lỗi`);
  if(!r.forked&&r.cmds)bits.push(`${r.cmds} lệnh${r.cmdFail?` (${r.cmdFail} fail)`:''}`);
  if(!r.forked&&r.files)bits.push(`${r.files} file`);
  if(r.tokens)bits.push(`${(r.tokens/1000).toFixed(0)}k tok`);
  console.log(`    ${bits.join(' · ')}`);
  for(const s of (r.forked?[]:r.spawned))
    console.log(`    sub-agent ${r.finished.has(s.thread)?'✓':'✗ KHÔNG BÁO XONG'}  ${s.path||s.thread}${s.thread&&s.path?`  ${s.thread}`:''}`);
}
console.log(`\n${flagged}/${rows.length} phiên có dấu hiệu cần xem lại (dòng đánh dấu \`!\`).`);
}
