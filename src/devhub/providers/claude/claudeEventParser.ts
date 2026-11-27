import { DevHubEvent } from '../../types';
const nodePath=require('node:path');
const os=require('node:os');
const fsSync=require('node:fs');
const crypto=require('node:crypto');

function now(){return Date.now();}
function labelTool(name:string,input:any){ if(!input) return name;
  // Sub-agent của Claude (`Agent`, tên cũ `Task`): input KHÔNG có path/command/query nào, nên
  // nhãn rơi về đúng tên tool và dòng đọc ra "Agent (Agent)" — hai lần spawn khác nhau trông y
  // hệt. `description` + loại agent mới là thứ phân biệt được.
  if(name==='Agent'||name==='Task'){
    const what=String(input.description||'').trim();
    const kind=String(input.subagent_type||'').trim();
    return [what,kind&&`(${kind})`].filter(Boolean).join(' ')||name;
  }
  return input.file_path || input.path || input.command || input.query || name; }
function resultText(content:any):string|undefined {
  if(typeof content==='string') return content.slice(0,65536);
  if(Array.isArray(content)){
    const text=content.map((x:any)=>typeof x==='string'?x:(x?.text ?? x?.content ?? '')).filter(Boolean).join('\n');
    return text ? text.slice(0,65536) : undefined;
  }
  if(content && typeof content==='object'){
    try{return JSON.stringify(content).slice(0,65536);}catch{return undefined;}
  }
}
/**
 * Ảnh trong `tool_result` (screenshot Playwright, Read file PNG) về dạng block base64; `resultText`
 * chỉ nhặt chữ nên trước đây ảnh rơi mất và agent chụp xong người dùng không thấy gì.
 *
 * Ghi ra file thay vì giữ data: URI. Data URI đi nguyên trong `sessionSelected` — một gói SSE/
 * postMessage duy nhất gửi lại MỖI lần mở tab hay nối lại: transcript playtest đo được 8–10 MB
 * base64 trong 16 MB đuôi, điện thoại tải + giải mã hết trước khi vẽ dòng đầu. Có `path` thì host
 * đổi sang URL (`asWebviewUri` / `/api/file`), `<img loading=lazy>` chỉ tải ảnh đang hiện và
 * trình duyệt cache được. Tên = sha1 nội dung ⇒ đọc lại transcript không ghi thêm file nào; tmp bị
 * dọn thì lần parse sau ghi lại. Ghi lỗi thì lùi về data: URI như cũ.
 */
