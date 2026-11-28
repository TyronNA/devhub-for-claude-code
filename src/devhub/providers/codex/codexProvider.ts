import { AgentProvider, ProviderTurnHandle, StartSessionInput, ResumeSessionInput } from '../provider';
import { ProcessRunner } from '../processRunner';
import { DevHubEvent, DevHubProject, DevHubSession } from '../../types';
import { parseCodexEvent, extractCodexSessionId, codexErrorText } from './codexEventParser';
import { CodexFileFacts, discoverCodexHistory, findCodexTranscript, listCodexImages, loadCodexTranscript, loadCodexContext } from './codexHistory';
import { codexContextWindow } from './codexConfig';
import { refreshCodexCatalog } from './codexCatalog';
import { CodexAppServer } from './codexAppServer';
import { HistoryScanCache } from '../historyUtils';

/** The `-c sandbox_mode` value. `''` = leave the user's config.toml alone. */
export type CodexSandbox=''|'read-only'|'workspace-write'|'danger-full-access';

const os=require('node:os');
const nodePath=require('node:path');
/**
 * `codex exec` FORCES `approval_policy=never` — measured on 0.154.0: passing
 * `-c approval_policy="on-request"` directly still records `never` in the rollout. So whatever the sandbox blocks
 * dies on the spot, with no permission step. The only way left without removing the sandbox
 * entirely is to open extra writable roots.
 * VS Code settings do NOT expand `~`, and people naturally type `~/...`; relative paths
 * are dropped because they would resolve against each chat's cwd and become a different fence per tab.
 */
export function codexWritableRoots(input:any):string[]{
  const out:string[]=[];
  for(const raw of Array.isArray(input)?input:[]){
    if(typeof raw!=='string')continue;
    let p=raw.trim(); if(!p)continue;
    if(p==='~'||p.startsWith('~/'))p=nodePath.join(os.homedir(),p.slice(1));
    if(!nodePath.isAbsolute(p))continue;
    p=nodePath.resolve(p);
    if(!out.includes(p))out.push(p);
  }
  return out.slice(0,32);
}

