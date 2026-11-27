import { plannerConversationId, plannerSessionId, plannerEndpoint } from '../../sessions/plannerIdentity';
const crypto=require('node:crypto');
import { AgentProvider, ProviderTurnHandle, StartSessionInput, ResumeSessionInput } from '../provider';
import { DevHubEvent, DevHubSession } from '../../types';
import { PlannerClient, PlannerEvent } from './plannerClient';

/**
 * Provider for agent-planner. It differs from Claude in one way: it does NOT spawn
 * any process. The planner is a 24/7 daemon that scans Jira by itself, and this provider only
 * speaks HTTP to its loopback API (`make start` in that repo is what turns it on/off —
 * see `devHub.agents`).
 *
 * That's why `AgentProvider` fits exactly: the interface only asks for an `AsyncIterable<DevHubEvent>`,
 * with no subprocess assumption, so panel + tree + mobileServer are reused unchanged.
 */

const STREAM_OPEN_MS=2000;

/**
 * The blank line separating frames can be CRLF/LF/CR — the SSE spec allows all three, and a proxy between
 * the daemon and here may switch to CRLF. Searching only for '\n\n' loses EVERY frame.
 */
const SSE_SEP=/\r\n\r\n|\n\n|\r\r/;
export function sseFrames(buf:string):{frames:string[];rest:string}{
  const frames:string[]=[];let m:any;
  while((m=SSE_SEP.exec(buf))){frames.push(buf.slice(0,m.index));buf=buf.slice(m.index+m[0].length);}
  return {frames,rest:buf};
}

/** SSE: frames separated by a blank line, `event:` is the kind, `data:` is one-line JSON. */
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
 * The planner streams via `assistant_view` (REPLACE), not `assistant_delta`
 * (APPEND): a `view` frame is a message the daemon edits in place, each frame holds everything
 * generated so far plus a status tail that changes every second (`\n\n_⏳ processing… 12s_`), so appending
 * two frames duplicates the answer. The tail is cut here — it is a running indicator, not
 * text, and `chat.js` already has its own spinner.
 */
const VIEW_SUFFIX=/\n*_(?:⏳|🛠️)[^\n]*_\s*$/;
export function stripViewSuffix(text:string){return String(text||'').replace(VIEW_SUFFIX,'').trimEnd();}

/** `task:KRP-1` -> `KRP-1`. A session that isn't a task has no key. */
export function taskKeyOf(nativeSessionId:string){
  nativeSessionId=plannerConversationId(nativeSessionId);
  return nativeSessionId.startsWith('task:')?nativeSessionId.slice(5):undefined;
}

/** State transition history, one line per event so the tool row can fold. */
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

  /** Prefer the endpoint in the internal ID so a settings change doesn't move the conversation to another daemon. */
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
   * One chat turn. `/chat` blocks until the final answer, while in-progress text goes through
   * `/stream` — so SSE must be opened BEFORE the POST, or the first frames are lost.
   * Only take frames of this exact conversation: `/stream` is a bus shared by every client.
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
            // The first frame often holds only the status tail: stripping it leaves an empty string,
            // and an empty bubble reads as an answer that finished with nothing in it.
            if(text){sawView=true;push({type:'assistant_view',text,timestamp:now()});}
            continue;
          }
          if(frame.kind==='permission'){
            // The planner's CONFIRM_TOOLS is empty so this path doesn't run yet; report it
            // rather than drop it silently, because with no UI to answer the tool would time out as Deny.
            push({type:'warning',message:`agent asked for permission (${frame.data?.payload?.req_id||'?'}) and nothing here can answer it`,timestamp:now()});
          }
        }
      },()=>resolve());
    });

    const run=async()=>{
      // Do NOT emit `user_message` here: `SessionManager.start/resume` already emits it for EVERY
      // provider before consuming the handle. Claude doesn't emit it itself either — adding it here makes
      // the question bubble show twice.
      // Open SSE first, but DON'T wait forever: /stream's headers only arrive when the server flushes, and
      // a server that doesn't flush would hang the whole chat turn. Past the deadline, chat on and only lose `permission`.
      await Promise.race([openStream(),new Promise<void>(r=>{const t:any=setTimeout(r,STREAM_OPEN_MS);t?.unref?.();})]);
      try{
        // No timeout: a turn that calls tools running for minutes is normal.
        const res=await client.json<{reply:string;conversation_id:string}>(
          'POST','/chat',{message:prompt,conversation_id:conversationId},0,(r:any)=>{chatReq=r;});
        // Once streamed, the final answer must OVERWRITE that bubble, just as Claude doesn't emit
        // `assistant_message` once there were deltas — emitting another message prints the answer twice.
        push({type:sawView?'assistant_view':'assistant_message',text:String(res?.reply||''),timestamp:now()});
      }catch(e:any){
        // After `cancel()` an error here comes from destroying our own request; reporting it gives a fake error
        // bubble right after the user pressed Stop.
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

    // Cancel CAN'T stop the daemon's turn (there is no cancel endpoint), but it MUST cut the request:
    // `/chat` has no deadline, so still awaiting it makes `waitForIdle()` — i.e. deactivate/reload — hang
    // for exactly as long as the daemon runs. Say so plainly instead of letting the UI show "cancelled" while
    // the daemon keeps running.
    return {events,cancel:async()=>{
              cancelled=true;
              push({type:'warning',message:'Dev Hub stopped listening, but the daemon keeps running this turn — there is no cancel on its API.',timestamp:now()});
              done=true;stream?.destroy?.();chatReq?.destroy?.(new Error('cancelled'));notify?.();},
            getNativeSessionId:()=>plannerSessionId(endpoint,conversationId)};
  }

  /** A conversation's saved turns -> events. A reminder that fired while the panel was closed only lives here. */
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
      // Old daemons lack this endpoint. Missing history isn't worth blocking the plan.
      return [];
    }
  }

  /**
   * Empty ON PURPOSE. The task inbox isn't "history on disk": it is live state, and
   * `workspaceId/projectId` are Dev Hub concepts the daemon doesn't have — the old version had to assign
   * `projects[0]` arbitrarily, which put the daemon's tasks into the tree's first project and into Recent.
   * Now task rows are built by the tree under Agents (`agents/plannerTasks.ts`) and only written to the
   * store when the user actually opens one.
   */
  async discoverHistory():Promise<DevHubSession[]>{return [];}

  /**
   * Transcript = the conversation's saved turns, then (for a task) the state history + the current plan
   * at the end. The newest state is at the bottom, right where the eye lands.
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
    }catch{/* missing history isn't worth blocking the plan */}
    try{
      const plan=await client.plan(key);
      out.push({type:'assistant_message',
                text:`**${key} — plan v${plan.current_version??'?'}**\n\n${plan.plan_markdown||'_(empty)_'}`,
                timestamp:at});
    }catch{
      // No plan yet is a normal state (just discovered), not an error.
      out.push({type:'warning',message:`no plan stored for ${key} yet`,timestamp:at});
    }
    return out;
  }
}
