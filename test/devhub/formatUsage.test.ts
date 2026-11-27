const test=require('node:test');
const assert=require('node:assert/strict');
import { compactNumber, usageParts } from '../../src/devhub/ui/format';

test('usage formatting shows all known token classes and em dash for missing quota',()=>{
  assert.equal(compactNumber(12400),'12.4k');
  const now=2_000_000;
  const parts=usageParts({inputTokens:12400,cachedInputTokens:3000,cacheWriteInputTokens:500,outputTokens:2100,reasoningOutputTokens:800,contextUsedTokens:3800,contextWindowTokens:10000,quota5hUsedPercentage:42,quota5hObservedAt:now-16*60_000},now);
  // The number is what is LEFT (100-used): context 38% used reads "62% left".
  assert.deepEqual(parts,['12.4k in','3k cached','500 cache write','2.1k out','800 reasoning','context 62% left','5h ~58% left','7d —']);
});
