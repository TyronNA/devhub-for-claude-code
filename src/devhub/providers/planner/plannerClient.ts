const http=require('node:http');

/** A daemon `tasks` row, exactly as `/tasks` returns it. Only the columns the UI uses are declared. */
export interface PlannerTask {
  jira_key:string; status:string; summary?:string; plan_version?:number; confidence?:number;
  approved_plan_version?:number; affected_repos?:string[]; current_run_id?:number; last_error?:string;
  created_at?:number; updated_at?:number;
}
/** The daemon's `payload` is a TEXT column and the API does NOT decode it (only task is decoded). */
export interface PlannerEvent { id?:number; created_at?:number; jira_key?:string; kind:string; payload?:any; }

export function parsePayload(raw:any){
  if(raw&&typeof raw==='object')return raw;
  if(typeof raw!=='string'||!raw)return undefined;
  try{return JSON.parse(raw);}catch{return undefined;}
}

/**
 * HTTP client for agent-planner. Separate from the provider because the tree and the approval commands
 * also need to talk to the daemon, and they have no chat turn to borrow.
 *
 * No auth — acceptable because it is loopback, and ONLY because it is loopback.
 */
export class PlannerClient {
  constructor(public endpoint='http://127.0.0.1:7341', private timeoutMs=15000){}
  private url(p:string){return `${this.endpoint.replace(/\/$/,'')}${p}`;}

  /**
   * `onRequest` receives the `ClientRequest` itself: the daemon has no cancel endpoint, so the only way
   * for `cancel()` to escape an unbounded `POST /chat` is to destroy the request from outside.
   * It must be destroyed WITH an error — a bare `req.destroy()` emits no 'error' and the promise never settles.
   */
  request(method:string,p:string,body?:any,timeoutMs?:number,onRequest?:(req:any)=>void):Promise<{status:number;reason:string;text:string}>{
    return new Promise((resolve,reject)=>{
      const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
      const req=http.request(this.url(p),{method,timeout:timeoutMs??this.timeoutMs,
        headers:payload?{'content-type':'application/json','content-length':payload.length}:{}},
        (res:any)=>{const chunks:any[]=[];res.on('data',(c:any)=>chunks.push(c));
                    res.on('end',()=>resolve({status:res.statusCode||0,reason:String(res.statusMessage||''),
                                              text:Buffer.concat(chunks).toString('utf8')}));});
      req.on('timeout',()=>req.destroy(new Error('timeout')));
      req.on('error',reject);
      onRequest?.(req);
      if(payload)req.write(payload);
      req.end();
    });
  }

  async json<T>(method:string,p:string,body?:any,timeoutMs?:number,onRequest?:(req:any)=>void):Promise<T>{
    const {status,reason,text}=await this.request(method,p,body,timeoutMs,onRequest);
    // 409 is a REAL answer from the daemon (approve with a wrong version, preflight refused), not
    // a network error — and `reason` is in the STATUS LINE, the body is usually empty. Dropping it reports
    // a bare "409:" in place of the only sentence that explains what happened.
    if(status<200||status>=300)throw new Error(`${method} ${p} -> ${status}: ${(text||reason).slice(0,200)}`);
    return JSON.parse(text||'{}') as T;
  }

  async health(timeoutMs=3000){return this.json<{ok:boolean}>('GET','/health',undefined,timeoutMs);}
  async tasks(){return (await this.json<{tasks:PlannerTask[]}>('GET','/tasks')).tasks||[];}
  async task(key:string){return this.json<PlannerTask>('GET',`/tasks/${encodeURIComponent(key)}`);}
  async plan(key:string,version?:number){
    const q=version?`?version=${version}`:'';
    return this.json<{plan_markdown?:string;current_version?:number;version?:number}>('GET',`/tasks/${encodeURIComponent(key)}/plan${q}`);
  }
  async events(key:string,limit=30){
    const rows=(await this.json<{events:PlannerEvent[]}>('GET',`/events?limit=${limit}&jira_key=${encodeURIComponent(key)}`)).events||[];
    return rows.map(e=>({...e,payload:parsePayload(e.payload)}));
  }
  /**
   * A conversation's saved turns. The live session lives in the daemon's memory; this is the DURABLE half, and the
   * only way to read back a reminder that fired while no tab was open.
   */
  async messages(conversationId:string,limit=200){
    return (await this.json<{messages:Array<{role:string;text:string;created_at?:number}>}>(
      'GET',`/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`)).messages||[];
  }
  async refresh(key:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/refresh`,{},30000);}
  /** `plan_version` is required and the daemon does NOT fill in the current version — don't default it for them. */
  async approve(key:string,planVersion:number){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/approve`,{plan_version:planVersion});}
  async reject(key:string,reason:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/reject`,{reason});}
  /** Unlike reject: reject sends it back to ANALYZING (deep-plans again, $5-7). Dismiss ends the task, $0. */
  async dismiss(key:string,reason:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/dismiss`,{reason});}
  async revive(key:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/revive`,{});}
  /**
   * NO timeout: `POST /execute` awaits the WHOLE implement run (`daemon.execute` -> `execute_task`),
   * i.e. up to 5 fix rounds, each a brain turn with a 1200s limit. The old 120s timeout reported a false error
   * while the daemon was still committing, and users who saw the error clicked again.
   */
  async execute(key:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/execute`,{},0);}
  async stopRun(runId:number){return this.json<any>('POST',`/runs/${runId}/stop`,{});}

  /** One SSE bus shared by every client; the caller filters by conversation_id. */
  stream(onChunk:(text:string)=>void,onOpen?:()=>void){
    const req=http.request(this.url('/stream'),{method:'GET'},(res:any)=>{
      res.setEncoding('utf8');res.on('data',onChunk);res.on('error',()=>{});onOpen?.();
    });
    req.on('error',()=>onOpen?.());   // chat still works without the stream, it only loses the in-progress part
    req.end();
    return req;
  }
}
