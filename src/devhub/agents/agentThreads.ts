const cp=require('node:child_process');
const util=require('node:util');
const fs=require('node:fs');
const path=require('node:path');
const execFile=util.promisify(cp.execFile);

export interface AgentThread { id:string; title:string; at:number; channel?:string; user?:string; }

/** The two bots have different `threads` schemas, so probe the columns instead of hardcoding SQL. */
export function buildThreadSql(threadCols:string[],msgCols:string[]|undefined,runCols:string[]|undefined,limit:number,offset=0){
  const has=(c:string)=>threadCols.includes(c);
  let id=has('thread_ts')?'thread_ts':threadCols[0];
  if(!id)return undefined;
  // Unlike `at` (allowlist below), this may be a raw column name from `pragma table_info` of
  // an unknown DB: splicing it into SQL lets the schema decide the query.
  id=`"${id.replace(/"/g,'""')}"`;
  const at=['last_active_at','updated_at','created_at'].find(has);
  const msg=(cols?:string[])=>!!cols&&cols.includes('thread_ts');
  const msgOk=msg(msgCols)&&!!msgCols&&msgCols.includes('text');
  const runOk=msg(runCols);
  const pick=(col:string,cols?:string[])=>runOk&&cols&&cols.includes(col)
    ? `(select r.${col} from runs r where r.thread_ts=t.${id} and coalesce(r.${col},'')<>'' order by r.rowid desc limit 1)` : null;

  // Title: summary -> user message -> any message -> the run's input_preview -> ticket -> id
  const title=[
    has('summary')?"nullif(t.summary,'')":null,
    msgOk?`(select substr(m.text,1,70) from messages m where m.thread_ts=t.${id} and m.role='user' order by m.rowid limit 1)`:null,
    msgOk?`(select substr(m.text,1,70) from messages m where m.thread_ts=t.${id} order by m.rowid limit 1)`:null,
    runOk&&runCols!.includes('input_preview')?`(select substr(r.input_preview,1,70) from runs r where r.thread_ts=t.${id} and coalesce(r.input_preview,'')<>'' order by r.rowid limit 1)`:null,
    has('active_ticket')?"nullif(t.active_ticket,'')":null,
    `t.${id}`,
  ].filter(Boolean) as string[];
  const titleExpr=title.length>1?`coalesce(${title.join(',')})`:title[0];

  const channel=[has('channel')?"nullif(t.channel,'')":null,pick('channel',runCols)].filter(Boolean) as string[];
  const user=[has('user_id')?"nullif(t.user_id,'')":null,pick('user_id',runCols)].filter(Boolean) as string[];
  const expr=(a:string[])=>a.length?(a.length>1?`coalesce(${a.join(',')})`:a[0]):"null";

  return `select t.${id} as id, ${titleExpr} as title, ${at?`t.${at}`:'0'} as at, `
       + `${expr(channel)} as channel, ${expr(user)} as user from threads t`
       + (at?` order by t.${at} desc`:'')
       + ` limit ${Math.max(1,limit)} offset ${Math.max(0,offset)};`;
}

/** Epoch seconds (Slack ts) or millis — normalised to ms. */
export function toMs(v:any){const n=Number(v);if(!Number.isFinite(n)||n<=0)return 0;return n>1e12?n:n*1000;}

export function resolveDb(cwd:string,db?:string){
  if(db)return path.isAbsolute(db)?db:path.join(cwd,db);
  try{const f=fs.readdirSync(cwd).find((n:string)=>n.endsWith('.db'));return f?path.join(cwd,f):undefined;}
  catch{return undefined;}
}

async function cols(db:string,table:string):Promise<string[]|undefined>{
  try{
    const {stdout}=await execFile('sqlite3',['-readonly',db,`pragma table_info(${table});`],{timeout:5000});
    const list=String(stdout).trim().split('\n').filter(Boolean).map((l:string)=>l.split('|')[1]);
    return list.length?list:undefined;
  }catch{return undefined;}
}

/** review-bot stores input_preview as JSON; show `command` instead of the whole JSON blob. */
export function prettyTitle(raw:any):string{
  let t=String(raw??'').trim();
  if(t.startsWith('{')){
    try{const o=JSON.parse(t.endsWith('}')?t:t+'}');
      t=String(o.command??o.prompt??o.text??o.input??t);}
    catch{const m=/"(?:command|prompt|text)"\s*:\s*"([^"]{2,})/.exec(t);if(m)t=m[1];}
  }
  return t.replace(/\s+/g,' ').trim().slice(0,70)||'(no title)';
}
export function normalizeRows(json:string):AgentThread[]{
  let rows:any; try{rows=JSON.parse(json||'[]');}catch{return [];}
  if(!Array.isArray(rows))return [];
  return rows.map((r:any)=>({
    id:String(r.id??''),
    title:prettyTitle(r.title??r.id),
    at:toMs(r.at),
    channel:r.channel?String(r.channel):undefined,
    user:r.user?String(r.user):undefined,
  })).filter((t:AgentThread)=>t.id);
}

export async function readThreads(cwd:string,db:string|undefined,limit:number,offset=0):Promise<AgentThread[]>{
  const file=resolveDb(cwd,db); if(!file||!fs.existsSync(file))return [];
  const t=await cols(file,'threads'); if(!t)return [];
  const sql=buildThreadSql(t,await cols(file,'messages'),await cols(file,'runs'),limit,offset); if(!sql)return [];
  try{
    // -readonly: reads the DB of a RUNNING bot and must never take its write lock.
    const {stdout}=await execFile('sqlite3',['-readonly','-json',file,sql],{timeout:6000});
    return normalizeRows(String(stdout));
  }catch{return [];}
}
