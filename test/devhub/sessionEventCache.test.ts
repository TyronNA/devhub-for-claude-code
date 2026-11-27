const test=require('node:test');const assert=require('node:assert/strict');
import { SessionEventCache } from '../../src/devhub/sessions/sessionEventCache';

test('session event cache bounds events and evicts least recently used sessions',()=>{
  const cache=new SessionEventCache<number>(2,3);
  cache.set('a',[1,2,3,4]);
  assert.deepEqual(cache.get('a'),[2,3,4]);
  cache.set('b',[5]);
  cache.get('a');
  cache.set('c',[6]);
  assert.equal(cache.get('b'),undefined);
  assert.deepEqual(cache.get('a'),[2,3,4]);
  assert.deepEqual(cache.get('c'),[6]);
});

test('session event cache appends without unbounded growth',()=>{
  const cache=new SessionEventCache<number>(2,3);
  for(let i=0;i<10;i++)cache.append('a',i);
  assert.deepEqual(cache.get('a'),[7,8,9]);
});

test('session event cache can coalesce adjacent streaming fragments',()=>{
  const cache=new SessionEventCache<any>(2,3);
  const merge=(prev:any,next:any)=>prev?.type==='delta'&&next?.type==='delta'?{type:'delta',text:prev.text+next.text}:undefined;
  cache.append('a',{type:'delta',text:'hel'},merge);
  cache.append('a',{type:'delta',text:'lo'},merge);
  cache.append('a',{type:'tool'},merge);
  assert.deepEqual(cache.get('a'),[{type:'delta',text:'hello'},{type:'tool'}]);
});
