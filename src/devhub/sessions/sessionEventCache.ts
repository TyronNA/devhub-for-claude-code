export class SessionEventCache<T> {
  private cache=new Map<string,T[]>();
  constructor(private maxSessions=12,private maxEventsPerSession=3000){}
  get(key:string):T[]|undefined{
    const value=this.cache.get(key);
    if(!value)return undefined;
    this.cache.delete(key);this.cache.set(key,value);
    return value;
  }
  set(key:string,events:T[]):T[]{
    const bounded=events.length>this.maxEventsPerSession?events.slice(-this.maxEventsPerSession):events;
    this.cache.delete(key);this.cache.set(key,bounded);
    this.evict();
    return bounded;
  }
  append(key:string,event:T,merge?:(previous:T|undefined,next:T)=>T|undefined):T[]{
    const current=this.cache.get(key) ?? [];
    const merged=merge?.(current[current.length-1],event);
    if(merged!==undefined && current.length) current[current.length-1]=merged; else current.push(event);
    if(current.length>this.maxEventsPerSession)current.splice(0,current.length-this.maxEventsPerSession);
    this.cache.delete(key);this.cache.set(key,current);
    this.evict();
    return current;
  }
  move(oldKey:string,newKey:string){const value=this.cache.get(oldKey);if(!value)return;this.cache.delete(oldKey);this.set(newKey,value);}
  delete(key:string){this.cache.delete(key);}
  clear(){this.cache.clear();}
  private evict(){while(this.cache.size>this.maxSessions){const oldest=this.cache.keys().next().value as string|undefined;if(oldest===undefined)break;this.cache.delete(oldest);}}
}
