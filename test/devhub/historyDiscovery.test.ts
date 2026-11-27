const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
import { discoverClaudeHistory, loadClaudeTranscript } from '../../src/devhub/providers/claude/claudeHistory';
import { projectForCwd } from '../../src/devhub/providers/historyUtils';

function project(root:string){ return {id:'p',workspaceId:'w',name:'repo',rootPath:root,createdAt:1,updatedAt:1}; }

test('claude history maps transcript cwd to registered project', async () => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-claude-'));
  const repo=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-repo-'));
  const dir=path.join(home,'projects','encoded'); await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'abc.jsonl'), [
    JSON.stringify({type:'system',subtype:'init',session_id:'abc',cwd:repo,timestamp:'2026-09-01T10:00:00Z'}),
    JSON.stringify({type:'user',cwd:repo,message:{role:'user',content:'Improve battle feel'},timestamp:'2026-09-01T10:00:01Z'})
  ].join('\n'));
  const sessions=await discoverClaudeHistory([project(repo) as any], home, 100);
  assert.equal(sessions.length,1); assert.equal(sessions[0].nativeSessionId,'abc'); assert.match(sessions[0].title,/Improve battle feel/);
});

test('history discovery builds an O(1) transcript path index for Claude', async () => {
  const repo=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-repo-index-'));
  const claudeHome=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-claude-index-'));
  const claudeDir=path.join(claudeHome,'projects','encoded'); await fs.mkdir(claudeDir,{recursive:true});
  const claudeFile=path.join(claudeDir,'claude-id.jsonl');
  await fs.writeFile(claudeFile, [
    JSON.stringify({type:'system',subtype:'init',session_id:'claude-id',cwd:repo,timestamp:'2026-09-01T10:00:00Z'}),
    JSON.stringify({type:'user',cwd:repo,message:{role:'user',content:'hello'},timestamp:'2026-09-01T10:00:01Z'})
  ].join('\n'));
  const claudeIndex=new Map<string,string>();
  await discoverClaudeHistory([project(repo) as any], claudeHome, 100, claudeIndex);
  assert.equal(claudeIndex.get('claude-id'), claudeFile);
});

/** Đọc từ đầu file thì chat dài quá 16 MiB mất đúng phần mới nhất — thứ người dùng đang xem. */
test('a claude transcript past the read cap keeps its newest turns, not its oldest', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-claude-tail-'));
  const file=path.join(dir,'big.jsonl');
  const filler=JSON.stringify({type:'user',timestamp:'2026-01-01T00:00:00.000Z',
    message:{content:[{type:'text',text:'cũ '+'x'.repeat(2000)}]}})+'\n';
  const fh=await fs.open(file,'w');
  try{
    // 17 MiB phần đầu -> vượt trần 16 MiB.
    const chunk=filler.repeat(512); const times=Math.ceil(17*1024*1024/chunk.length);
    for(let i=0;i<times;i++) await fh.write(chunk);
    await fh.write(JSON.stringify({type:'user',timestamp:'2026-09-08T00:00:00.000Z',
      message:{content:[{type:'text',text:'tin mới nhất'}]}})+'\n');
  } finally { await fh.close(); }
  const events=await loadClaudeTranscript(file);
  assert.equal(events.some((e:any)=>e.type==='user_message'&&e.text==='tin mới nhất'),true,
    'phải nạp được lượt cuối của file');
  await fs.rm(dir,{recursive:true,force:true});
});

test('a repo inside another repo owns its own cwd, whatever the registration order is',()=>{
  const outer={id:'outer',rootPath:'/home/u/mono'};
  const inner={id:'inner',rootPath:'/home/u/mono/services/svc'};
  for(const list of [[outer,inner],[inner,outer]])
    assert.equal(projectForCwd(list as any,'/home/u/mono/services/svc')!.id,'inner',
      'khớp dài nhất mới là chủ của cwd, không phải cái đứng trước trong mảng');
  assert.equal(projectForCwd([outer,inner] as any,'/home/u/mono/tools')!.id,'outer');
});

/**
 * CLI tự chèn lượt `type:"user"` để nói với model — `<task-notification>` lúc task nền xong,
 * "Continue from where you left off." lúc nối lượt bị cắt. Vẽ chúng ra thành bong bóng user là
 * bịa câu người dùng chưa từng nói.
 */
test('lượt user do CLI chèn không thành bong bóng của người dùng',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-injected-'));
  const file=path.join(dir,'s.jsonl');
  const row=(o:any)=>JSON.stringify(o);
  await fs.writeFile(file,[
    row({type:'user',origin:{kind:'human'},timestamp:'2026-09-14T10:00:00.000Z',
      message:{role:'user',content:[{type:'text',text:'câu thật'}]}}),
    row({type:'user',origin:{kind:'task-notification'},timestamp:'2026-09-14T10:01:00.000Z',
      message:{role:'user',content:'<task-notification>\n<status>stopped</status>\n</task-notification>'}}),
    row({type:'user',isMeta:true,timestamp:'2026-09-14T10:02:00.000Z',
      message:{role:'user',content:[{type:'text',text:'Continue from where you left off.'}]}}),
    // Hàng của CLI cũ không mang `origin` nào cả: vẫn phải hiện.
    row({type:'user',timestamp:'2026-09-14T10:03:00.000Z',
      message:{role:'user',content:[{type:'text',text:'câu cũ'}]}}),
  ].join('\n')+'\n','utf8');
  const events=await loadClaudeTranscript(file);
  assert.deepEqual(events.filter((e:any)=>e.type==='user_message').map((e:any)=>e.text),
    ['câu thật','câu cũ']);
});
