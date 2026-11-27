import { plannerConversationId, plannerSessionId, plannerEndpoint } from '../../sessions/plannerIdentity';
const crypto=require('node:crypto');
import { AgentProvider, ProviderTurnHandle, StartSessionInput, ResumeSessionInput } from '../provider';
import { DevHubEvent, DevHubSession } from '../../types';
import { PlannerClient, PlannerEvent } from './plannerClient';

/**
 * Provider cho agent-planner. Khác Claude ở một điểm: nó KHÔNG spawn
 * process nào. Con planner là daemon chạy 24/7 tự quét Jira, và provider này chỉ
 * nói HTTP với API loopback của nó (`make start` bên repo đó mới là thứ bật/tắt —
 * xem `devHub.agents`).
 *
 * Vì thế `AgentProvider` vừa khít: interface chỉ đòi một `AsyncIterable<DevHubEvent>`,
 * không giả định subprocess, nên panel + tree + mobileServer dùng lại được nguyên.
 */

const STREAM_OPEN_MS=2000;

/**
 * Dòng trắng phân cách frame có thể là CRLF/LF/CR — spec SSE cho cả ba, và một proxy chen
 * giữa daemon với đây có quyền đổi sang CRLF. Chỉ tìm '\n\n' là mất TRẮNG mọi frame.
 */
const SSE_SEP=/\r\n\r\n|\n\n|\r\r/;
export function sseFrames(buf:string):{frames:string[];rest:string}{
  const frames:string[]=[];let m:any;
  while((m=SSE_SEP.exec(buf))){frames.push(buf.slice(0,m.index));buf=buf.slice(m.index+m[0].length);}
  return {frames,rest:buf};
}

/** SSE: frame cách nhau bằng dòng trắng, `event:` là kind, `data:` là JSON một dòng. */
export function parseSseFrame(raw:string):{kind:string;data:any}|undefined{
  let kind='message';const data:string[]=[];
  for(const line of raw.split(/\r\n|\n|\r/)){
    if(line.startsWith('event:'))kind=line.slice(6).trim();
    else if(line.startsWith('data:'))data.push(line.slice(5).trim());
  }
  if(!data.length)return undefined;
  try{return {kind,data:JSON.parse(data.join('\n'))};}catch{return undefined;}
}

/**
 * Stream của planner đi bằng `assistant_view` (THAY THẾ) chứ không phải `assistant_delta`
 * (NỐI THÊM): `view` frame là một message bị daemon sửa tại chỗ, mỗi frame chứa toàn bộ
 * phần đã sinh cộng một đuôi trạng thái đổi theo giây (`\n\n_⏳ processing… 12s_`), nên nối
 * hai frame là nhân bản câu trả lời. Đuôi bị cắt ở đây — nó là chỉ báo chạy, không phải văn
 * bản, và `chat.js` đã có spinner riêng.
 */
const VIEW_SUFFIX=/\n*_(?:⏳|🛠️)[^\n]*_\s*$/;
export function stripViewSuffix(text:string){return String(text||'').replace(VIEW_SUFFIX,'').trimEnd();}

/** `task:KRP-1` -> `KRP-1`. Session nào không phải task thì không có key. */
export function taskKeyOf(nativeSessionId:string){
  nativeSessionId=plannerConversationId(nativeSessionId);
  return nativeSessionId.startsWith('task:')?nativeSessionId.slice(5):undefined;
}

/** Lịch sử chuyển trạng thái, gọn thành một dòng mỗi event cho hàng tool gập lại được. */
export function summarizeEvents(events:PlannerEvent[]):string{
  return events.map(e=>{
    const at=e.created_at?new Date(e.created_at*1000).toLocaleString():'';
    const p=e.payload||{};
    const detail=p.from&&p.to?`${p.from} → ${p.to}`
      :Object.keys(p).length?JSON.stringify(p).slice(0,120):'';
    return [at,e.kind,detail].filter(Boolean).join('  ');
  }).join('\n');
}

export class PlannerProvider implements AgentProvider {
  readonly id='planner' as any;
  readonly client:PlannerClient;
  private clients=new Map<string,PlannerClient>();
  private availableCache:{at:number;value:boolean}|undefined;
  constructor(private endpoint='http://127.0.0.1:7341',private timeoutMs=15000){
    this.client=new PlannerClient(endpoint,timeoutMs);this.clients.set(endpoint,this.client);
  }

