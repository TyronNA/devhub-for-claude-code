const http=require('node:http');

/** Hàng `tasks` của daemon, đúng như `/tasks` trả về. Chỉ khai những cột UI dùng tới. */
export interface PlannerTask {
  jira_key:string; status:string; summary?:string; plan_version?:number; confidence?:number;
  approved_plan_version?:number; affected_repos?:string[]; current_run_id?:number; last_error?:string;
  created_at?:number; updated_at?:number;
}
/** `payload` bên daemon là cột TEXT và API KHÔNG decode nó (chỉ task mới được decode). */
export interface PlannerEvent { id?:number; created_at?:number; jira_key?:string; kind:string; payload?:any; }

export function parsePayload(raw:any){
  if(raw&&typeof raw==='object')return raw;
  if(typeof raw!=='string'||!raw)return undefined;
  try{return JSON.parse(raw);}catch{return undefined;}
}

/**
 * HTTP client của agent-planner. Tách khỏi provider vì cây và các lệnh duyệt
 * cũng cần nói chuyện với daemon, mà chúng không có lượt chat nào để mượn.
 *
 * Không auth — chấp nhận được vì loopback, và CHỈ vì loopback.
 */
export class PlannerClient {
  constructor(public endpoint='http://127.0.0.1:7341', private timeoutMs=15000){}
  private url(p:string){return `${this.endpoint.replace(/\/$/,'')}${p}`;}

  /**
   * `onRequest` nhận chính `ClientRequest`: daemon không có endpoint huỷ, nên đường duy nhất
   * để một `cancel()` thoát khỏi `POST /chat` không hạn là destroy request từ bên ngoài.
   * Phải destroy KÈM error — `req.destroy()` trần không emit 'error', promise sẽ không settle.
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
    // 409 là câu trả lời THẬT của daemon (approve sai version, preflight từ chối), không
    // phải lỗi mạng — và `reason` nằm ở STATUS LINE, body thường rỗng. Bỏ nó đi là báo
    // "409:" trống trơn cho đúng cái câu duy nhất giải thích được chuyện gì xảy ra.
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
   * Lượt đã lưu của một hội thoại. Phiên sống nằm trong bộ nhớ daemon; đây là nửa BỀN, và là
   * đường duy nhất để đọc lại một reminder đã nổ lúc không có tab nào mở.
   */
  async messages(conversationId:string,limit=200){
    return (await this.json<{messages:Array<{role:string;text:string;created_at?:number}>}>(
      'GET',`/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`)).messages||[];
  }
  async refresh(key:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/refresh`,{},30000);}
  /** `plan_version` bắt buộc và daemon KHÔNG tự lấy version hiện tại — đừng mặc định hộ nó. */
  async approve(key:string,planVersion:number){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/approve`,{plan_version:planVersion});}
  async reject(key:string,reason:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/reject`,{reason});}
  /** Khác reject: reject đẩy về ANALYZING (deep-plan lại, $5-7). Dismiss kết thúc task, $0. */
  async dismiss(key:string,reason:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/dismiss`,{reason});}
  async revive(key:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/revive`,{});}
  /**
   * KHÔNG đặt hạn: `POST /execute` await CẢ lượt implement (`daemon.execute` -> `execute_task`),
   * tức tới 5 vòng fix, mỗi vòng một brain turn hạn 1200s. Hạn 120s của bản cũ báo lỗi giả
   * trong khi daemon vẫn đang ghi commit, và người dùng thấy lỗi thì bấm lại.
   */
  async execute(key:string){return this.json<PlannerTask>('POST',`/tasks/${encodeURIComponent(key)}/execute`,{},0);}
  async stopRun(runId:number){return this.json<any>('POST',`/runs/${runId}/stop`,{});}

  /** SSE bus dùng chung cho mọi client; caller tự lọc theo conversation_id. */
  stream(onChunk:(text:string)=>void,onOpen?:()=>void){
    const req=http.request(this.url('/stream'),{method:'GET'},(res:any)=>{
      res.setEncoding('utf8');res.on('data',onChunk);res.on('error',()=>{});onOpen?.();
    });
    req.on('error',()=>onOpen?.());   // không có stream vẫn chat được, chỉ mất phần chạy dở
    req.end();
    return req;
  }
}