const MAX_IMAGE_B64=12*1024*1024;
const IMAGE_EXT:Record<string,string>={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'};
/** Phải nằm dưới `localMediaRoots()` (tmp) để cả panel lẫn `/api/file` chịu phục vụ. */
export function toolImageDir(){return nodePath.join(os.tmpdir(),'devhub-tool-images');}
function spillImage(dir:string|null,mime:string,data:string):string|undefined{
  if(!dir)return undefined;
  try{
    const file=nodePath.join(dir,crypto.createHash('sha1').update(data).digest('hex')+IMAGE_EXT[mime]);
    if(!fsSync.existsSync(file)){
      fsSync.mkdirSync(dir,{recursive:true});
      // Ghi tạm rồi rename: hai tab parse cùng transcript không để lộ file ghi dở cho <img>.
      const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
      fsSync.writeFileSync(tmp,Buffer.from(data,'base64'));fsSync.renameSync(tmp,file);
    }
    return file;
  }catch{return undefined;}
}
function resultImages(content:any,dir:string|null):{src?:string;path?:string}[]{
  if(!Array.isArray(content))return [];
  return content.flatMap((x:any)=>{const src=x?.type==='image'?x.source:undefined;const mime=String(src?.media_type||'').toLowerCase();
    if(src?.type!=='base64'||!/^image\/(png|jpeg|gif|webp)$/.test(mime)||typeof src.data!=='string'||!src.data||src.data.length>MAX_IMAGE_B64||!/^[A-Za-z0-9+/=]+$/.test(src.data))return [];
    const path=spillImage(dir,mime,src.data);
    return [path?{path}:{src:`data:${mime};base64,${src.data}`}];});
}
function isShellTool(name:string){const n=name.toLowerCase();return n==='bash'||n.includes('shell');}
/** tool_result của Bash mở đầu bằng "Exit code N" khi lệnh fail; `is_error` chỉ nói có/không. */
function exitCodeFrom(text:string|undefined):number{const m=/^Exit code (\d+)/m.exec(text||'');return m?Number(m[1]):1;}
function fileChangeForTool(name:string):'add'|'modify'|'delete'|undefined {
  const n=name.toLowerCase();
  if(n==='write' || n.includes('create')) return 'add';
  if(n==='edit' || n.includes('patch') || n.includes('replace')) return 'modify';
  if(n.includes('delete') || n.includes('remove')) return 'delete';
}
/**
 * Dòng tiến trình của một sub-agent chạy nền. Con chạy hàng phút mà `tool_result` của nó đã
 * trả về ngay từ giây đầu, nên đây là thứ DUY NHẤT nhúc nhích trên dòng `Agent` trong lúc chờ.
 */
export function taskProgressSummary(raw:any):string|undefined{
  const u=raw?.usage||{};const bits:string[]=[];
  if(raw?.subagent_type)bits.push(String(raw.subagent_type));
  const n=Number(u.tool_uses); if(Number.isFinite(n)&&n>0)bits.push(`${n} tool call${n>1?'s':''}`);
  if(raw?.last_tool_name)bits.push(`last: ${raw.last_tool_name}`);
  const ms=Number(u.duration_ms); if(Number.isFinite(ms)&&ms>0)bits.push(`${Math.round(ms/1000)}s`);
  return bits.length?bits.join(' \u00b7 '):undefined;
}
interface PendingTool {name:string;label:string;command?:string;filePath?:string;change?:'add'|'modify'|'delete';}

export class ClaudeEventParser {
  /** `null` = giữ data: URI (test không đụng đĩa). Không dùng `undefined`: nó kích hoạt lại giá trị mặc định. */
  constructor(private imageDir:string|null=toolImageDir()){}
  private pending=new Map<string,PendingTool>();
  private sawTextDelta=false;
  /** Tool đã dựng dòng từ `content_block_start`; `assistant` sau đó chỉ bổ sung tham số. */
  private announced=new Set<string>();
  /**
   * `tool_use_id` của các lượt gọi đã bị đẩy xuống nền (sub-agent). `tool_result` của chúng về
   * NGAY với một mẩu metadata nội bộ ("Async agent launched successfully…") chứ không phải kết
   * quả — đóng dòng bằng nó là khoe "xong" trong khi con mới bắt đầu chạy. Kết quả thật tới sau
   * ở `task_notification`.
   */
  private backgrounded=new Set<string>();
  /** Message id đã neo mốc cache: `assistant` lặp lại mỗi content block của cùng một message. */
  private cacheMsg:string|undefined;

  /**
   * Mốc prompt cache, theo đúng cách extension chính thức tính: request chạm cache (đọc hoặc
   * ghi) làm mới TTL, nên đồng hồ tính từ lúc request đó bắt đầu — `message_start` là tín hiệu
   * sớm nhất ta thấy. TTL đọc từ `cache_creation.ephemeral_1h/5m`; lượt chỉ đọc cache không nói
   * TTL nên để trống, merge giữ giá trị cũ.
   */
  private cacheMark(id:any,u:any,t:number,out:DevHubEvent[]){
    if(!u||typeof u!=='object')return;
    const key=id?String(id):undefined; if(key&&key===this.cacheMsg)return;
    const read=Number(u.cache_read_input_tokens)||0,write=Number(u.cache_creation_input_tokens)||0;
    if(read+write<=0)return;
    this.cacheMsg=key;
    const cc=u.cache_creation||{};
    const ttl=(Number(cc.ephemeral_1h_input_tokens)||0)>0?3600000:(Number(cc.ephemeral_5m_input_tokens)||0)>0?300000:undefined;
    // Không gửi key `undefined`: webview gộp bằng Object.assign, key rỗng sẽ xoá TTL đã biết.
    const usage:any={cacheAnchorAt:t,cacheTokens:(Number(u.input_tokens)||0)+read+write};if(ttl)usage.cacheTtlMs=ttl;
    out.push({type:'usage',usage,timestamp:t});
  }

  parse(raw:any):DevHubEvent[]{
    const out:DevHubEvent[]=[]; const t=now(); if(!raw||typeof raw!=='object') return out;
    /**
     * Sub-agent nền: CLI đổ CẢ stream của con ra cùng stdout, chỉ đánh dấu bằng
     * `parent_tool_use_id`. Trộn thẳng vào dòng chính là hai lỗi một lúc — lời của con đọc ra
     * như lời của cha, và mỗi dòng tool của con CẮT ĐÔI bong bóng cha đang stream giữa chừng
     * (delta chỉ nối tiếp được khi bong bóng còn là phần tử cuối). Tiến trình của con đi qua
     * `task_*` bên dưới, gói trong ĐÚNG dòng `Agent` đã sinh ra nó.
     */
    if(raw.parent_tool_use_id) return out;
    /**
     * Lượt CLI tự chèn ("Continue from where you left off." lúc nối lại lượt bị cắt) được trả
     * lời bằng một hàng `<synthetic>` "No response requested.". 0.29.52 đã loại nửa user, nửa
     * assistant còn lại vẫn vẽ ra như lời agent — mở lại tab thì đọc y như câu vừa gửi bị chặn.
     * Lỗi THẬT cũng là `<synthetic>` (rate limit, 402, 529, mất mạng) nhưng luôn mang
     * `isApiErrorMessage`, và những cái đó PHẢI hiện. Khảo sát toàn bộ `~/.claude/projects`:
     * 135 hàng synthetic, 116 hàng không có cờ đó đều đúng một câu này, không ngoại lệ.
     * Phải khớp đúng câu: output lệnh local (`/context`, `/usage`…) trên stream-json cũng là
     * `<synthetic>` không cờ lỗi — khảo sát transcript không thấy vì file không ghi hàng đó.
     */
    if(raw.type==='assistant'&&raw.message?.model==='<synthetic>'&&!raw.isApiErrorMessage&&isNoResponseGhost(raw.message?.content)) return out;
    if(raw.type==='assistant'){
      this.cacheMark(raw.message?.id,raw.message?.usage,t,out);
      const c=raw.message?.content;
      if(Array.isArray(c)) for(const part of c){
        /**
         * Từ Opus 5.5 (như Fable 5.1), câu báo tiến độ giữa các tool call — đúng câu mà
         * `appendSystemPrompt` xin — về dưới dạng `thinking` CÓ chữ, không phải `text`. Bỏ qua
         * như cũ thì lượt lại câm giữa các dòng tool. Suy luận thật vẫn bị API bịt (chuỗi rỗng),
         * nên có chữ = câu viết cho người đọc. Luôn đứng riêng một hàng `assistant`, không delta.
         */
        if(part?.type==='thinking'&&typeof part.thinking==='string'&&part.thinking.trim()){
          out.push({type:'assistant_message',text:part.thinking.trim(),timestamp:t});
        }
        if(part?.type==='text'&&part.text){
          if(!this.sawTextDelta) out.push({type:'assistant_message',text:String(part.text),timestamp:t});
        }
        if(part?.type==='tool_use'){
          const name=String(part.name||'tool'); const label=String(labelTool(name,part.input)); const id=String(part.id||part.tool_use_id||'');
          const pending:PendingTool={name,label,command:part.input?.command,filePath:part.input?.file_path||part.input?.path,change:fileChangeForTool(name)};
          if(id) this.pending.set(id,pending);
          if(isShellTool(name)) out.push({type:'command_started',command:String(pending.command||label),callId:id||undefined,timestamp:t});
          else out.push({type:'tool_started',tool:name,label,callId:id||undefined,timestamp:t});
        }
      }
      this.sawTextDelta=false;
    } else if(raw.type==='stream_event'){
      const event=raw.event||{}; const delta=event.delta;
      if(event.type==='message_start')this.cacheMark(event.message?.id,event.message?.usage,t,out);
      if(delta?.type==='text_delta'&&delta.text){ this.sawTextDelta=true; out.push({type:'assistant_delta',text:String(delta.text),timestamp:t}); }
      // Tham số tool stream ra từng token, nên `assistant` tới SAU khi model viết xong lệnh
      // (đo được 1,2s với lệnh ngắn, lâu hơn với heredoc). Dựng dòng ngay ở block_start;
      // `assistant` phát lại cùng callId để điền tham số vào đúng dòng đó.
      const cb=event.type==='content_block_start'?event.content_block:undefined;
      if(cb?.type==='tool_use'&&cb.id&&!this.announced.has(String(cb.id))){
        const id=String(cb.id); const name=String(cb.name||'tool'); this.announced.add(id);
        if(isShellTool(name)) out.push({type:'command_started',command:'',callId:id,timestamp:t});
        else out.push({type:'tool_started',tool:name,label:'',callId:id,timestamp:t});
      }
    } else if(raw.type==='user'){
      const content=raw.message?.content;
      if(Array.isArray(content)) for(const part of content){
        if(part?.type!=='tool_result') continue;
        const id=String(part.tool_use_id||part.id||'');
        if(id&&this.backgrounded.has(id))continue;   // giữ pending lại cho `task_notification`
        const pending=id?this.pending.get(id):undefined; const summary=resultText(part.content); const isError=part.is_error===true;
        if(pending?.command){
          out.push({type:'command_completed',command:pending.command,output:summary,exitCode:isError?exitCodeFrom(summary):undefined,callId:id||undefined,timestamp:t});
        } else {
          out.push({type:'tool_completed',tool:pending?.name||'tool',label:pending?.label||'Tool result',summary,callId:id||undefined,timestamp:t});
          if(pending?.filePath && pending.change && !isError) out.push({type:'file_changed',path:pending.filePath,change:pending.change,timestamp:t});
        }
        for(const img of resultImages(part.content,this.imageDir))out.push({type:'assistant_image',...img,alt:pending?.label||pending?.name||'Tool image',timestamp:t});
        if(id){ this.pending.delete(id); this.announced.delete(id); }
      }
    } else if(raw.type==='system'&&raw.subtype==='init'){
      if(typeof raw.model==='string'&&raw.model)out.push({type:'usage',usage:{model:raw.model},timestamp:t});
    } else if(raw.type==='system'&&raw.subtype==='thinking_tokens'){
      // Nội dung thinking của Opus bị bịt (chuỗi rỗng + signature), số token ước lượng là
      // tín hiệu sống DUY NHẤT trong lúc model nghĩ. Giá trị là tuyệt đối, không cộng dồn.
      const n=Number(raw.estimated_tokens);
      if(Number.isFinite(n)&&n>0) out.push({type:'thinking',tokens:n,timestamp:t});
    } else if(raw.type==='system'&&raw.subtype==='status'){
      // `/compact` chỉ báo qua đây; bỏ qua thì người dùng bấm xong không thấy gì.
      if(raw.status==='compacting')out.push({type:'tool_started',tool:'Compact',label:'compacting the conversation\u2026',timestamp:t} as DevHubEvent);
      else if(raw.compact_result==='failed')out.push({type:'error',message:`Compact failed: ${String(raw.compact_error||'unknown reason')}`,timestamp:t});
      else if(raw.compact_result){out.push({type:'tool_completed',tool:'Compact',label:String(raw.compact_result),
        summary:raw.pre_tokens&&raw.post_tokens?`${raw.pre_tokens} \u2192 ${raw.post_tokens} tokens`:undefined,timestamp:t} as DevHubEvent);
        // Prefix đã đổi hẳn: cache cũ không còn khớp dù chưa hết giờ, lượt kế ghi lại từ đầu.
        if(raw.compact_result==='success'){this.cacheMsg=undefined;out.push({type:'usage',usage:{cacheAnchorAt:0},timestamp:t});}}
    } else if(raw.type==='system'&&(raw.subtype==='task_started'||raw.subtype==='task_progress'||raw.subtype==='task_notification')){
      // Lượt gọi nền là đường DUY NHẤT có output: `tool_result` của nó chỉ là biên nhận.
      const id=String(raw.tool_use_id||'');
      // Chỉ nhận task của CHÍNH tiến trình này. Một `task_notification` còn sót từ phiên trước
      // (CLI báo lại lúc resume) không có dòng nào để bám: dựng dòng mới cho nó là chèn ngang
      // vào giữa đoạn đang stream — đúng cái bệnh vừa chữa — mà nhãn cũng chỉ đoán được ra 'Agent'.
      if(!id||!(this.pending.has(id)||this.backgrounded.has(id)))return out;
      const pending=this.pending.get(id);
      const tool=pending?.name||(raw.task_type==='local_agent'?'Agent':'Task');
      const label=String(raw.description||pending?.label||tool);
      if(raw.subtype==='task_notification'){
        this.backgrounded.delete(id);this.pending.delete(id);this.announced.delete(id);
        const status=String(raw.status||'');
        const parts=[status&&status!=='completed'?`[${status}]`:'',String(raw.summary||'').trim(),
                     raw.output_file?`(full output: ${raw.output_file})`:''].filter(Boolean);
        out.push({type:'tool_completed',tool,label,summary:parts.join('\n\n')||undefined,callId:id,timestamp:t});
        return out;
      }
      this.backgrounded.add(id);
      out.push({type:'tool_started',tool,label,summary:taskProgressSummary(raw),callId:id,timestamp:t});
    } else if(raw.type==='result'){
      this.announced.clear();
      const usage=raw.usage || raw.message?.usage;
      if(usage || raw.total_cost_usd!==undefined) out.push({type:'usage',usage:{
        inputTokens:usage?.input_tokens,
        outputTokens:usage?.output_tokens,
        cachedInputTokens:usage?.cached_input_tokens ?? usage?.cache_read_input_tokens,
        cacheWriteInputTokens:usage?.cache_write_input_tokens ?? usage?.cache_creation_input_tokens,
        reasoningOutputTokens:usage?.reasoning_output_tokens,
        contextUsedTokens:usage?.context_used_tokens ?? deriveContext(raw).used,
        contextWindowTokens:usage?.context_window_tokens ?? deriveContext(raw).window,
        costUsd:raw.total_cost_usd
      },timestamp:t});
      if(raw.is_error || raw.subtype==='error') out.push({type:'error',message:String(raw.error||raw.result||'Claude turn failed'),timestamp:t}); else out.push({type:'turn_done',timestamp:t});
    } else if(raw.type==='error') out.push({type:'error',message:String(raw.error?.message||raw.message||'Claude error'),timestamp:t});
    return out;
  }
}

function isNoResponseGhost(c:any):boolean{
  const parts=Array.isArray(c)?c:[{type:'text',text:c}];
  return parts.every((x:any)=>x?.type==='text'&&String(x.text||'').trim()==='No response requested.');
}

/**
 * `result` không có context_used/window. `modelUsage` thì có `contextWindow` mỗi model —
 * lấy model có cửa sổ lớn nhất (model chính, không phải haiku phụ trợ) và cộng phần prompt
 * đã gửi để ước lượng mức dùng. Là XẤP XỈ, không phải số CLI công bố.
 */
export function deriveContext(raw:any):{used?:number;window?:number}{
  const mu=raw?.modelUsage; if(!mu||typeof mu!=='object')return {};
  let best:any,window=0;
  for(const m of Object.values<any>(mu)){const w=Number(m?.contextWindow)||0;if(w>window){window=w;best=m;}}
  if(!best||!window)return {};
  // Một lượt có thể gọi API nhiều vòng; CỘNG DỒN các vòng sẽ vượt cửa sổ (thấy 283%).
  // Context thực là prompt của vòng CUỐI, nên ưu tiên `usage.iterations`.
  const it=raw?.usage?.iterations;
  const last=Array.isArray(it)&&it.length?it[it.length-1]:undefined;
  const src=last?{i:last.input_tokens,r:last.cache_read_input_tokens,c:last.cache_creation_input_tokens}
                :{i:best.inputTokens,r:best.cacheReadInputTokens,c:best.cacheCreationInputTokens};
  let used=(Number(src.i)||0)+(Number(src.r)||0)+(Number(src.c)||0);
  if(used>window)used=window;   // chặn trần: hiển thị >100% là vô nghĩa
  return {used:used||undefined,window};
}

export function parseClaudeEvent(raw:any):DevHubEvent[]{ return new ClaudeEventParser().parse(raw); }
export function extractClaudeSessionId(raw:any):string|undefined { return raw?.session_id || raw?.sessionId || raw?.message?.session_id || (raw?.type==='system'&&raw?.subtype==='init'?raw?.session_id:undefined); }
