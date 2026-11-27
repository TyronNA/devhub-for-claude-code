export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { mergeTranscript, rereadsTranscript } from '../../src/devhub/sessions/transcriptMerge';

const EV=(text:string,timestamp:number)=>({type:'assistant_message',text,timestamp} as any);
const S=(provider:string,id:string)=>({provider,nativeSessionId:id,workspaceId:'',projectId:'',cwd:'/tmp',
  title:'t',status:'imported',createdAt:1,updatedAt:1} as any);

test('a planner transcript is re-read on open, a CLI transcript is not',()=>{
  assert.equal(rereadsTranscript(S('planner','task:KRP-1')),true);
  // Free-form conversations can be re-read too since the daemon has /conversations/{id}/messages.
  assert.equal(rereadsTranscript(S('planner','chat:agent-acme')),true);
  assert.equal(rereadsTranscript(S('claude','abc')),false);
});

test('merge keeps live events and replaces only the history prefix',()=>{
  const first=mergeTranscript([EV('no plan yet',100)],[],0,false);
  assert.deepEqual(first.events.map((e:any)=>e.text),['no plan yet']);
  assert.equal(first.historyLen,1);
  // Messages typed in the tab sit after the history prefix; a re-read may only replace that prefix.
  const buffered=[...first.events,EV('follow-up question',200)];
  const again=mergeTranscript([EV('plan v1',150)],buffered,first.historyLen,false);
  assert.deepEqual(again.events.map((e:any)=>e.text),['plan v1','follow-up question']);
  assert.equal(again.historyLen,1);
});

test('dedupe cuts history at the first live event, planner does not',()=>{
  const live=[EV('live',200)];
  // Claude: the transcript on disk already contains the running turn => cut at the live anchor.
  assert.deepEqual(mergeTranscript([EV('old',100),EV('dup',300)],live,0,true).events.map((e:any)=>e.text),
    ['old','live']);
  // Planner: a plan carries the daemon's timestamp, cutting would lose the plan.
  assert.deepEqual(mergeTranscript([EV('old',100),EV('plan',300)],live,0,false).events.map((e:any)=>e.text),
    ['old','plan','live']);
});

test('merge caps history at 1500 events with a warning at the head',()=>{
  const loaded=Array.from({length:1600},(_,i)=>EV('e'+i,i+1));
  const merged=mergeTranscript(loaded,[],0,false);
  assert.equal(merged.events.length,1500);
  assert.equal(merged.historyLen,1500);
  assert.equal(merged.events[0].type,'warning');
  assert.equal((merged.events[1499] as any).text,'e1599');
});
