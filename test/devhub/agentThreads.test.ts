const test=require('node:test');const assert=require('node:assert/strict');
import { buildThreadSql, toMs, normalizeRows, resolveDb } from '../../src/devhub/agents/agentThreads';

test('the query adapts to each bot schema instead of assuming one',()=>{
  // agentic: has summary + messages
  const a=buildThreadSql(['thread_ts','summary','last_active_at','active_ticket'],['thread_ts','text','role'],['thread_ts','user_id','channel'],3);
  assert.ok(a!.includes('coalesce('),'several candidates -> coalesce');
  assert.ok(a!.includes("nullif(t.summary,'')"));
  assert.ok(a!.includes('order by t.last_active_at desc'));
  assert.ok(a!.includes('limit 3 offset 0'));

  // review-bot: only thread_ts/session_id/updated_at, no messages
  const o=buildThreadSql(['thread_ts','session_id','updated_at'],undefined,['thread_ts','input_preview'],3);
  assert.ok(o!.includes('input_preview'),'without messages the run input_preview becomes the title');
  assert.ok(o!.includes('order by t.updated_at desc'));
  assert.equal(o!.includes(' messages '),false,'without a messages table there must be no join');
  assert.ok(o!.includes('as channel')&&o!.includes('as user'),'channel/user columns are always returned');

  assert.equal(buildThreadSql([],undefined,undefined,3),undefined,'empty table -> no query built');
});

test('slack second-timestamps and millisecond stamps both land in ms',()=>{
  assert.equal(toMs('1788836239.736319'),1788836239736.319);
  assert.equal(toMs(1788836239736),1788836239736);
  assert.equal(toMs(0),0);assert.equal(toMs('abc'),0);assert.equal(toMs(null),0);
});

test('rows are cleaned and rows without an id are dropped',()=>{
  const r=normalizeRows(JSON.stringify([
    {id:'1',title:'  lots   of\n space ',at:'1788836239'},
    {id:'2',title:null,at:0},
    {id:'',title:'skip',at:1},
  ]));
  assert.equal(r.length,2);
  assert.equal(r[0].title,'lots of space');
  assert.equal(r[1].title,'2','no title falls back to the id');
  assert.deepEqual(normalizeRows('not json'),[]);
});

test('db path falls back to the first .db in the folder',()=>{
  assert.equal(resolveDb('/x','/abs/a.db'),'/abs/a.db');
  assert.equal(resolveDb('/x','rel.db'),'/x/rel.db');
  assert.equal(resolveDb('/nonexistent-dir-xyz',undefined),undefined);
});

test('a JSON input_preview shows the command, not the raw blob',()=>{
  const {prettyTitle}=require('../../src/devhub/agents/agentThreads');
  assert.equal(prettyTitle('{"command": "git fetch origin", "cwd": "/x"}'),'git fetch origin');
  assert.equal(prettyTitle('{"command": "git fetch origin -q'),'git fetch origin -q','truncated JSON can still be extracted');
  assert.equal(prettyTitle('{"prompt": "review this"}'),'review this');
  assert.equal(prettyTitle('plain  lots   of'),'plain lots of');
  assert.equal(prettyTitle(''),'(no title)');
  assert.equal(prettyTitle('{"nothing":1}'),'{"nothing":1}','kept as is when nothing can be extracted');
});

test('channel and user come through when the schema has them',()=>{
  const {normalizeRows}=require('../../src/devhub/agents/agentThreads');
  const r=normalizeRows(JSON.stringify([{id:'1',title:'x',at:1,channel:'C03',user:'U03'},{id:'2',title:'y',at:1,channel:null,user:null}]));
  assert.equal(r[0].channel,'C03');assert.equal(r[0].user,'U03');
  assert.equal(r[1].channel,undefined,'null must become undefined, not the string "null"');
});

test('a thread id column coming from a foreign schema is quoted, not pasted', () => {
  // `at` comes from the allowlist, but the id column falls back to threadCols[0] — the raw name from `pragma table_info`.
  const sql = buildThreadSql(['weird "col"'], undefined, undefined, 5)!;
  assert.ok(sql.includes('t."weird ""col"""'), 'must quote and double the double quotes: '+sql);
  assert.equal(sql.includes('t.weird "col"'), false, 'a bare column name lets the schema write the query');
});
