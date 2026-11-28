const test=require('node:test');const assert=require('node:assert/strict');
import { parseContextWindow } from '../../src/devhub/providers/codex/codexConfig';
import { parseCodexEvent } from '../../src/devhub/providers/codex/codexEventParser';

test('codex usage fields map onto the same snapshot Claude uses',()=>{
  // Real payload from `codex exec --json`.
  const ev=parseCodexEvent({type:'turn.completed',usage:{input_tokens:41861,cached_input_tokens:30208,
    cache_write_input_tokens:0,output_tokens:413,reasoning_output_tokens:278}});
  const u=(ev.find((e:any)=>e.type==='usage') as any).usage;
  assert.equal(u.inputTokens,41861);
  assert.equal(u.cachedInputTokens,30208);
  assert.equal(u.outputTokens,413);
  assert.equal(u.reasoningOutputTokens,278);
  // exec emits no quota; the real numbers are read separately from the rollout.
  assert.equal(u.quota5hUsedPercentage,undefined);
  assert.equal(u.quota7dUsedPercentage,undefined);
});

test('context window comes from the user config and never from the auto-compact limit',()=>{
  assert.equal(parseContextWindow('model_context_window = 272000'),272000);
  // `model_auto_compact_token_limit` is the auto-compact TRIGGER threshold, not the context
  // window. Taken as the window (384000 vs the real 258400) the displayed percentage is way off.
  assert.equal(parseContextWindow('model_auto_compact_token_limit = 384000'),undefined);
  assert.equal(parseContextWindow('nothing here'),undefined);
  assert.equal(parseContextWindow('model_context_window = 0'),undefined,'0 is not a valid window');
});

import { parseConfiguredModel } from '../../src/devhub/providers/codex/codexConfig';

test('the configured codex model is read from config.toml for context sizing',()=>{
  assert.equal(parseConfiguredModel('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"'),'gpt-5.6-luna');
  assert.equal(parseConfiguredModel('model_reasoning_effort = "xhigh"'),undefined);
});

test('exec turn totals are billing counters, never a current context measurement',()=>{
  const u=(parseCodexEvent({type:'turn.completed',usage:{input_tokens:599419,output_tokens:3878,total_tokens:603297}})
    .find((e:any)=>e.type==='usage') as any).usage;
  assert.equal(u.inputTokens,599419);
  assert.equal(u.outputTokens,3878);
  assert.equal(u.contextUsedTokens,undefined);
});

import { eventUserText, itemUserText, isInjectedContext } from '../../src/devhub/providers/codex/codexHistory';

test('a codex turn is counted once, from the real user event',()=>{
  // Codex writes the same turn twice; taking both doubles the transcript.
  const ev={type:'event_msg',payload:{type:'user_message',message:'hello'}};
  const item={type:'response_item',payload:{role:'user',content:[{type:'input_text',text:'hello'}]}};
  assert.equal(eventUserText(ev),'hello');
  assert.equal(eventUserText(item),undefined,'response_item is not an event');
  assert.equal(itemUserText(item),'hello');
  assert.equal(itemUserText(ev),undefined);
});

test('context injected into the model-facing copy never reaches the chat',()=>{
  const injected={type:'response_item',payload:{role:'user',content:[
    {type:'input_text',text:'<recommended_plugins>\nHere is a list of plugins…\n- Airtable (airtable@openai-curated-remote)'}]}};
  assert.equal(itemUserText(injected),undefined,'a <...> block is injected context, not a user line');
  assert.equal(isInjectedContext('<recommended_plugins>\nx'),true);
  assert.equal(isInjectedContext('</environment_context>'),true);
  assert.equal(isInjectedContext('hello <world>'),false,'only blocks when it STARTS with a tag');
  assert.equal(isInjectedContext('check prod'),false);
});

import { codexErrorText, parseCodexEvent as pce } from '../../src/devhub/providers/codex/codexEventParser';

test('codex errors reach the chat as a sentence, not a JSON blob',()=>{
  const real={type:'error',status:400,error:{type:'invalid_request_error',
    message:"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}};
  assert.ok(codexErrorText(real).startsWith("The 'gpt-6-astra' model requires"));
  assert.equal(codexErrorText(real).includes('{'),false,'no JSON may leak in');

  // the error nested one more level, and the error is a JSON string
  assert.equal(codexErrorText({error:{error:{message:'nested'}}}),'nested');
  assert.equal(codexErrorText({error:'{"error":{"message":"as string"}}'}),'as string');
  assert.equal(codexErrorText({error:'plain text'}),'plain text');
  assert.equal(codexErrorText({}),'Codex turn failed');

  const ev=pce(real).find((e:any)=>e.type==='error') as any;
  assert.ok(ev&&ev.message.startsWith("The 'gpt-6-astra'"),'the parser must use the same function');
});
