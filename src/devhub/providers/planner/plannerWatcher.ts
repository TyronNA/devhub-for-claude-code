import { PlannerClient } from './plannerClient';
import { parseSseFrame, sseFrames } from './plannerProvider';

/**
 * SSE sống suốt phiên tới daemon planner — mảnh còn thiếu để daemon nói TRƯỚC.
 *
 * `PlannerProvider` cũng mở `/stream`, nhưng chỉ TRONG một lượt và chỉ để nghe `permission`;
 * hết lượt là đóng. Nên một reminder tự nổ (daemon đánh thức chính nó, `planner/reminders.py`)
 * không có đường nào tới được UI. Cái này giữ ống mở khi không có lượt nào.
 *
 * Chỉ đọc frame `reminder_fired`, CÓ CHỦ Ý: `view` là một message bị edit tại chỗ (xem
 * `plannerProvider`), nối thêm là ra chuỗi rác, còn `message` chỉ mang placeholder "⏳". Câu trả
 * lời đầy đủ nằm trong payload của `reminder_fired`.
 */

export interface PlannerReminderPush {
  endpoint:string; conversationId:string; reminderId?:number;
  note:string; jiraKey?:string; reply:string; movedFrom?:string; movedTo?:string;
}

/** Nối lại sau khi đứt: daemon restart (`make restart`) là chuyện thường ngày. */
const RETRY_MS=[1000,2000,5000,15000,30000];

export class PlannerWatcher {
  private conns=new Map<string,{req:any;timer:any;tries:number;closed:boolean;down:boolean}>();
  private disposed=false;
  constructor(private onReminder:(push:PlannerReminderPush)=>void,private log?:(line:string)=>void){}

  /** Danh sách endpoint là nguồn chuẩn: gọi lại khi settings đổi, cái mất thì đóng. */
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
      // Không đặt timeout cho `/stream`: một ống im lặng 25s là bình thường (heartbeat của
      // daemon), còn `request({timeout})` sẽ cắt nó.
      state.req=client.stream((chunk:string)=>{
        state.tries=0;
        // Log theo CHUYỂN TRẠNG THÁI, không theo mỗi lần thử: daemon tắt hẳn thì retry 30s/lần
        // là vĩnh viễn, in mỗi lần một dòng sẽ nhấn chìm mọi dòng log khác của extension.
        if(state.down){state.down=false;this.log?.(`planner watch ${ep} nối lại được`);}
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
      // `error` và `close` cùng nổ khi daemon chết giữa stream: nối lại HAI lần là hai ống.
      let retried=false;
      const retry=()=>{
        if(this.disposed||state.closed||retried)return;
        retried=true;
        const wait=RETRY_MS[Math.min(state.tries,RETRY_MS.length-1)];state.tries++;
        state.timer=setTimeout(connect,wait);state.timer?.unref?.();
      };
      state.req.on('error',(e:any)=>{
        if(!state.down){state.down=true;this.log?.(`planner watch ${ep} error: ${e?.message||e} — im lặng tới khi nối lại được`);}
        retry();});
      state.req.on('close',retry);
    };
    connect();
  }
}
