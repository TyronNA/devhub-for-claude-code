export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { mergeTranscript, rereadsTranscript } from '../../src/devhub/sessions/transcriptMerge';

const EV=(text:string,timestamp:number)=>({type:'assistant_message',text,timestamp} as any);
const S=(provider:string,id:string)=>({provider,nativeSessionId:id,workspaceId:'',projectId:'',cwd:'/tmp',
  title:'t',status:'imported',createdAt:1,updatedAt:1} as any);

test('a planner transcript is re-read on open, a CLI transcript is not',()=>{
  assert.equal(rereadsTranscript(S('planner','task:KRP-1')),true);
  // Hội thoại tự do cũng đọc lại được từ khi daemon có /conversations/{id}/messages.
  assert.equal(rereadsTranscript(S('planner','chat:agent-acme')),true);
  assert.equal(rereadsTranscript(S('claude','abc')),false);
});

test('merge keeps live events and replaces only the history prefix',()=>{
  const first=mergeTranscript([EV('no plan yet',100)],[],0,false);
  assert.deepEqual(first.events.map((e:any)=>e.text),['no plan yet']);
  assert.equal(first.historyLen,1);
  // Tin nhắn gõ trong tab nằm sau tiền tố lịch sử; lần đọc lại chỉ được thay tiền tố đó.
  const buffered=[...first.events,EV('hỏi thêm',200)];
  const again=mergeTranscript([EV('plan v1',150)],buffered,first.historyLen,false);
  assert.deepEqual(again.events.map((e:any)=>e.text),['plan v1','hỏi thêm']);
  assert.equal(again.historyLen,1);
});

test('dedupe cuts history at the first live event, planner does not',()=>{
  const live=[EV('live',200)];
  // Claude: transcript trên đĩa đã chứa lượt đang chạy => cắt theo mốc live.
  assert.deepEqual(mergeTranscript([EV('old',100),EV('dup',300)],live,0,true).events.map((e:any)=>e.text),
    ['old','live']);
  // Planner: plan mang timestamp của daemon, cắt là mất luôn plan.
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
