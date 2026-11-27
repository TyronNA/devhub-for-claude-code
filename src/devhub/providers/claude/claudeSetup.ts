const path=require('node:path');const fs=require('node:fs');const os=require('node:os');
import { ProcessRunner } from '../processRunner';

/** `ready` also covers "can't tell" (a CLI too old for `auth status`): nagging a working setup is worse than missing a broken one. */
export type ClaudeSetupState='missing'|'loggedOut'|'ready';

/** `claude auth status` prints JSON and exits 1 when logged out; anything unparseable is an old CLI, not a logged-out one. */
export function parseAuthStatus(text:string):boolean|undefined{
  try{const j=JSON.parse(text);return typeof j?.loggedIn==='boolean'?j.loggedIn:undefined;}catch{return undefined;}
}

export async function checkClaudeSetup(runner:ProcessRunner,command:string,timeoutMs=8000):Promise<ClaudeSetupState>{
  if(!await runner.isAvailable(command))return 'missing';
  try{
    const h=runner.spawnLines({command,args:['auth','status','--json'],cwd:os.homedir()});
    const lines:string[]=[];const collect=(async()=>{for await(const l of h.stdoutLines)lines.push(l);})();
    const r=await Promise.race([h.exit,new Promise<any>(res=>setTimeout(()=>res({code:999}),timeoutMs))]);
    if(r.code===999){void h.cancel();return 'ready';}
    await collect;
    return parseAuthStatus(lines.join('\n'))===false?'loggedOut':'ready';
  }catch{return 'ready';}
}

export interface InstallOption { label:string; detail:string; command:string; recommended?:boolean }
/** Commands from code.claude.com/docs/en/setup. VS Code's default Windows terminal is PowerShell, hence `irm`. */
export function installOptions(platform:string=process.platform):InstallOption[]{
  const npm={label:'npm',detail:'Needs Node.js 22+',command:'npm install -g @anthropic-ai/claude-code@latest'};
  if(platform==='win32')return [
    {label:'Official installer',detail:'PowerShell, updates itself',command:'irm https://claude.ai/install.ps1 | iex',recommended:true},
    {label:'WinGet',detail:'Does not update itself',command:'winget install Anthropic.ClaudeCode'},npm];
  const opts:InstallOption[]=[{label:'Official installer',detail:'Updates itself',command:'curl -fsSL https://claude.ai/install.sh | bash',recommended:true}];
  if(platform==='darwin')opts.push({label:'Homebrew',detail:'Does not update itself',command:'brew install --cask claude-code'});
  opts.push(npm);return opts;
}

/**
 * VS Code captures PATH once at launch, so a CLI installed afterwards (the installer drops it in
 * `~/.local/bin` and edits the shell rc) is invisible until VS Code restarts. Only the default name is
 * resolved: a configured path or wrapper is the user's explicit choice and stays untouched.
 */
export function resolveClaudeExecutable(configured:string,o:{env?:any;platform?:string;home?:string;exists?:(p:string)=>boolean}={}):string{
  if(configured&&configured!=='claude')return configured;
  const env=o.env??process.env,platform=o.platform??process.platform,home=o.home??os.homedir();
  const exists=o.exists??((p:string)=>{try{return fs.statSync(p).isFile();}catch{return false;}});
  const p=platform==='win32'?path.win32:path.posix;const name=platform==='win32'?'claude.exe':'claude';
  for(const dir of String(env.PATH||env.Path||'').split(platform==='win32'?';':':'))if(dir&&exists(p.join(dir,name)))return 'claude';
  const known=platform==='win32'?[p.join(home,'.local','bin',name)]
    :[p.join(home,'.local','bin',name),'/opt/homebrew/bin/claude','/usr/local/bin/claude',p.join(home,'.claude','local','claude')];
  return known.find(exists)||'claude';
}

/** The CLI's own wording ("Not logged in · Please run /login") points at a slash command Dev Hub can't run. */
export function isNotLoggedInError(message:string):boolean{return /not logged in|not signed in|please run \/login|authentication_failed/i.test(message||'');}
