const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
import { parseAuthStatus, checkClaudeSetup, installOptions, resolveClaudeExecutable, isNotLoggedInError } from '../../src/devhub/providers/claude/claudeSetup';
import { parseClaudeEvent } from '../../src/devhub/providers/claude/claudeEventParser';
import { ProcessRunner } from '../../src/devhub/providers/processRunner';

/** A fake `claude` that answers `--version` and `auth status --json` the way CLI 2.1.x does. */
function fakeClaude(loggedIn:boolean|'old'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-setup-'));const f=path.join(dir,'claude');
  const auth=loggedIn==='old'?'echo "error: unknown command auth" >&2; exit 1':`echo '{"loggedIn":${loggedIn},"authMethod":"none"}'; exit ${loggedIn?0:1}`;
  fs.writeFileSync(f,`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.300 (Claude Code)"; exit 0; fi\n${auth}\n`);fs.chmodSync(f,0o755);return f;
}

test('auth status JSON decides signed in or out; anything else is not a verdict',()=>{
  assert.equal(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}'),true);
  assert.equal(parseAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}'),false);
  assert.equal(parseAuthStatus('error: unknown command'),undefined);
  assert.equal(parseAuthStatus('{"other":1}'),undefined);
});

test('setup probe: missing, signed out, signed in, and an old CLI never nags',{skip:process.platform==='win32'},async()=>{
  const r=new ProcessRunner();
  assert.equal(await checkClaudeSetup(r,path.join(os.tmpdir(),'no-such-claude-'+Date.now())),'missing');
  assert.equal(await checkClaudeSetup(r,fakeClaude(false)),'loggedOut');
  assert.equal(await checkClaudeSetup(r,fakeClaude(true)),'ready');
  assert.equal(await checkClaudeSetup(r,fakeClaude('old')),'ready','a CLI without `auth status` must not be reported as signed out');
});

test('install options follow the official setup page per platform, recommended first',()=>{
  const mac=installOptions('darwin');
  assert.equal(mac[0].command,'curl -fsSL https://claude.ai/install.sh | bash');assert.equal(mac[0].recommended,true);
  assert.ok(mac.some(o=>o.command==='brew install --cask claude-code'));
  assert.equal(installOptions('linux').some(o=>o.command.startsWith('brew')),false,'no Homebrew on Linux');
  assert.equal(installOptions('win32')[0].command,'irm https://claude.ai/install.ps1 | iex');
  for(const p of ['darwin','linux','win32'])assert.ok(installOptions(p).some(o=>o.command.startsWith('npm install -g @anthropic-ai/claude-code')));
});

test('the default executable is found where the installer puts it even when PATH is stale',()=>{
  const home='/home/u',has=(set:string[])=>(p:string)=>set.includes(p);
  // On PATH: keep the bare name so a later PATH change still applies.
  assert.equal(resolveClaudeExecutable('claude',{env:{PATH:'/usr/bin:/x/bin'},platform:'linux',home,exists:has(['/x/bin/claude'])}),'claude');
  assert.equal(resolveClaudeExecutable('claude',{env:{PATH:'/usr/bin'},platform:'linux',home,exists:has(['/home/u/.local/bin/claude'])}),'/home/u/.local/bin/claude');
  assert.equal(resolveClaudeExecutable('claude',{env:{PATH:'/usr/bin'},platform:'darwin',home,exists:has(['/opt/homebrew/bin/claude'])}),'/opt/homebrew/bin/claude');
  assert.equal(resolveClaudeExecutable('claude',{env:{PATH:''},platform:'linux',home,exists:has([])}),'claude','nothing found falls back to the name');
  assert.equal(resolveClaudeExecutable('/opt/wrap/claude-acct',{env:{PATH:''},platform:'linux',home,exists:has(['/home/u/.local/bin/claude'])}),'/opt/wrap/claude-acct','a configured wrapper is never second-guessed');
  assert.equal(resolveClaudeExecutable('claude',{env:{Path:'C:\\a'},platform:'win32',home:'C:\\Users\\u',exists:has(['C:\\Users\\u\\.local\\bin\\claude.exe'])}),'C:\\Users\\u\\.local\\bin\\claude.exe');
});

test('a signed-out turn points at Dev Hub, not at /login',()=>{
  // Real stream from CLI 2.1.x with no credentials.
  const out=parseClaudeEvent({type:'result',subtype:'success',is_error:true,result:'Not logged in · Please run /login'});
  const err=out.find((e:any)=>e.type==='error') as any;
  assert.ok(err,'must still be an error');
  assert.ok(err.message.includes('Dev Hub: Get Started'),err.message);
  assert.equal(err.message.includes('/login'),false,'/login does not work over stream-json');
  assert.equal(isNotLoggedInError(err.message),true,'the host must still recognise the rewritten text');
  assert.equal(isNotLoggedInError('rate limit reached'),false);
});
