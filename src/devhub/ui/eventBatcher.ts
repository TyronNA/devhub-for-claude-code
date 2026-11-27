import { DevHubEvent } from '../types';

export interface SessionEventEnvelope {sessionId:string;event:DevHubEvent;}

export function coalesceSessionDeltas(items:SessionEventEnvelope[]):SessionEventEnvelope[]{
  const out:SessionEventEnvelope[]=[];
  for(const item of items){
    const last=out[out.length-1];
    if(last && last.sessionId===item.sessionId && last.event.type==='assistant_delta' && item.event.type==='assistant_delta'){
      last.event={...item.event,text:last.event.text+item.event.text};
    }else out.push(item);
  }
  return out;
}

export class EventBatcher<T> {
  private items:T[]=[];
  private timer:any;
  constructor(private emit:(items:T[])=>void,private delayMs=40){}
  push(item:T){this.items.push(item);if(this.timer)return;this.timer=setTimeout(()=>this.flush(),this.delayMs);}
  flush(){if(this.timer){clearTimeout(this.timer);this.timer=undefined;}if(!this.items.length)return;const items=this.items;this.items=[];this.emit(items);}
  dispose(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.items=[];}
}
