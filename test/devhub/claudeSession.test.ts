const test=require('node:test');const assert=require('node:assert/strict');
import { quotaFromRateLimit } from '../../src/devhub/providers/claude/claudeSession';

// Payload thật do `--input-format stream-json` phát ra (CLI 2.1.261).
const REAL={status:'allowed',resetsAt:1788851400,rateLimitType:'five_hour',
  unifiedWindows:{five_hour:{utilization:0.02,resetsAt:1788851400},
                  seven_day:{utilization:0.06,resetsAt:1789398000}}};

test('quota comes straight from rate_limit_event, no /usage scraping',()=>{
  const now=1788800000000;
  const u=quotaFromRateLimit(REAL,now);
  assert.equal(u.quota5hUsedPercentage,2,'0.02 -> 2%');
  assert.equal(u.quota7dUsedPercentage,6);
  assert.equal(u.quota5hResetsAt,1788851400*1000,'epoch giây phải đổi sang ms');
  assert.equal(u.quota7dResetsAt,1789398000*1000);
  assert.equal(u.quota5hObservedAt,now);
  assert.equal(u.quota5hAuthoritative,true);
});

test('fractional utilisation keeps one decimal instead of rounding to a whole percent',()=>{
  // `/usage` chỉ in số nguyên; đây là lý do số cũ lệch so với thực tế.
  const u=quotaFromRateLimit({unifiedWindows:{five_hour:{utilization:0.1746},seven_day:{utilization:0.0625}}});
  assert.equal(u.quota5hUsedPercentage,17.5);
  assert.equal(u.quota7dUsedPercentage,6.3);
});

test('a payload without unifiedWindows yields nothing rather than zeros',()=>{
  assert.deepEqual(quotaFromRateLimit({status:'allowed'}),{});
  assert.deepEqual(quotaFromRateLimit(undefined),{});
  assert.deepEqual(quotaFromRateLimit({unifiedWindows:{five_hour:{}}}),{});
});

import { mergeSessionUsage } from '../../src/devhub/usage/usageAggregator';
import { usageParts } from '../../src/devhub/ui/format';
test('a window absent from the account state clears the stale one instead of keeping it',()=>{
  // Đổi acc: acc cũ 7d=100%, acc mới (team) không có window 7d nào — CLI chỉ gửi five_hour.
  const old=quotaFromRateLimit({unifiedWindows:{five_hour:{utilization:0.5,resetsAt:1},seven_day:{utilization:1,resetsAt:2}}},1000);
  const fresh=quotaFromRateLimit({unifiedWindows:{five_hour:{utilization:0.09,resetsAt:3}}},2000);
  assert.equal(fresh.quota7dUsedPercentage,null);assert.equal(fresh.quota7dObservedAt,2000);
  const merged=mergeSessionUsage(old,fresh);
  assert.equal(merged.quota5hUsedPercentage,9);assert.equal(merged.quota7dUsedPercentage,null,'7d của acc cũ phải mất');
  assert.equal(merged.quota7dResetsAt,null);
  // Webview/mobile merge bằng spread: null phải đè được số cũ, không lọt thành "100% left".
  assert.equal(({...old,...fresh} as any).quota7dUsedPercentage,null);
  assert.ok(usageParts(merged,2000).includes('7d —'));
});

import { parseClaudeEvent } from '../../src/devhub/providers/claude/claudeEventParser';

test('compact reports progress and outcome instead of going silent',()=>{
  // Payload thật của `/compact`; parser cũ bỏ qua nên bấm xong không thấy gì.
  const start=parseClaudeEvent({type:'system',subtype:'status',status:'compacting'});
  assert.equal(start.length,1);
  assert.equal((start[0] as any).tool,'Compact');
  assert.equal(start[0].type,'tool_started');

  const failed=parseClaudeEvent({type:'system',subtype:'status',compact_result:'failed',
    compact_error:'Not enough messages to compact.'});
  assert.equal(failed[0].type,'error');
  assert.ok((failed[0] as any).message.includes('Not enough messages'),'phải nêu lý do thật');

  const ok=parseClaudeEvent({type:'system',subtype:'status',compact_result:'success',pre_tokens:120000,post_tokens:18000});
  assert.equal(ok[0].type,'tool_completed');
  assert.equal((ok[0] as any).summary,'120000 → 18000 tokens');

  // status thường xuyên khác không được biến thành nhiễu
  assert.deepEqual(parseClaudeEvent({type:'system',subtype:'status',status:'requesting'}),[]);
  assert.deepEqual(parseClaudeEvent({type:'system',subtype:'status',status:null}),[]);
});