  /** Ưu tiên endpoint trong ID nội bộ để đổi setting không chuyển hội thoại sang daemon khác. */
  clientFor(session?:DevHubSession){
    const ep=(session&&plannerEndpoint(session.nativeSessionId))||session?.plannerEndpoint||this.endpoint;
    let c=this.clients.get(ep);
    if(!c){c=new PlannerClient(ep,this.timeoutMs);this.clients.set(ep,c);}
    return c;
  }

  async isAvailable(){
    if(this.availableCache&&Date.now()-this.availableCache.at<15000)return this.availableCache.value;
    let value=false;
    try{await this.client.health();value=true;}catch{value=false;}
    this.availableCache={at:Date.now(),value};
    return value;
  }

  async start(input:StartSessionInput){return this.turn(input.prompt,`chat:${crypto.randomUUID()}`,this.client,this.endpoint);}
  async resume(input:ResumeSessionInput){return this.turn(input.prompt,plannerConversationId(input.session.nativeSessionId),this.clientFor(input.session),plannerEndpoint(input.session.nativeSessionId)||input.session.plannerEndpoint||this.endpoint);}

  /**
   * Một lượt chat. `/chat` chặn tới khi có câu trả lời cuối, còn text chạy dở đi qua
   * `/stream` — nên phải mở SSE TRƯỚC khi POST, không thì mất mấy frame đầu.
   * Chỉ lấy frame của đúng conversation này: `/stream` là bus chung cho mọi client.
   */
  private turn(prompt:string,conversationId:string,client:PlannerClient,endpoint:string):ProviderTurnHandle{
    const queue:DevHubEvent[]=[];let notify:(()=>void)|undefined;let done=false;let sawView=false;
    const push=(e:DevHubEvent)=>{queue.push(e);notify?.();};
    const now=()=>Date.now();
    let stream:any;let chatReq:any;let cancelled=false;

    const openStream=()=>new Promise<void>((resolve)=>{
      let buf='';
      stream=client.stream((chunk:string)=>{
        buf+=chunk;
        const batch=sseFrames(buf);buf=batch.rest;
        for(const raw of batch.frames){
          const frame=parseSseFrame(raw);
          if(!frame||frame.data?.conversation_id!==conversationId)continue;
          if(frame.kind==='view'){
            const text=stripViewSuffix(frame.data?.payload?.text);
            // Frame đầu tiên thường chỉ có đuôi trạng thái: bỏ nó đi thì còn chuỗi rỗng,
            // mà một bong bóng rỗng đọc ra như câu trả lời đã xong mà không có gì.
            if(text){sawView=true;push({type:'assistant_view',text,timestamp:now()});}
            continue;
          }
          if(frame.kind==='permission'){
            // CONFIRM_TOOLS bên planner đang rỗng nên đường này chưa chạy; báo ra
            // thay vì bỏ im, vì không có UI trả lời thì tool sẽ timeout thành Deny.
            push({type:'warning',message:`agent asked for permission (${frame.data?.payload?.req_id||'?'}) and nothing here can answer it`,timestamp:now()});
          }
        }
      },()=>resolve());
    });

    const run=async()=>{
      // KHÔNG phát `user_message` ở đây: `SessionManager.start/resume` đã phát nó cho MỌI
      // provider trước khi consume handle. Claude cũng không tự phát — thêm vào là
      // bong bóng câu hỏi hiện hai lần.
      // Mở SSE trước, nhưng KHÔNG chờ mãi: header của /stream chỉ tới khi server flush, và
      // một server không flush sẽ treo cả lượt chat. Quá hạn thì chat tiếp, chỉ mất `permission`.
      await Promise.race([openStream(),new Promise<void>(r=>{const t:any=setTimeout(r,STREAM_OPEN_MS);t?.unref?.();})]);
      try{
        // Không đặt timeout: một lượt có gọi tool chạy vài phút là bình thường.
        const res=await client.json<{reply:string;conversation_id:string}>(
          'POST','/chat',{message:prompt,conversation_id:conversationId},0,(r:any)=>{chatReq=r;});
        // Đã stream thì câu trả lời cuối phải GHI ĐÈ bong bóng đó, y như Claude không phát
        // `assistant_message` khi đã có delta — phát thêm một message là in câu trả lời hai lần.
        push({type:sawView?'assistant_view':'assistant_message',text:String(res?.reply||''),timestamp:now()});
      }catch(e:any){
        // Sau `cancel()` thì lỗi ở đây là do chính mình destroy request; báo ra là một bong bóng
        // lỗi giả ngay sau khi người dùng bấm Stop.
        if(!cancelled)push({type:'error',message:String(e?.message||e),timestamp:now()});
      }finally{
        push({type:'turn_done',timestamp:now()});
        done=true;stream?.destroy?.();notify?.();
      }
    };

    const events=(async function*():AsyncIterable<DevHubEvent>{
      const task=run();
      while(true){
        while(queue.length)yield queue.shift()!;
        if(done)break;
        await new Promise<void>(r=>{notify=r;});
        notify=undefined;
      }
      while(queue.length)yield queue.shift()!;
      await task.catch(()=>{});
    })();

    // Cancel KHÔNG dừng được lượt của daemon (không có endpoint huỷ), nhưng PHẢI cắt request:
    // `/chat` không có hạn, nên còn await nó là `waitForIdle()` — tức deactivate/reload — treo
    // đúng bằng thời gian daemon chạy. Nói thẳng ra thay vì để UI khoe "cancelled" trong khi
    // daemon vẫn chạy.
    return {events,cancel:async()=>{
              cancelled=true;
              push({type:'warning',message:'Dev Hub stopped listening, but the daemon keeps running this turn — there is no cancel on its API.',timestamp:now()});
              done=true;stream?.destroy?.();chatReq?.destroy?.(new Error('cancelled'));notify?.();},
            getNativeSessionId:()=>plannerSessionId(endpoint,conversationId)};
  }

