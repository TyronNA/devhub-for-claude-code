import { DevHubEvent, DevHubSession } from '../types';

const MAX_EVENTS=1500;

/**
 * The planner's transcript is LIVE STATE (plan version, state chain, a reminder that just fired), not
 * a file on disk: a buffer read while the task was still `ANALYZING` keeps saying "no plan stored yet"
 * until the extension host restarts, so clicking that row again after the plan is done still shows the old tab. It must be
 * re-read on every open — but ONLY when the session has no running turn, because then the buffer is the only
 * source of live events.
 */
export function rereadsTranscript(session:DevHubSession){
  return session.provider==='planner';
}

export interface MergedTranscript { events:DevHubEvent[]; historyLen:number; }

/**
 * Merges freshly read history with the existing buffer. `historyLen` is the number of events at the START of the buffer
 * that came from the previous read (0 when the buffer is empty or holds only live events) — the tail is live events that
 * can't be read back from anywhere (the planner conversation lives in the daemon's memory), so it is always kept and the new history
 * only replaces the prefix.
 */
export function mergeTranscript(loaded:DevHubEvent[],buffered:DevHubEvent[],historyLen:number,dedupe:boolean):MergedTranscript{
  const head=loaded.length>MAX_EVENTS
    ?[{type:'warning',message:'Showing the most recent 1,500 transcript events to keep Dev Hub responsive.',timestamp:Date.now()} as DevHubEvent,
      ...loaded.slice(-(MAX_EVENTS-1))]
    :loaded;
  const live=buffered.slice(Math.min(historyLen,buffered.length));
  // Live events arriving WHILE the transcript was being read are already in the buffer, and the transcript on disk may
  // already contain that same turn (Claude writes the file while running): cut the history at the time of the first
  // live event. NOT for the planner — a plan carries the daemon's timestamp, which may be later than older messages
  // in the tab, and cutting would lose the plan.
  const history=live.length&&dedupe?head.filter(e=>e.timestamp<live[0].timestamp):head;
  return {events:[...history,...live],historyLen:history.length};
}
