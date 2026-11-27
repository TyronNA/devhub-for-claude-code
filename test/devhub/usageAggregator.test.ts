const test=require('node:test');
const assert=require('node:assert/strict');
import { UsageAggregator, mergeSessionUsage, quotaIsStale } from '../../src/devhub/usage/usageAggregator';

test('usage aggregator sums tokens but never sums quota percentages',()=>{
  const a:any={provider:'claude',nativeSessionId:'a',workspaceId:'w',projectId:'p',cwd:'/a',title:'a',status:'done',createdAt:1,updatedAt:10,usage:{inputTokens:100,outputTokens:20,quota5hUsedPercentage:30,quota5hObservedAt:10}};
  const b:any={...a,nativeSessionId:'b',updatedAt:20,usage:{inputTokens:50,outputTokens:5,quota5hUsedPercentage:40,quota5hObservedAt:20}};
  const s=new UsageAggregator().summarizeWorkspace('w',[a,b]);
  assert.equal(s[0].inputTokens,150);assert.equal(s[0].outputTokens,25);assert.equal(s[0].quota5hUsedPercentage,40);
});

test('reopening an old session cannot make its old quota outrank a freshly observed one',()=>{
  const now=Date.now();
  // Hàng mở lại có updatedAt=now nhưng ảnh quota của nó đã cũ.
  const fresh:any={provider:'claude',nativeSessionId:'a',workspaceId:'w',projectId:'p',cwd:'/a',title:'a',status:'done',createdAt:1,
    updatedAt:now-600_000,usage:{quota7dUsedPercentage:20,quota7dObservedAt:now-600_000}};
  const reopened:any={...fresh,nativeSessionId:'b',status:'imported',updatedAt:now,
    usage:{quota7dUsedPercentage:73,quota7dObservedAt:now-21*24*3600_000}};
  const s=new UsageAggregator().summarizeWorkspace('w',[fresh,reopened]);
  assert.equal(s[0].quota7dUsedPercentage,20,'phải lấy ảnh đo mới nhất, không phải hàng vừa được ghi lại');
  assert.equal(s[0].quota7dObservedAt,now-600_000);
});

test('merge session usage accumulates token counters while replacing context and quota snapshots',()=>{
  const merged=mergeSessionUsage(
    {inputTokens:100,cachedInputTokens:20,cacheWriteInputTokens:5,outputTokens:10,reasoningOutputTokens:2,contextUsedTokens:500,contextWindowTokens:1000,quota5hUsedPercentage:30,quota5hObservedAt:100,costUsd:0.1},
    {inputTokens:50,cachedInputTokens:5,cacheWriteInputTokens:2,outputTokens:7,reasoningOutputTokens:3,contextUsedTokens:700,contextWindowTokens:1000,quota5hUsedPercentage:42,quota5hObservedAt:200,costUsd:0.2}
  );
  assert.equal(merged.inputTokens,150);assert.equal(merged.cachedInputTokens,25);assert.equal(merged.cacheWriteInputTokens,7);assert.equal(merged.outputTokens,17);assert.equal(merged.reasoningOutputTokens,5);assert.equal(merged.costUsd,0.30000000000000004);
  assert.equal(merged.contextUsedTokens,700);assert.equal(merged.quota5hUsedPercentage,42);assert.equal(merged.quota5hObservedAt,200);
});

test('quota stale detection only flags observed samples older than 15 minutes',()=>{
  const now=1_000_000;
  assert.equal(quotaIsStale(undefined,now),false);
  assert.equal(quotaIsStale(now-14*60_000,now),false);
  assert.equal(quotaIsStale(now-16*60_000,now),true);
});

test('model đã resolve lấy bản mới nhất, không bị lượt sau thiếu field xoá mất',()=>{
  const a=mergeSessionUsage({inputTokens:5,model:'claude-opus-5'},{model:'claude-opus-5-5'});
  assert.equal(a.model,'claude-opus-5-5');assert.equal(a.inputTokens,5);
  assert.equal(mergeSessionUsage(a,{inputTokens:1}).model,'claude-opus-5-5');
});
