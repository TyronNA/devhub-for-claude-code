const test=require('node:test');const assert=require('node:assert/strict');
import { quotaFromRateLimit } from '../../src/devhub/providers/claude/claudeSession';

// Real payload emitted by `--input-format stream-json` (CLI 2.1.261).
const REAL={status:'allowed',resetsAt:1788851400,rateLimitType:'five_hour',
  unifiedWindows:{five_hour:{utilization:0.02,resetsAt:1788851400},
                  seven_day:{utilization:0.06,resetsAt:1789398000}}};

test('quota comes straight from rate_limit_event, no /usage scraping',()=>{
  const now=1788800000000;
  const u=quotaFromRateLimit(REAL,now);
  assert.equal(u.quota5hUsedPercentage,2,'0.02 -> 2%');
  assert.equal(u.quota7dUsedPercentage,6);
  assert.equal(u.quota5hResetsAt,1788851400*1000,'epoch seconds must be converted to ms');
  assert.equal(u.quota7dResetsAt,1789398000*1000);
  assert.equal(u.quota5hObservedAt,now);
  assert.equal(u.quota5hAuthoritative,true);
});

test('fractional utilisation keeps one decimal instead of rounding to a whole percent',()=>{
  // `/usage` only prints integers; that is why the old numbers drifted from reality.
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
  // Switching account: the old account had 7d=100%, the new (team) one has no 7d window — the CLI only sends five_hour.
  const old=quotaFromRateLimit({unifiedWindows:{five_hour:{utilization:0.5,resetsAt:1},seven_day:{utilization:1,resetsAt:2}}},1000);
  const fresh=quotaFromRateLimit({unifiedWindows:{five_hour:{utilization:0.09,resetsAt:3}}},2000);
  assert.equal(fresh.quota7dUsedPercentage,null);assert.equal(fresh.quota7dObservedAt,2000);
  const merged=mergeSessionUsage(old,fresh);
  assert.equal(merged.quota5hUsedPercentage,9);assert.equal(merged.quota7dUsedPercentage,null,'the old account\'s 7d must be gone');
  assert.equal(merged.quota7dResetsAt,null);
  // Webview/mobile merge by spread: null must overwrite the old number, not leak through as "100% left".
  assert.equal(({...old,...fresh} as any).quota7dUsedPercentage,null);
  assert.ok(usageParts(merged,2000).includes('7d —'));
});

import { parseClaudeEvent } from '../../src/devhub/providers/claude/claudeEventParser';

test('compact reports progress and outcome instead of going silent',()=>{
  // Real `/compact` payload; the old parser ignored it so clicking showed nothing.
  const start=parseClaudeEvent({type:'system',subtype:'status',status:'compacting'});
  assert.equal(start.length,1);
  assert.equal((start[0] as any).tool,'Compact');
  assert.equal(start[0].type,'tool_started');

  const failed=parseClaudeEvent({type:'system',subtype:'status',compact_result:'failed',
    compact_error:'Not enough messages to compact.'});
  assert.equal(failed[0].type,'error');
  assert.ok((failed[0] as any).message.includes('Not enough messages'),'must state the real reason');

  const ok=parseClaudeEvent({type:'system',subtype:'status',compact_result:'success',pre_tokens:120000,post_tokens:18000});
  assert.equal(ok[0].type,'tool_completed');
  assert.equal((ok[0] as any).summary,'120000 → 18000 tokens');

  // routine status changes must not turn into noise
  assert.deepEqual(parseClaudeEvent({type:'system',subtype:'status',status:'requesting'}),[]);
  assert.deepEqual(parseClaudeEvent({type:'system',subtype:'status',status:null}),[]);
});

const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');
/** A fake runner only for inspecting argv: returns `result` right away so the turn ends. */
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
  // Compared against the test process's own env: running inside a Dev Hub session this variable is already set,
  // so asserting `undefined` makes the test depend on its environment. What must be pinned is that TTL doesn't pull it in.
  assert.equal(call.env?.CLAUDE_CODE_ARTIFACT,process.env.CLAUDE_CODE_ARTIFACT,'TTL must not enable Artifact by itself');
});

test('devHub.claude.mcp=none spawns the CLI with no MCP servers at all',async()=>{
  // --strict-mcp-config alone (without --mcp-config) = load no servers; every tab
  // builds its own MCP tree, so this is the only place to cut that process count.
  const off=await argvOf(true);
  assert.ok(off.includes('--strict-mcp-config'),'must pass the flag when MCP is off');
  assert.ok(!off.includes('--mcp-config'),'with --mcp-config the flag loads servers again');

  const on=await argvOf(false);
  assert.ok(!on.includes('--strict-mcp-config'),'by default the CLI must use the user\'s MCP config');
});

test('devHub.claude.artifacts enables Artifact for a process the CLI treats as SDK',async()=>{
  // The CLI disables Artifact when driven over stream-json; without this variable chat in Dev Hub
  // silently loses a feature the same CLI can still publish with in a terminal.
  const on=await spawnOf(undefined,true);
  assert.equal(on.env?.CLAUDE_CODE_ARTIFACT,'1','must opt in against the SDK default of off');
  assert.equal(on.env?.PATH,process.env.PATH,'env must inherit, not replace');

  // Off must NOT set the variable to '0': that forces it off, unlike leaving it to the CLI.
  const off=await spawnOf(undefined,false);
  assert.equal(off.env,undefined,'an empty env keeps the CLI\'s default behaviour');
});

/** A hanging runner: never emits `result`, so the turn is still running when cut. */
function hangingRunner(){
  return {spawnDuplex(){let wake:any;const lines:string[]=[];let done=false;
    return {alive:()=>!done,pid:1,write(){return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
}
async function drain(h:any){const out:any[]=[];for await(const e of h.events)out.push(e);return out;}

test('reclaiming the process mid-turn must give a reason, not quietly report done',async()=>{
  // `close()` is the path idle timeout / extension shutdown takes. Sharing a flag with `interrupt`
  // makes the turn resolve cleanly -> the manager writes `done` with not a single line in the webview: exactly
  // the "sent a message and it went done as if stopped, no idea why" symptom.
  const p=new ClaudeProvider(hangingRunner(),'claude',10,undefined,undefined,undefined,0);
  const h=await p.start({cwd:process.cwd(),prompt:'a'});
  setTimeout(()=>p.closeSession(h.getNativeSessionId()),5);
  const events=await drain(h);
  const err=events.find((e:any)=>e.type==='error');
  assert.ok(err,'a turn reclaimed midway must leave an error event');
  assert.match(err.message,/still running|did not finish/,'the reason must be readable, not just "failed"');
  p.dispose();
});

test('a user pressing stop is still a clean end, not an error',async()=>{
  // The two paths used to share one flag; now that they are split `cancel` must not change meaning —
  // the manager writes `cancelled` itself, adding an error here invents a failure the user didn't cause.
  const p=new ClaudeProvider(hangingRunner(),'claude',10,undefined,undefined,undefined,0);
  const h=await p.start({cwd:process.cwd(),prompt:'a'});
  setTimeout(()=>{void h.cancel();},5);
  const events=await drain(h);
  assert.equal(events.filter((e:any)=>e.type==='error').length,0,'a stop the user asked for is not an error');
  p.dispose();
});