  /** Lượt đã lưu của hội thoại -> event. Reminder nổ lúc panel đóng chỉ còn ở đây. */
  private async storedTurns(session:DevHubSession):Promise<DevHubEvent[]>{
    try{
      const rows=await this.clientFor(session).messages(plannerConversationId(session.nativeSessionId));
      return rows.map(m=>{
        const timestamp=Number(m.created_at)>0?Math.round(Number(m.created_at)*1000):Date.now();
        return m.role==='user'
          ?{type:'user_message',text:String(m.text||''),timestamp} as DevHubEvent
          :{type:'assistant_message',text:String(m.text||''),timestamp} as DevHubEvent;
      });
    }catch{
      // Daemon cũ không có endpoint này. Thiếu lịch sử không đáng chặn plan.
      return [];
    }
  }

  /**
   * Rỗng CÓ CHỦ Ý. Task inbox không phải "lịch sử trên đĩa": nó là trạng thái sống, và
   * `workspaceId/projectId` là khái niệm của DevHub mà daemon không có — bản cũ phải gán
   * bừa `projects[0]`, khiến task của daemon chui vào project đầu tiên của cây và cả Recent.
   * Giờ hàng task do cây dựng dưới Agents (`agents/plannerTasks.ts`) và chỉ được ghi vào
   * store khi người dùng thật sự mở nó.
   */
  async discoverHistory():Promise<DevHubSession[]>{return [];}

  /**
   * Transcript = lượt đã lưu của hội thoại, rồi (với một task) lịch sử trạng thái + plan hiện
   * tại ở cuối. Trạng thái mới nhất nằm dưới cùng, đúng chỗ mắt nhìn tới.
   */
  async loadTranscript(session:DevHubSession):Promise<DevHubEvent[]>{
    const key=taskKeyOf(session.nativeSessionId);
    const out:DevHubEvent[]=await this.storedTurns(session);
    if(!key)return out;
    const at=session.updatedAt||Date.now();
    const client=this.clientFor(session);
    try{
      const history=await client.events(key,30);
      if(history.length)out.push({type:'tool_completed',tool:'planner',
        label:`${key} · ${history.length} events`,summary:summarizeEvents(history),timestamp:at-1});
    }catch{/* lịch sử thiếu không đáng chặn plan */}
    try{
      const plan=await client.plan(key);
      out.push({type:'assistant_message',
                text:`**${key} — plan v${plan.current_version??'?'}**\n\n${plan.plan_markdown||'_(empty)_'}`,
                timestamp:at});
    }catch{
      // Chưa có plan là trạng thái bình thường (mới quét thấy), không phải lỗi.
      out.push({type:'warning',message:`no plan stored for ${key} yet`,timestamp:at});
    }
    return out;
  }
}