const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');
/** Runner giả chỉ để soi argv: trả về `result` ngay để lượt kết thúc. */
function argvRunner(){
  const calls:any[]=[];
  return {calls,spawnDuplex(o:any){calls.push(o);let wake:any;const lines:string[]=[];let done=false;
    const push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
    return {alive:()=>!done,write(){push({type:'result',subtype:'success'});return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
}
async function spawnOf(strictMcp?:boolean,artifacts?:boolean,promptCacheTtl?:'5m'|'1h'){
  const r=argvRunner();
  const p=new ClaudeProvider(r,'claude',10,undefined,undefined,undefined,0,undefined,strictMcp,artifacts,promptCacheTtl);
  try{ const h=await p.start({cwd:process.cwd(),prompt:'a'}); for await(const e of h.events){} }finally{p.dispose();}
  return r.calls[0] as {args:string[];env?:any};
}
async function argvOf(strictMcp?:boolean){ return (await spawnOf(strictMcp)).args; }

test('Claude stream-json uses print mode and can select the vendor cache TTL',async()=>{
  const call=await spawnOf(undefined,false,'1h');
  assert.ok(call.args.includes('--print'),'current Claude CLI requires stream-json input/output in print mode');
  assert.equal(call.env?.CLAUDE_CODE_PROMPT_CACHE_TTL,'1h');
  // So với env của chính process test: chạy trong một phiên Dev Hub thì biến này đã có sẵn,
  // assert `undefined` là test tự phụ thuộc môi trường. Cái cần chốt là TTL không kéo theo nó.
  assert.equal(call.env?.CLAUDE_CODE_ARTIFACT,process.env.CLAUDE_CODE_ARTIFACT,'TTL không được tự bật Artifact');
});

test('devHub.claude.mcp=none spawns the CLI with no MCP servers at all',async()=>{
  // --strict-mcp-config một mình (không kèm --mcp-config) = không nạp server nào; mỗi tab
  // vốn dựng cây MCP riêng nên đây là chỗ duy nhất cắt được số process đó.
  const off=await argvOf(true);
  assert.ok(off.includes('--strict-mcp-config'),'phải truyền cờ khi tắt MCP');
  assert.ok(!off.includes('--mcp-config'),'kèm --mcp-config thì cờ lại nạp server trở lại');

  const on=await argvOf(false);
  assert.ok(!on.includes('--strict-mcp-config'),'mặc định phải để CLI dùng cấu hình MCP của người dùng');
});

test('devHub.claude.artifacts bật Artifact cho process bị CLI coi là SDK',async()=>{
  // CLI tắt Artifact khi bị lái qua stream-json; không có biến này thì chat trong Dev Hub
  // im lặng mất tính năng mà cùng CLI đó ở terminal vẫn publish được.
  const on=await spawnOf(undefined,true);
  assert.equal(on.env?.CLAUDE_CODE_ARTIFACT,'1','phải opt-in ngược lại mặc định tắt của SDK');
  assert.equal(on.env?.PATH,process.env.PATH,'env phải kế thừa chứ không thay hẳn');

  // Tắt thì KHÔNG được đặt biến thành '0': như thế là tắt hẳn, khác với để CLI tự quyết.
  const off=await spawnOf(undefined,false);
  assert.equal(off.env,undefined,'để trống env thì CLI giữ hành vi mặc định của nó');
});

/** Runner treo: không bao giờ phát `result`, để lượt còn đang chạy khi bị cắt. */
function hangingRunner(){
  return {spawnDuplex(){let wake:any;const lines:string[]=[];let done=false;
    return {alive:()=>!done,pid:1,write(){return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
}
async function drain(h:any){const out:any[]=[];for await(const e of h.events)out.push(e);return out;}

test('thu hồi process giữa lượt phải nói lý do, không lặng lẽ báo xong',async()=>{
  // `close()` là đường idle timeout / tắt extension đi qua. Gộp chung cờ với `interrupt` thì
  // lượt resolve sạch sẽ -> manager ghi `done` mà webview không có lấy một dòng nào: đúng
  // triệu chứng "nhắn xong nó done như bị stop mà không biết bị gì".
  const p=new ClaudeProvider(hangingRunner(),'claude',10,undefined,undefined,undefined,0);
  const h=await p.start({cwd:process.cwd(),prompt:'a'});
  setTimeout(()=>p.closeSession(h.getNativeSessionId()),5);
  const events=await drain(h);
  const err=events.find((e:any)=>e.type==='error');
  assert.ok(err,'lượt bị thu hồi giữa chừng phải để lại một event error');
  assert.match(err.message,/still running|did not finish/,'lý do phải đọc được, không chỉ là "failed"');
  p.dispose();
});

test('người dùng bấm dừng thì vẫn là kết thúc sạch, không phải lỗi',async()=>{
  // Hai đường dùng chung một cờ trước đây; tách ra rồi thì `cancel` không được đổi nghĩa —
  // manager tự ghi `cancelled`, thêm error ở đây là dựng ra lỗi người dùng không gây ra.
  const p=new ClaudeProvider(hangingRunner(),'claude',10,undefined,undefined,undefined,0);
  const h=await p.start({cwd:process.cwd(),prompt:'a'});
  setTimeout(()=>{void h.cancel();},5);
  const events=await drain(h);
  assert.equal(events.filter((e:any)=>e.type==='error').length,0,'dừng theo ý người dùng không phải lỗi');
  p.dispose();
});
