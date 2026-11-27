import { PlannerClient } from './plannerClient';
import { parseSseFrame, sseFrames } from './plannerProvider';

/**
 * A session-long SSE to the planner daemon — the missing piece that lets the daemon speak FIRST.
 *
 * `PlannerProvider` also opens `/stream`, but only DURING a turn and only to listen for `permission`;
 * it closes when the turn ends. So a self-firing reminder (the daemon waking itself, `planner/reminders.py`)
 * had no way to reach the UI. This keeps the pipe open when no turn is running.
 *
 * Only reads `reminder_fired` frames, ON PURPOSE: `view` is a message edited in place (see
 * `plannerProvider`), appending gives a garbage string, and `message` only carries a "⏳" placeholder. The full
 * answer is in the `reminder_fired` payload.
 */

export interface PlannerReminderPush {
  endpoint:string; conversationId:string; reminderId?:number;
  note:string; jiraKey?:string; reply:string; movedFrom?:string; movedTo?:string;
}

/** Reconnect after a drop: a daemon restart (`make restart`) is an everyday thing. */
const RETRY_MS=[1000,2000,5000,15000,30000];

export class PlannerWatcher {
  private conns=new Map<string,{req:any;timer:any;tries:number;closed:boolean;down:boolean}>();
  private disposed=false;
  constructor(private onReminder:(push:PlannerReminderPush)=>void,private log?:(line:string)=>void){}

  /** The endpoint list is the source of truth: call again when settings change; missing ones get closed. */
  watch(endpoints:string[]){
    if(this.disposed)return;
    const wanted=new Set(endpoints.filter(Boolean));
    for(const ep of [...this.conns.keys()])if(!wanted.has(ep))this.close(ep);
    for(const ep of wanted)if(!this.conns.has(ep))this.open(ep);
  }

  dispose(){this.disposed=true;for(const ep of [...this.conns.keys()])this.close(ep);}

  private close(ep:string){
    const c=this.conns.get(ep); if(!c)return;
    c.closed=true;clearTimeout(c.timer);try{c.req?.destroy?.();}catch{}
    this.conns.delete(ep);
  }

  private open(ep:string){
    const state={req:undefined as any,timer:undefined as any,tries:0,closed:false,down:false};
    this.conns.set(ep,state);
    const connect=()=>{
      if(this.disposed||state.closed)return;
      let buf='';
      const client=new PlannerClient(ep);
      // No timeout on `/stream`: a pipe silent for 25s is normal (the daemon's
      // heartbeat), and `request({timeout})` would cut it.
      state.req=client.stream((chunk:string)=>{
        state.tries=0;
        // Log STATE TRANSITIONS, not every attempt: with the daemon fully off, a retry every 30s
        // goes on forever, and a line each time would drown every other log line of the extension.
        if(state.down){state.down=false;this.log?.(`planner watch ${ep} reconnected`);}
        buf+=chunk;
        const batch=sseFrames(buf);buf=batch.rest;
        for(const raw of batch.frames){
          const frame=parseSseFrame(raw);
          if(frame?.kind!=='reminder_fired')continue;
          const d=frame.data||{},p=d.payload||{},moved=Array.isArray(p.moved)?p.moved:undefined;
          const conversationId=String(d.conversation_id||'');
          if(!conversationId)continue;
          this.onReminder({endpoint:ep,conversationId,reminderId:Number(p.reminder_id)||undefined,
            note:String(p.note||''),jiraKey:p.jira_key?String(p.jira_key):undefined,
            reply:String(p.reply||''),movedFrom:moved?String(moved[0]):undefined,
            movedTo:moved?String(moved[1]):undefined});
        }
      });
      // `error` and `close` both fire when the daemon dies mid-stream: reconnecting TWICE means two pipes.
      let retried=false;
      const retry=()=>{
        if(this.disposed||state.closed||retried)return;
        retried=true;
        const wait=RETRY_MS[Math.min(state.tries,RETRY_MS.length-1)];state.tries++;
        state.timer=setTimeout(connect,wait);state.timer?.unref?.();
      };
      state.req.on('error',(e:any)=>{
        if(!state.down){state.down=true;this.log?.(`planner watch ${ep} error: ${e?.message||e} — silent until it reconnects`);}
        retry();});
      state.req.on('close',retry);
    };
    connect();
  }
}