export class CodexProvider implements AgentProvider {
  readonly id='codex' as const; private availableCache:{at:number;value:boolean}|undefined; private transcriptIndex=new Map<string,string>(); private scanCache=new HistoryScanCache<CodexFileFacts>();
  constructor(private runner:ProcessRunner, private executable='codex',private maxHistory=1500,private historyRoot?:string,private developerInstructions?:string,private sandbox:CodexSandbox='workspace-write',writableRoots:any=[]){this.writableRoots=codexWritableRoots(writableRoots);}
  private writableRoots:string[];
  async isAvailable(){if(this.availableCache&&Date.now()-this.availableCache.at<60000)return this.availableCache.value;const value=await this.runner.isAvailable(this.executable);this.availableCache=value?{at:Date.now(),value}:undefined;if(value)void refreshCodexCatalog(this.executable);return value;}
  async start(input:StartSessionInput){return this.launch(input.cwd,input.prompt,undefined,input);}
  async resume(input:ResumeSessionInput){return this.launch(input.session.cwd,input.prompt,input.session.nativeSessionId,input);}
  private async launch(cwd:string,prompt:string,resumeId?:string,opts:{model?:string;effort?:string;images?:string[]}={}):Promise<ProviderTurnHandle>{ const args=['exec','--json','--skip-git-repo-check'];
    // `-s/--sandbox` does NOT exist on `codex exec resume` (checked on 0.153.4), while
    // `-c sandbox_mode` works on both. Unset, exec runs read-only with approval
    // policy `never` — the agent can neither write files nor ask for more access.
    if(this.sandbox)args.push('-c',`sandbox_mode=${JSON.stringify(this.sandbox)}`);
    // `-c` values are parsed as TOML; a JSON array of strings is also a valid TOML array.
    if(this.writableRoots.length)args.push('-c',`sandbox_workspace_write.writable_roots=${JSON.stringify(this.writableRoots)}`);
    if(opts.model)args.push('-m',opts.model); if(opts.effort)args.push('-c',`model_reasoning_effort=${JSON.stringify(opts.effort)}`); if(this.developerInstructions)args.push('-c',`developer_instructions=${JSON.stringify(this.developerInstructions)}`);
    if(resumeId)args.push('resume',resumeId);
    for(const image of opts.images||[])args.push('-i',image);
    // exec's variadic -i otherwise consumes resume/id/the stdin marker as image paths.
    args.push('--','-');
    // `-` = read the prompt from stdin; keeps it out of argv in `ps` and under ARG_MAX.
    const p=this.runner.spawnLines({command:this.executable,args,cwd,stdinText:prompt}); let nativeId=resumeId;
    const window=codexContextWindow(opts.model);
    /**
     * Images generated during the turn only live on disk: snapshot BEFORE the turn (for a new session the folder
     * doesn't exist yet, empty snapshot) then take the difference at the end. `emitted` keeps the error path and
     * `turn.completed` from emitting the same image twice.
     */
    const emitted=new Set<string>(); const historyRoot=this.historyRoot;
    const baseline=(async()=>{ if(resumeId)for(const i of await listCodexImages(resumeId,historyRoot))emitted.add(i.path); })();
    const newImages=async():Promise<DevHubEvent[]>=>{
      if(!nativeId)return [];
      try{ await baseline;
        const fresh=(await listCodexImages(nativeId,historyRoot)).filter(i=>!emitted.has(i.path));
        for(const i of fresh)emitted.add(i.path);
        return fresh.map(i=>({type:'assistant_image',path:i.path,alt:'Generated image',timestamp:Date.now()} as DevHubEvent));
      }catch{return [];}
    };
    const readContext=async()=>{
      if(!nativeId)return undefined;
      let file=this.transcriptIndex.get(nativeId);
      if(!file){file=await findCodexTranscript(nativeId,this.historyRoot,this.maxHistory);if(file)this.transcriptIndex.set(nativeId,file);}
      return file?loadCodexContext(file):undefined;
    };
    const events=(async function*(){const stderr:string[]=[];const stderrTask=(async()=>{for await(const l of p.stderrLines)if(stderr.join('\n').length<65536)stderr.push(l);})();try{for await(const line of p.stdoutLines){let raw:any;try{raw=JSON.parse(line);}catch{continue;}nativeId=extractCodexSessionId(raw)||nativeId;
      // Before `turn_done`, so the image sits in the right place in the turn, as when the transcript is reread.
      if(raw?.type==='turn.completed')for(const ev of await newImages())yield ev;
      for(const ev of parseCodexEvent(raw)){if(ev.type==='usage'&&window&&ev.usage.contextWindowTokens==null)ev.usage.contextWindowTokens=window;
        yield ev;}}const exit=await p.exit;await stderrTask;
      for(const ev of await newImages())yield ev;
      // A missing rollout must not turn a successful CLI run into a failed turn.
      try{const usage=await readContext();if(usage)yield {type:'usage',usage,timestamp:Date.now()} as DevHubEvent;}catch{}
      if(exit.code!==0){const tail=stderr.join('\n').slice(-4000);
        let text=tail;
        // stderr is sometimes one-line JSON; prefer the readable sentence.
        for(const line of tail.split('\n').reverse()){
          const t=line.trim(); if(!t.startsWith('{'))continue;
          try{const m=codexErrorText(JSON.parse(t)); if(m&&m!=='Codex turn failed'){text=m;break;}}catch{}
        }
        yield {type:'error',message:`Codex exited ${exit.code}: ${text}`,timestamp:Date.now()} as DevHubEvent;}}catch(e:any){yield {type:'error',message:`Codex failed: ${e?.message||e}`,timestamp:Date.now()} as DevHubEvent;}})(); return {events,cancel:p.cancel,getNativeSessionId:()=>nativeId}; }

  /** Real context compaction over the app-server; `sendPrompt('/compact')` only sends text to the model. */
  async compact(session:DevHubSession,onEvent:(e:DevHubEvent)=>void){
    const server=new CodexAppServer(this.runner,this.executable);
    return server.compact(session.nativeSessionId,session.cwd,onEvent,
      {beforeTokens:session.usage?.contextUsedTokens});
  }

  discoverHistory(projects:DevHubProject[]){return discoverCodexHistory(projects,this.historyRoot,this.maxHistory,this.transcriptIndex,this.scanCache);}
  async loadTranscript(session:DevHubSession){let f=this.transcriptIndex.get(session.nativeSessionId);if(!f){f=await findCodexTranscript(session.nativeSessionId,this.historyRoot,this.maxHistory);if(f)this.transcriptIndex.set(session.nativeSessionId,f);}if(!f)throw new Error('Codex transcript not found');return loadCodexTranscript(f);}
}
