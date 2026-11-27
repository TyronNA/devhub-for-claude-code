const test=require('node:test');const assert=require('node:assert/strict');
import { parseStatus, normalizeAgents, expandHome } from '../../src/devhub/agents/agentRunner';
const os=require('node:os');const path=require('node:path');

test('Makefile status output maps to running state',()=>{
  assert.deepEqual(parseStatus('running (pid=123)'),{running:true,detail:'running (pid=123)'});
  assert.equal(parseStatus('not running').running,false,'"not running" chứa chữ running — không được nhầm');
  assert.equal(parseStatus('').running,false);
  assert.equal(parseStatus('Not Running').running,false,'không phân biệt hoa thường');
  assert.equal(parseStatus('running (pid=1)\nextra\nlines').detail.includes('\n'),false,'chỉ lấy dòng đầu');
});

test('agent config is validated and ~ expanded',()=>{
  const a=normalizeAgents([{name:'agentic',cwd:'~/x'},{name:'bad'},{cwd:'~/y'},null,'nope']);
  assert.equal(a.length,1);
  assert.equal(a[0].cwd,os.homedir()+'/x');
  assert.deepEqual(normalizeAgents(undefined),[]);
  assert.equal(expandHome('/abs/path'),'/abs/path','đường dẫn tuyệt đối giữ nguyên');
});

test('the documented db path is kept, not silently replaced by the first .db in cwd',()=>{
  const [a]=normalizeAgents([{name:'bot',cwd:'~/bots/x',db:'~/bots/x/threads.db'}]);
  assert.equal(a.db,path.join(os.homedir(),'bots','x','threads.db'));
  assert.equal(normalizeAgents([{name:'bot',cwd:'/b'}])[0].db,undefined);
});
