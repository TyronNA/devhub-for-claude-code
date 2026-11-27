const test=require('node:test');const assert=require('node:assert/strict');
import { buildThreadSql, toMs, normalizeRows, resolveDb } from '../../src/devhub/agents/agentThreads';

test('the query adapts to each bot schema instead of assuming one',()=>{
  // agentic: có summary + messages
  const a=buildThreadSql(['thread_ts','summary','last_active_at','active_ticket'],['thread_ts','text','role'],['thread_ts','user_id','channel'],3);
  assert.ok(a!.includes('coalesce('),'nhiều ứng viên -> coalesce');
  assert.ok(a!.includes("nullif(t.summary,'')"));
  assert.ok(a!.includes('order by t.last_active_at desc'));
  assert.ok(a!.includes('limit 3 offset 0'));

  // review-bot: chỉ thread_ts/session_id/updated_at, không có messages
  const o=buildThreadSql(['thread_ts','session_id','updated_at'],undefined,['thread_ts','input_preview'],3);
  assert.ok(o!.includes('input_preview'),'không có messages thì lấy input_preview của run làm tiêu đề');
  assert.ok(o!.includes('order by t.updated_at desc'));
  assert.equal(o!.includes(' messages '),false,'không có bảng messages thì không được join');
  assert.ok(o!.includes('as channel')&&o!.includes('as user'),'luôn trả về cột channel/user');

  assert.equal(buildThreadSql([],undefined,undefined,3),undefined,'bảng rỗng -> không dựng query');
});

test('slack second-timestamps and millisecond stamps both land in ms',()=>{
  assert.equal(toMs('1788836239.736319'),1788836239736.319);
  assert.equal(toMs(1788836239736),1788836239736);
  assert.equal(toMs(0),0);assert.equal(toMs('abc'),0);assert.equal(toMs(null),0);
});

test('rows are cleaned and rows without an id are dropped',()=>{
  const r=normalizeRows(JSON.stringify([
    {id:'1',title:'  nhiều   khoảng\n trắng ',at:'1788836239'},
    {id:'2',title:null,at:0},
    {id:'',title:'bỏ',at:1},
  ]));
  assert.equal(r.length,2);
  assert.equal(r[0].title,'nhiều khoảng trắng');
  assert.equal(r[1].title,'2','không title thì lấy id');
  assert.deepEqual(normalizeRows('không phải json'),[]);
});

test('db path falls back to the first .db in the folder',()=>{
  assert.equal(resolveDb('/x','/abs/a.db'),'/abs/a.db');
  assert.equal(resolveDb('/x','rel.db'),'/x/rel.db');
  assert.equal(resolveDb('/nonexistent-dir-xyz',undefined),undefined);
});

test('a JSON input_preview shows the command, not the raw blob',()=>{
  const {prettyTitle}=require('../../src/devhub/agents/agentThreads');
  assert.equal(prettyTitle('{"command": "git fetch origin", "cwd": "/x"}'),'git fetch origin');
  assert.equal(prettyTitle('{"command": "git fetch origin -q'),'git fetch origin -q','JSON bị cắt cụt vẫn rút được');
  assert.equal(prettyTitle('{"prompt": "review this"}'),'review this');
  assert.equal(prettyTitle('bình thường  nhiều   khoảng'),'bình thường nhiều khoảng');
  assert.equal(prettyTitle(''),'(no title)');
  assert.equal(prettyTitle('{"nothing":1}'),'{"nothing":1}','không rút được thì giữ nguyên');
});

test('channel and user come through when the schema has them',()=>{
  const {normalizeRows}=require('../../src/devhub/agents/agentThreads');
  const r=normalizeRows(JSON.stringify([{id:'1',title:'x',at:1,channel:'C03',user:'U03'},{id:'2',title:'y',at:1,channel:null,user:null}]));
  assert.equal(r[0].channel,'C03');assert.equal(r[0].user,'U03');
  assert.equal(r[1].channel,undefined,'null phải thành undefined, không phải chuỗi "null"');
});

test('a thread id column coming from a foreign schema is quoted, not pasted', () => {
  // `at` lấy từ allowlist, nhưng cột id thì rơi về threadCols[0] — tên thô của `pragma table_info`.
  const sql = buildThreadSql(['weird "col"'], undefined, undefined, 5)!;
  assert.ok(sql.includes('t."weird ""col"""'), 'phải quote và nhân đôi dấu ngoặc kép: '+sql);
  assert.equal(sql.includes('t.weird "col"'), false, 'tên cột trần là để schema viết hộ câu query');
});
