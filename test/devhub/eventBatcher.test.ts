const test=require('node:test');
const assert=require('node:assert/strict');
import { EventBatcher } from '../../src/devhub/ui/eventBatcher';

test('event batcher coalesces rapid items into one flush and preserves order', async()=>{
  const flushed:any[]=[];
  const b=new EventBatcher<number>(items=>flushed.push(items),15);
  b.push(1);b.push(2);b.push(3);
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(flushed,[[1,2,3]]);
  b.dispose();
});

test('event batcher flushes pending items synchronously on demand',()=>{
  const flushed:any[]=[];const b=new EventBatcher<string>(items=>flushed.push(items),1000);
  b.push('a');b.flush();assert.deepEqual(flushed,[['a']]);b.dispose();
});

test('delta batch compaction merges adjacent assistant chunks for the same session', async()=>{
  const {coalesceSessionDeltas}=require('../../src/devhub/ui/eventBatcher');
  const items=[
    {sessionId:'a',event:{type:'assistant_delta',text:'hel',timestamp:1}},
    {sessionId:'a',event:{type:'assistant_delta',text:'lo',timestamp:2}},
    {sessionId:'a',event:{type:'tool_started',tool:'Read',label:'x',timestamp:3}},
    {sessionId:'a',event:{type:'assistant_delta',text:'next',timestamp:4}},
  ];
  const out=coalesceSessionDeltas(items);
  assert.equal(out.length,3);
  assert.equal(out[0].event.text,'hello');
  assert.equal(out[2].event.text,'next');
});
