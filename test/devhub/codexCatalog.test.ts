const test=require('node:test');const assert=require('node:assert/strict');
import { parseCatalog } from '../../src/devhub/providers/codex/codexCatalog';

// Excerpt from a real ~/.codex/models_cache.json.
const REAL=JSON.stringify({fetched_at:'2026-09-08T03:49:24Z',models:[
 {slug:'gpt-6-astra',display_name:'GPT-6-Astra',visibility:'list',
  supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'},{effort:'xhigh'},{effort:'max'},{effort:'ultra'}]},
 {slug:'gpt-reserve',display_name:'GPT-Reserve',visibility:'hide',
  supported_reasoning_levels:[{effort:'low'}]},
 {slug:'gpt-5.5',display_name:'GPT-5.5',visibility:'list',
  supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'},{effort:'xhigh'}]},
]});

test('the live catalog is the source of truth, not a hardcoded list',()=>{
  const m=parseCatalog(REAL);
  assert.deepEqual(m.map(x=>x.slug),['gpt-6-astra','gpt-5.5'],'hidden models must be dropped');
  assert.equal(m[0].label,'GPT-6-Astra');
  // The old claim "Codex tops out at xhigh" is WRONG — newer models have max and ultra.
  assert.deepEqual(m[0].efforts,['low','medium','high','xhigh','max','ultra']);
  assert.deepEqual(m[1].efforts,['low','medium','high','xhigh'],'effort levels differ per model');
});

test('a broken or empty catalog degrades to nothing rather than throwing',()=>{
  assert.deepEqual(parseCatalog('not json'),[]);
  assert.deepEqual(parseCatalog('{}'),[]);
  assert.deepEqual(parseCatalog(JSON.stringify({models:[{no_slug:1},null,'x']})),[]);
  const noLevels=parseCatalog(JSON.stringify({models:[{slug:'x',visibility:'list'}]}));
  assert.deepEqual(noLevels,[{slug:'x',label:'x',efforts:[],contextWindow:undefined,effectivePercent:undefined}],
    'without display_name use the slug');
});

import { effectiveContextWindow } from '../../src/devhub/providers/codex/codexCatalog';

test('the catalog carries the real context window, trimmed by effective percent',()=>{
  // From a real `codex debug models`: 272000 * 95% = 258400, exactly the `model_context_window`
  // the rollout records — so this is the number to check against, not the auto-compact threshold.
  const m=parseCatalog(JSON.stringify({models:[{slug:'gpt-5.6-luna',display_name:'GPT-5.6-Luna',visibility:'list',
    context_window:272000,effective_context_window_percent:95,supported_reasoning_levels:[{effort:'low'}]}]}));
  assert.equal(m[0].contextWindow,272000);
  assert.equal(effectiveContextWindow(m[0]),258400);
  assert.equal(effectiveContextWindow({slug:'x',label:'x',efforts:[],contextWindow:1000}),1000,'without percent use it as is');
  assert.equal(effectiveContextWindow(undefined),undefined);
  assert.equal(effectiveContextWindow({slug:'x',label:'x',efforts:[]}),undefined);
});
