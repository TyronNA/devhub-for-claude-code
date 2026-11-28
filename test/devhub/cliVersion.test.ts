const test=require('node:test');const assert=require('node:assert/strict');
import { parseCliVersion, compareVersions, isOutdated, readInstalledVersion, checkVersionDrift, CLI_PACKAGES, CHECK_INTERVAL_MS } from '../../src/devhub/providers/cliVersion';
import { ProcessRunner } from '../../src/devhub/providers/processRunner';

test('version parsing survives what each CLI actually prints',()=>{
  assert.equal(parseCliVersion('2.1.266 (Claude Code)'),'2.1.266');
  assert.equal(parseCliVersion('codex-cli 0.153.4'),'0.153.4');
  assert.equal(parseCliVersion('v1.2.3'),'1.2.3');
  assert.equal(parseCliVersion('1.2.3-rc.1'),'1.2.3-rc.1');
  // Nothing that looks like a version means stay quiet, don't guess — a false warning is worse than none.
  assert.equal(parseCliVersion('command not found'),undefined);
  assert.equal(parseCliVersion(''),undefined);
});

test('comparison is numeric, not lexicographic, and prerelease ranks below release',()=>{
  assert.equal(compareVersions('2.1.9','2.1.10')<0,true,'9 < 10 even though the string "9" > "1"');
  assert.equal(compareVersions('2.1.266','2.1.266'),0);
  assert.equal(compareVersions('2.2.0','2.1.999')>0,true);
  assert.equal(compareVersions('1.2.3-rc.1','1.2.3')<0,true);
  assert.equal(isOutdated('2.1.261','2.1.266'),true);
  assert.equal(isOutdated('2.1.266','2.1.261'),false);
  // Missing either side means no conclusion — a broken network must not turn into "outdated".
  assert.equal(isOutdated('2.1.261',undefined),false);
  assert.equal(isOutdated(undefined,'2.1.266'),false);
});

test('installed version is read from the real binary and a missing one is silent',async()=>{
  const runner=new ProcessRunner();
  assert.equal(await readInstalledVersion(runner,process.execPath),process.version.replace(/^v/,''));
  assert.equal(await readInstalledVersion(runner,'devhub-nonexistent-binary-xyz'),undefined);
});

function fakeRunner(versions:{[cmd:string]:string|null}){
  return {spawnLines({command}:any){
    const out=versions[command];const lines=out==null?[]:[out];
    return {stdoutLines:(async function*(){for(const l of lines)yield l;})(),stderrLines:(async function*(){})(),
      exit:Promise.resolve({code:out==null?127:0,signal:null}),cancel:async()=>{}};
  }} as any;
}
function fakeCache(initial:any={}){let v=initial;return {get:()=>v,set:(x:any)=>{v=x;},peek:()=>v};}

test('drift check reports only the CLI that is actually behind',async()=>{
  const drifts=await checkVersionDrift({
    runner:fakeRunner({claude:'2.1.261 (Claude Code)',codex:'codex-cli 0.153.4'}),
    executables:{claude:'claude',codex:'codex'},cache:fakeCache(),
    fetchLatest:async(pkg:string)=>pkg===CLI_PACKAGES.claude?'2.1.266':'0.153.4'});
  assert.deepEqual(drifts.map(d=>d.provider),['claude']);
  assert.equal(drifts[0].installed,'2.1.261');assert.equal(drifts[0].latest,'2.1.266');
  assert.equal(drifts[0].pkg,'@anthropic-ai/claude-code');
});

test('registry is hit once per interval, not once per refresh',async()=>{
  let calls=0;const cache=fakeCache();const now={at:1_000_000};
  const run=()=>checkVersionDrift({runner:fakeRunner({claude:'2.1.261 (Claude Code)'}),
    executables:{claude:'claude'},cache,now:()=>now.at,
    fetchLatest:async()=>{calls++;return '2.1.266';}});
  await run();await run();await run();
  assert.equal(calls,1,'the cache must block every later call within the 6h window');
  now.at+=CHECK_INTERVAL_MS;
  await run();
  assert.equal(calls,2,'expired means ask again');
});

test('a CLI that is not installed, or a registry that fails, produces no warning',async()=>{
  const missing=await checkVersionDrift({runner:fakeRunner({claude:null}),
    executables:{claude:'claude'},cache:fakeCache(),fetchLatest:async()=>'9.9.9'});
  assert.deepEqual(missing,[],'a binary that cannot run has nothing to compare');
  const offline=await checkVersionDrift({runner:fakeRunner({claude:'2.1.261 (Claude Code)'}),
    executables:{claude:'claude'},cache:fakeCache(),fetchLatest:async()=>undefined});
  assert.deepEqual(offline,[],'a broken registry must stay quiet');
});

test('an executable that is not configured is skipped entirely',async()=>{
  let calls=0;
  const drifts=await checkVersionDrift({runner:fakeRunner({}),
    executables:{},cache:fakeCache(),fetchLatest:async()=>{calls++;return '2.1.266';}});
  assert.deepEqual(drifts,[]);
  assert.equal(calls,0,'not configured means the registry is not hit');
});
