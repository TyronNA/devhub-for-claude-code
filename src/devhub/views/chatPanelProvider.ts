const vscode:any=require('vscode');
const crypto=require('node:crypto');
const fsp=require('node:fs/promises');
const fsSync=require('node:fs');
const nodePath=require('node:path');
import { DevHubEvent, DevHubProject, DevHubSession, DevHubWorkspace, ProviderId } from '../types';
import { SessionManager } from '../sessions/sessionManager';
import { AgentProvider } from '../providers/provider';
import { coalesceSessionDeltas, EventBatcher } from '../ui/eventBatcher';
import { recoverImages } from '../providers/claude/claudeProvider';
import { parseWebviewMessage } from './webviewProtocol';
import { localMediaRoots } from './localMedia';
import { plannerConversationId } from '../sessions/plannerIdentity';
import { SessionEventCache } from '../sessions/sessionEventCache';
import { mergeTranscript, rereadsTranscript } from '../sessions/transcriptMerge';
import { QueueStore } from '../storage/queueStore';
import { providerLabel } from '../ui/format';
import { GitStatusWatcher } from '../workspace/gitStatusWatcher';

interface Draft {workspace:DevHubWorkspace;project:DevHubProject;provider:ProviderId;}
/** One tab = one webview panel. A draft tab switches its key to the session key as soon as the first turn runs. */
interface QueuedPrompt {text:string;images?:string[];}
interface Tab {key:string;panel:any;session?:DevHubSession;draft?:Draft;workspace?:DevHubWorkspace;project?:DevHubProject;batcher:EventBatcher<any>;model?:string;effort?:string;disposed:boolean;
  /** Messages typed while a turn is running. The host keeps the list; the webview only displays it. */
  queue:QueuedPrompt[];starting?:boolean;flushing?:boolean;}

const ATTACHMENT_TTL_MS=48*60*60*1000;
const PRUNE_EVERY_MS=6*60*60*1000;
const PERM_TIMEOUT_MS=5*60*1000;
// Opening a tab / clicking the chip accepts a git result up to 2s old; don't rerun git on every click.
const HOT_SCM_MS=2000;
// A question blocks the whole turn and must wait for a real person; the 5 minutes of a tool approval is too short.
const ASK_TIMEOUT_MS=60*60*1000;
// Effort is a fixed CLI flag so it stays in code; the MODEL list lives in settings because it keeps changing.
const EFFORTS:Record<string,string[]>={claude:['low','medium','high','xhigh','max']};
function cfg(){return vscode.workspace.getConfiguration('devHub');}
function modelChoices(provider:string):string[]{const v=cfg().get(`${provider}.models`,[]);return Array.isArray(v)?v.filter((x:any)=>typeof x==='string'):[];}
function defaultsFor(provider:string){return {model:cfg().get(`${provider}.model`,'')||undefined,effort:cfg().get(`${provider}.effort`,'')||undefined};}
const EXT:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};

/**
 * A provider's model/effort choices. Exported because the mobile server builds this exact list
 * too — two places computing it themselves are two places that drift apart.
 */
export function optionChoices(provider:string,kind:'model'|'effort',model?:string):Array<{label:string;description?:string;value:string}>{
  const list=kind==='model'?modelChoices(provider):(EFFORTS[provider]||[]);
  return list.map((v:string)=>({label:v,value:v}));
}
/**
 * Attached images may only live in the folder Dev Hub writes itself. `attachments` are paths
 * sent up by the client that go straight into the prompt (appended to Claude's prompt), so a
 * broken client could point at any file. Returns the first bad path, undefined if clean.
 */
export function foreignAttachment(paths:string[]|undefined,dir:string):string|undefined{
  const root=nodePath.resolve(dir)+nodePath.sep;
  return (paths||[]).find(p=>!nodePath.resolve(String(p)).startsWith(root));
}
/** Time label in the history QuickPick; the exact time is already in `detail`. */
function ago(at:number){const m=Math.round((Date.now()-at)/60000);
  if(m<1)return 'just now'; if(m<60)return `${m}m ago`;
  const h=Math.round(m/60); return h<24?`${h}h ago`:`${Math.round(h/24)}d ago`;}
/** A session that belongs to no project (planner) takes the start of its title as the tab title. */
export function shortTabTitle(title:string|undefined){
  const head=String(title||'').split(' \u00b7 ')[0].trim();
  return head?(head.length>24?head.slice(0,23)+'\u2026':head):undefined;
}
/** Default model/effort come from settings; a new session opened from mobile must match the panel too. */
export function defaultTurnOptions(provider:string){return defaultsFor(provider);}

export class ChatPanelProvider {
  private tabs=new Map<string,Tab>();
  private active?:Tab;
  private buffers=new SessionEventCache<DevHubEvent>(12,1500);
  /** key -> number of events at the start of the buffer that came from `loadTranscript`; see `mergeTranscript`. */
  private historyLen=new Map<string,number>();
  private disposers:Array<()=>void>=[];
  private lastSelected?:DevHubSession;
  /** requestId -> cancel timer. The CLI blocks until a control_response, so every
   *  exit path (tab close, expiry, dispose) must answer DENY. */
  private pendingPerms=new Map<string,{provider:string;sessionId:string;timer:any;input?:any;req:any}>();
  /** The column of the editor group holding Dev Hub. Pinned so the 2nd tab onwards sits next to the old one
   *  instead of `Beside` opening a new split every time. */
  private column?:number;

  constructor(
    private manager:SessionManager,
    private providers:Record<string,AgentProvider>,
    private lookup:()=>Promise<{workspaces:DevHubWorkspace[];projects:DevHubProject[]}>,
    private onSelection:(s?:DevHubSession)=>void,
    private onSessionChanged:()=>void,
    private onUsageChanged:()=>void,
    private storageDir:string='',
    private mediaRoot:string='',
    private findSession:(provider:string,id:string)=>Promise<DevHubSession|undefined>=async()=>undefined,
    private answerPermission:(provider:string,sessionId:string,requestId:string,allow:boolean,updatedInput?:any)=>void=()=>{},
    private listSessions:()=>Promise<DevHubSession[]>=async()=>[],
    private refreshHistory:()=>Promise<void>=async()=>{},
  ){
    this.disposers.push(
      manager.on('event',(x:any)=>this.onEvent(x)),
      manager.on('sessionUpdated',(s:any)=>this.onSessionUpdated(s)),
      manager.on('sessionRekeyed',(x:any)=>this.onRekey(x)),
      manager.on('sessionAdded',()=>this.onSessionChanged()),
    );
    void this.pruneAttachments();
    // Sweeping only once at construction means the 48h TTL is never enforced in a window left open all week.
    this.pruneTimer=setInterval(()=>void this.pruneAttachments(),PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
  }
  private pruneTimer:any;
  dispose(){clearInterval(this.pruneTimer);this.pruneTimer=undefined;
    for(const id of [...this.pendingPerms.keys()])this.settlePerm(id,false);
    for(const d of this.disposers)d();for(const t of this.tabs.values()){t.batcher.dispose();t.panel?.dispose();}this.tabs.clear();}

  /**
   * Webview panels are destroyed on Reload Window. The serializer receives the panel VS Code rebuilt
   * along with the webview state saved via `setState`, and re-attaches it to a Tab as if nothing happened.
   */
  registerSerializer(context:any){
    const api=vscode.window.registerWebviewPanelSerializer?.('devHub.chat',{
      deserializeWebviewPanel:async(panel:any,state:any)=>{await this.adopt(panel,state);},
    });
    if(api)context.subscriptions.push(api);
  }
  private async adopt(panel:any,state:any){
    // A reload/tab close can destroy the panel between two awaits of the serializer; if the panel is dead, skip hydrating.
    let disposed=false;const watch=panel.onDidDispose?.(()=>{disposed=true;});
    try{
      const provider=state?.provider,id=state?.nativeSessionId;
      const session=(provider&&id)?await this.findSession(provider,id):undefined;
      if(disposed)return;
      if(!session)return await this.adoptDraft(panel,state,()=>disposed);
      const snap=await this.lookup();
      if(disposed)return;
      const key=this.sessionKey(session.provider,session.nativeSessionId);
      const existing=this.tabs.get(key);
      if(existing){panel.dispose();return;}
      const tab=this.attach(key,panel,{session,
        workspace:snap.workspaces.find(w=>w.id===session.workspaceId),
        project:snap.projects.find(p=>p.id===session.projectId),
        model:session.model??(typeof state?.model==='string'&&state.model?state.model:defaultsFor(session.provider).model),
        effort:session.effort??(typeof state?.effort==='string'&&state.effort?state.effort:defaultsFor(session.provider).effort)});
      if(panel.viewColumn)this.column=panel.viewColumn;
      this.retitle(tab);
      await this.pushSession(tab);
    }finally{watch?.dispose?.();}
  }

  /**
   * A tab that hasn't sent anything has no session to look up; it is only workspace+project+provider.
   * Without rebuilding it, Reload Window throws away the tab and the text being typed in it.
   */
  private async adoptDraft(panel:any,state:any,isDisposed:()=>boolean=()=>false){
    const d=state?.draft;
    if(!d?.workspaceId||!d?.projectId){panel.dispose();return;}
    const snap=await this.lookup();
    if(isDisposed())return;
    const workspace=snap.workspaces.find(w=>w.id===d.workspaceId);
    const project=snap.projects.find(p=>p.id===d.projectId);
    if(!workspace||!project){panel.dispose();return;}
    const providerId='claude' as ProviderId;
    const draft:Draft={workspace,project,provider:providerId};
    const def=defaultsFor(providerId);
    const tab=this.attach(`draft:${crypto.randomUUID()}`,panel,{draft,workspace,project,
      model:typeof state?.model==='string'&&state.model?state.model:def.model,
      effort:typeof state?.effort==='string'&&state.effort?state.effort:def.effort});
    if(panel.viewColumn)this.column=panel.viewColumn;
    if(tab.disposed)return;
    this.retitle(tab);
    this.post(tab,{type:'draftSelected',draft,events:[]});
    this.postOptions(tab);
    this.refreshScm(tab);
  }

  // ---------- open / create tab ----------
  async restoreSelection(session:DevHubSession){
    if(this.tabs.size)return;
    await this.openSession(session);
  }
  currentSessionId(){return this.active?.session?.nativeSessionId??this.lastSelected?.nativeSessionId;}
  showCurrent(){if(this.active){this.active.panel.reveal(this.column??vscode.ViewColumn.Beside,false);return;}if(this.lastSelected)void this.openSession(this.lastSelected);}

  async newChat(workspace:DevHubWorkspace,project:DevHubProject,provider:ProviderId){
    const adapter=this.providers[provider];
    if(!adapter||!await adapter.isAvailable())throw new Error(`${providerLabel(provider)} unavailable — configure devHub.${provider}.${provider==='planner'?'endpoint':'executable'}`);
    const draft:Draft={workspace,project,provider};
    const d=defaultsFor(provider);
    const tab=this.createTab(`draft:${crypto.randomUUID()}`,{draft,workspace,project,model:d.model,effort:d.effort});
    this.focus(tab);
    this.post(tab,{type:'draftSelected',draft,events:[]});
    this.postOptions(tab);
    this.refreshScm(tab);
  }

  async openSession(session:DevHubSession){
    const key=this.sessionKey(session.provider,session.nativeSessionId);
    const snap=await this.lookup();
    const workspace=snap.workspaces.find(w=>w.id===session.workspaceId);
    const project=snap.projects.find(p=>p.id===session.projectId);
    let tab=this.tabs.get(key);
    if(!tab){const d=defaultsFor(session.provider);tab=this.createTab(key,{session,workspace,project,model:session.model??d.model,effort:session.effort??d.effort});}
    else Object.assign(tab,{session,workspace,project});
    this.focus(tab);
    this.lastSelected=session;this.onSelection(session);
    await this.pushSession(tab);
  }

  private async pushSession(tab:Tab){
    const session=tab.session; if(!session||tab.disposed)return;
    const key=this.sessionKey(session.provider,session.nativeSessionId);
    let events=this.buffers.get(key);
    const reread=!!events?.length&&rereadsTranscript(session)&&!this.manager.isBusy(session.provider,session.nativeSessionId);
    if(!events?.length||reread){
      try{
        const loaded=(await this.providers[session.provider].loadTranscript(session)).map(e=>this.recoverImages(e));
        if(tab.disposed)return;
        const merged=mergeTranscript(loaded,this.buffers.get(key)||[],reread?this.historyLen.get(key)||0:0,session.provider!=='planner');
        events=this.buffers.set(key,merged.events);
        // `set()` trims from the START when over the limit, so the history prefix shrinks by exactly the number of events trimmed.
        this.historyLen.set(key,Math.max(0,merged.historyLen-(merged.events.length-events.length)));
      }catch(e:any){
        if(tab.disposed)return;
        // If the re-read fails keep the buffer: one failed daemon call must not blank a tab
        // that has content, nor mark the session unavailable.
        events=reread?this.buffers.get(key)??[]:[];
        if(!reread&&session.status!=='running'){tab.session=await this.manager.markUnavailable(session);if(tab.disposed)return;}
        this.post(tab,{type:'error',message:`Transcript unavailable: ${e?.message||e}`});
      }
    }
    if(tab.disposed)return;
    if(tab.disposed)return;
    this.postSessionSelected(tab,tab.session!,events);
    this.postOptions(tab);
    this.replayPerms(tab);
    await this.restoreLostQueue(tab);
  }

  /** Every path that sends `sessionSelected` must go through here: skipping `forWebview` drops `imageSrcs`
   *  and the webview has nothing to draw. */
  private postSessionSelected(tab:Tab,session:DevHubSession,events:any[]){
    this.post(tab,{type:'sessionSelected',session,events:events.map((e:any)=>this.forWebview(tab,e)),
      workspace:tab.workspace,project:tab.project});
    this.refreshScm(tab);
  }

  private createTab(key:string,init:Partial<Tab>):Tab{
    const title=init.project?`${init.project.name}`:(shortTabTitle(init.session?.title)??'Dev Hub');
    const column=this.column??vscode.ViewColumn.Beside;
    const panel=vscode.window.createWebviewPanel('devHub.chat',title,{viewColumn:column,preserveFocus:false},{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:this.imageRoots()});
    this.column=panel.viewColumn??(typeof column==='number'?column:this.column);
    return this.attach(key,panel,init);
  }
  /** Images the user attached and media the agent mentions (`localMediaRoots`). */
  private imageRoots(){return [this.attachmentDir(),...localMediaRoots()].map(p=>vscode.Uri.file(p));}
  /** The webview can't call `asWebviewUri` itself; give it the `/` base so it can join absolute paths onto it. */
  private postMediaBase(tab:Tab){try{this.post(tab,{type:'mediaBase',base:String(tab.panel.webview.asWebviewUri(vscode.Uri.file('/'))).replace(/\/$/,'')});}catch{}}
  private attach(key:string,panel:any,init:Partial<Tab>):Tab{
    const tab:Tab={key,panel,batcher:undefined as any,queue:[],disposed:false,...init};
    // A panel restored after reload carries old options; reassign them before writing html.
    if(panel.webview)panel.webview.options={enableScripts:true,localResourceRoots:this.imageRoots()};
    tab.batcher=new EventBatcher<any>(items=>this.post(tab,{type:'eventBatch',items:coalesceSessionDeltas(items)}),40);
    panel.webview.html=this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m:any)=>this.handleMessage(tab,m));
    panel.onDidDispose(()=>{tab.disposed=true;if(tab.session)this.denyPermsFor(this.providerOf(tab),tab.session.nativeSessionId);tab.batcher.dispose();if(this.tabs.get(tab.key)===tab)this.tabs.delete(tab.key);if(this.active===tab)this.active=undefined;});
    panel.onDidChangeViewState?.((e:any)=>{const w=e?.webviewPanel;if(w?.viewColumn)this.column=w.viewColumn;if(w?.active)this.active=tab;});
    this.tabs.set(key,tab);
    return tab;
  }
  private focus(tab:Tab){this.active=tab;tab.panel.reveal(this.column??vscode.ViewColumn.Beside,false);}
  private retitle(tab:Tab){
    tab.panel.title=tab.project?.name??shortTabTitle(tab.session?.title)??'Dev Hub';
    // The logo goes on the tab instead of a "Claude ·" prefix.
    if(this.providerOf(tab)==='planner'){tab.panel.iconPath=new vscode.ThemeIcon('robot');return;}
    if(this.mediaRoot){
      const base='claude';
      tab.panel.iconPath={light:vscode.Uri.file(nodePath.join(this.mediaRoot,`${base}-light.svg`)),
                          dark:vscode.Uri.file(nodePath.join(this.mediaRoot,`${base}-dark.svg`))};
    }
  }

  // ---------- messages from the webview ----------
  private async handleMessage(tab:Tab,raw:any){
    try{
      const m=parseWebviewMessage(raw); if(!m){
        if(raw?.type==='pasteImage')this.post(tab,{type:'attachmentError',requestId:raw.requestId,message:'Invalid image or over the 9 MiB limit.'});
        return;
      }
      if(m.type==='ready'){this.retitle(tab);this.postMediaBase(tab);
        if(tab.session)await this.pushSession(tab);else if(tab.draft)this.post(tab,{type:'draftSelected',draft:tab.draft,events:[]});else this.post(tab,{type:'empty'});
        this.postOptions(tab);this.postQueue(tab);this.refreshScm(tab);return;}
      if(m.type==='dequeue'){const i=Number(m.index);
        if(Number.isInteger(i)&&i>=0&&i<tab.queue.length){tab.queue.splice(i,1);this.postQueue(tab);}return;}
      // The "Back" of a phone app: reopen the sidebar with the session tree. `<viewId>.focus` is
      // a command VS Code registers for every contributed view. Only runs when the user clicks —
      // there is NO reverse direction: auto-closing the sidebar would close it again right after you open it, which is silly.
      // The layout belongs to the user; the extension only moves when clicked.
      if(m.type==='newTab'){await this.openPickerChat(tab);return;}
      if(m.type==='pickProvider'){await this.changeProvider(tab);return;}
      if(m.type==='pickProject'){await this.changeProject(tab);return;}
      if(m.type==='pickHistory'){await this.pickHistory(tab);return;}
      if(m.type==='pickSlash'){await this.pickSlash(tab);return;}
      if(m.type==='pickChanged'){await this.pickChanged(tab);return;}
      if(m.type==='pickModel'){await this.pickOption(tab,'model');return;}
      if(m.type==='pickEffort'){await this.pickOption(tab,'effort');return;}
      if(m.type==='permissionResponse'){
        const id=tab.session?.nativeSessionId; if(!id)return;
        this.settlePerm(m.requestId,m.allow,m.answers); void id; return;}
      if(m.type==='pasteImage'){
        try{await this.saveAttachment(tab,m.mime,m.data,m.requestId);}
        catch{this.post(tab,{type:'attachmentError',requestId:m.requestId,message:'Could not save the image. Please pick it again.'});}
        return;
      }
      if(m.type==='cancel'&&tab.session){
        await this.manager.cancel(tab.session.provider,tab.session.nativeSessionId);return;}
      if(m.type==='compact'){await this.compact(tab);return;}
      if(m.type==='copySessionId'){
        // Planner: the store ID is scoped per daemon; what can be traced is the original conversation —
        // exactly like devhub.copySessionId in the tree.
        const s=tab.session; if(!s)return;
        await vscode.env.clipboard.writeText(s.provider==='planner'?plannerConversationId(s.nativeSessionId):s.nativeSessionId);
        vscode.window.setStatusBarMessage('Dev Hub session ID copied',1500);return;}
      if(m.type==='openLink'){await vscode.env.openExternal(vscode.Uri.parse(m.href));return;}
      if(m.type==='openFile'){await this.openPath(m.path);return;}
      if(m.type==='sendPrompt'){
        const text=String(m.text||'').trim();
        const images=m.attachments;
        const foreign=foreignAttachment(images,this.attachmentDir());
        if(foreign){this.fail(tab,`Refused an attachment outside the Dev Hub attachment folder: ${foreign}`);return;}
        // Attaching only an image, with no text, is a valid message — it used to be dropped silently here
        // while the webview had already cleared the image chip, so the image vanished without a word.
        if(!text&&!images?.length)return;
        if(tab.session){
          // A turn is running: queue instead of dropping silently. Flush when the status leaves 'running'.
          if(tab.session.status==='running'||this.manager.isBusy(tab.session.provider,tab.session.nativeSessionId)){
            tab.queue.push({text,images});this.postQueue(tab);return;}
          // The turn is idle but the queue still has messages (the previous send failed): a failed resume does NOT emit
          // `sessionUpdated`, so nothing calls scheduleFlush. Treating `queue.length` as a reason
          // to keep queuing makes the tab write-only. Queue the new message at the end, then run the head of the queue.
          let head:QueuedPrompt={text,images};
          if(tab.queue.length){tab.queue.push(head);head=tab.queue.shift()!;this.postQueue(tab);}
          // The webview cleared the input and image chips on send; a failed send that doesn't put the message back in the
          // queue loses the typed text. The other two branches (flushQueue, start) already do exactly that.
          try{
            tab.session=await this.manager.resume(tab.session,head.text,{model:tab.model,effort:tab.effort,images:head.images});
          }catch(e){tab.queue.unshift(head);this.postQueue(tab);throw e;}
          this.lastSelected=tab.session;this.onSelection(tab.session);
          await this.pushSession(tab);
        }else if(tab.draft){
          // Pressing Enter twice before the session exists would create two sessions.
          if(tab.starting){tab.queue.push({text,images});this.postQueue(tab);return;}
          // If the previous start failed, the queue still holds the old message and there is no session to flush into yet.
          // Sending the new message directly would reorder them — queue it at the end, then run the head of the queue.
          let head:QueuedPrompt={text,images};
          if(tab.queue.length){tab.queue.push(head);head=tab.queue.shift()!;this.postQueue(tab);}
          tab.starting=true;
          try{
          const d=tab.draft;
          const s=await this.manager.start({provider:d.provider,workspaceId:d.workspace.id,projectId:d.project.id,cwd:d.project.rootPath,prompt:head.text,model:tab.model,effort:tab.effort,images:head.images});
          tab.session=s;tab.workspace=d.workspace;tab.project=d.project;tab.draft=undefined;
          this.rekeyTab(tab,this.sessionKey(s.provider,s.nativeSessionId));
          this.retitle(tab);
          this.lastSelected=s;this.onSelection(s);
          this.postSessionSelected(tab,s,this.buffers.get(tab.key)??[]);
          }catch(e){tab.queue.unshift(head);this.postQueue(tab);throw e;}
          finally{tab.starting=false;}
        }
        return;
      }
    }catch(e:any){this.fail(tab,e?.message||String(e));}
  }

  /**
   * Claude compacts with the CLI's real slash command; the planner is an HTTP daemon with no notion of compaction.
   */
  private async compact(tab:Tab){
    const session=tab.session;
    if(!session){this.post(tab,{type:'error',message:'Nothing to compact yet — send a message first.'});return;}
    if(session.status==='running'){this.post(tab,{type:'error',message:'Wait for the current turn to finish before compacting.'});return;}
    if(session.provider==='claude'){
      tab.session=await this.manager.resume(session,'/compact',{model:tab.model,effort:tab.effort});
      this.lastSelected=tab.session;this.onSelection(tab.session);
      return;
    }
    this.post(tab,{type:'error',message:`${providerLabel(session.provider)} sessions have no compaction.`});
  }

  /** `showTextDocument` opens a PNG as garbage characters; images must go through `vscode.open`. */
  private async openPath(p:string){
    const uri=vscode.Uri.file(p);
    if(Object.values(EXT).includes(nodePath.extname(p).slice(1).toLowerCase()))
      await vscode.commands.executeCommand('vscode.open',uri,{preview:true});
    else await vscode.window.showTextDocument(uri,{preview:true});
  }

  /**
   * Errors are records too. `post({type:'error'})` only draws one line and that's it — the next redraw
   * takes events from the host's buffer, where that line doesn't exist. Right when you need to look back
   * there is nothing to look at. A tab without a session yet (draft) can only send it bare.
   */
  private fail(tab:Tab,message:string){
    if(tab.session)this.emitLocal(tab,{type:'error',message,timestamp:Date.now()});
    else this.post(tab,{type:'error',message});
  }
  /** Events produced by the panel itself: buffer them first, or they die on the next redraw. */
  private emitLocal(tab:Tab,event:DevHubEvent){
    const id=tab.session?.nativeSessionId; if(!id)return;
    this.buffers.append(this.sessionKey(this.providerOf(tab),id),event);
    this.post(tab,{type:'event',sessionId:id,event:this.forWebview(tab,event)});
  }
  /**
   * An event pushed in from outside that belongs to no turn (a planner reminder firing by itself).
   *
   * Only append when a buffer exists: appending to an empty key creates a buffer holding only this event, and
   * the next tab open sees a non-empty buffer and skips `loadTranscript` — the tab is left with a single
   * reminder line and loses all history. Without a buffer let the daemon tell it again (`/conversations`).
   */
  injectEvent(provider:ProviderId,nativeSessionId:string,event:DevHubEvent){
    const key=this.sessionKey(provider,nativeSessionId);
    if(this.buffers.get(key)?.length)this.buffers.append(key,event);
    for(const tab of this.tabsFor(provider,nativeSessionId))
      this.post(tab,{type:'event',sessionId:nativeSessionId,event:this.forWebview(tab,event)});
  }
  private recoverImages(event:any){return recoverImages(event,this.attachmentDir()+nodePath.sep);}
  private providerOf(tab:Tab):ProviderId{return (tab.draft?.provider??tab.session?.provider??'claude') as ProviderId;}
  private async pickOption(tab:Tab,kind:'model'|'effort'){
    const provider=this.providerOf(tab);
    let items:any[]=optionChoices(provider,kind,tab.model);
    items=[{label:'Default',value:undefined as any},...items,{label:'Custom\u2026',value:'__custom__'}];
    const pick=await vscode.window.showQuickPick(items,{placeHolder:`${providerLabel(provider)} ${kind}`});
    if(!pick)return;
    let value=pick.value;
    if(value==='__custom__'){value=await vscode.window.showInputBox({prompt:`${kind} value`,value:tab[kind]});if(value===undefined)return;value=value.trim()||undefined;}
    tab[kind]=value;
    // The choice belongs to the session, not the tab: closing and reopening the tab must keep the model just picked.
    if(tab.session)tab.session=await this.manager.setTurnOptions(tab.session,{model:tab.model,effort:tab.effort});
    // Via postOptions: a bare post lacks `slash`, and the webview reads `!!x.slash`, so the `/` button would disappear.
    this.postOptions(tab);
  }
  private rekeyTab(tab:Tab,next:string){if(tab.key===next)return;this.tabs.delete(tab.key);tab.key=next;this.tabs.set(next,tab);}

  /** Changing provider/project on a session that already ran opens a new draft — the old session's history isn't edited. */
  private async changeProvider(tab:Tab){
    const pick=await vscode.window.showQuickPick([{label:'Claude',id:'claude'}],{placeHolder:'Provider'});
    if(!pick)return;
    if(tab.draft){tab.draft={...tab.draft,provider:pick.id as ProviderId};const d=defaultsFor(pick.id);tab.model=d.model;tab.effort=d.effort;
      this.retitle(tab);this.post(tab,{type:'draftSelected',draft:tab.draft,events:[]});this.postOptions(tab);this.refreshScm(tab);return;}
    if(tab.workspace&&tab.project)await this.newChat(tab.workspace,tab.project,pick.id as ProviderId);
  }
  private async changeProject(tab:Tab){
    const target=await this.pickProject(); if(!target)return;
    const provider=tab.draft?.provider??tab.session?.provider??'claude';
    if(tab.draft){tab.draft={workspace:target.workspace,project:target.project,provider};tab.workspace=target.workspace;tab.project=target.project;this.retitle(tab);this.post(tab,{type:'draftSelected',draft:tab.draft,events:[]});this.refreshScm(tab);return;}
    await this.newChat(target.workspace,target.project,provider);
  }
  /**
   * The `+` button = a new chat RIGHT IN the open project, without asking for the project again — having to re-pick
   * every time would make it impossible to open another chat mid-conversation. Changing project is still the breadcrumb chip.
   */
  private async openPickerChat(tab:Tab){
    const provider=this.providerOf(tab);
    if(tab.workspace&&tab.project){await this.newChat(tab.workspace,tab.project,provider);return;}
    const target=await this.pickProject(); if(!target)return;
    await this.newChat(target.workspace,target.project,provider);
  }
  /** QuickPick has a built-in filter -> this doubles as the "quick project search" box. */
  /** The slash command list the CLI itself declares in `system init` — not hardcoded. */
  private async pickSlash(tab:Tab){
    const provider=this.providerOf(tab);
    const adapter:any=this.providers[provider];
    const id=tab.session?.nativeSessionId;
    const list:string[]=adapter?.slashCommands?.(id)||[];
    if(!list.length){
      vscode.window.showInformationMessage('Dev Hub: slash commands are read from the CLI on its first turn — send one message, then try again.');
      return;}
    const pick=await vscode.window.showQuickPick(list.map(c=>({label:'/'+c,cmd:c})),{placeHolder:'Slash command',matchOnDescription:true});
    if(!pick)return;
    this.post(tab,{type:'insertText',text:'/'+pick.cmd+' '});
  }
  /**
   * History of the open project. Rescan before listing: sessions opened from a terminal don't go
   * through Dev Hub, and the store is only as fresh as the last refresh (when the sidebar appeared).
   */
  private async pickHistory(tab:Tab){
    try{await this.refreshHistory();}catch{}
    const project=tab.project;
    const all=(await this.listSessions()).slice().sort((a,b)=>b.updatedAt-a.updatedAt);
    // Planner sessions belong to no project; on that tab filtering by projectId would come back empty.
    const list=project?all.filter(s=>s.projectId===project.id):all;
    if(!list.length){vscode.window.showInformationMessage(`Dev Hub: no earlier session${project?` in ${project.name}`:''} yet.`);return;}
    const items=list.slice(0,200).map(s=>({label:s.title||'(untitled)',
      description:`${providerLabel(s.provider)} \u00b7 ${s.status} \u00b7 ${ago(s.updatedAt)}`,
      detail:new Date(s.updatedAt).toLocaleString(),session:s}));
    const pick=await vscode.window.showQuickPick(items,{placeHolder:project?`History \u00b7 ${project.name}`:'History \u00b7 all projects',matchOnDescription:true,matchOnDetail:true});
    if(!pick)return;
    await this.openSession(pick.session);
  }
  private async pickProject(){
    const snap=await this.lookup();
    const items=snap.projects.map(p=>({label:p.name,description:snap.workspaces.find(w=>w.id===p.workspaceId)?.name,detail:p.rootPath,project:p}));
    const pick=await vscode.window.showQuickPick(items,{placeHolder:'Search project…',matchOnDescription:true,matchOnDetail:true});
    if(!pick)return;
    const workspace=snap.workspaces.find(w=>w.id===pick.project.workspaceId);
    return workspace?{workspace,project:pick.project}:undefined;
  }

  // ---------- pasted images ----------
  private attachmentDir(){return nodePath.join(this.storageDir||require('node:os').tmpdir(),'devhub','attachments');}
  private async saveAttachment(tab:Tab,mime:string,b64:string,requestId?:string){
    const dir=this.attachmentDir();
    await fsp.mkdir(dir,{recursive:true});
    const file=nodePath.join(dir,`${Date.now()}-${crypto.randomUUID().slice(0,8)}.${EXT[mime]||'png'}`);
    await fsp.writeFile(file,Buffer.from(b64,'base64'));
    // The path goes back to the webview, then travels with sendPrompt.attachments.
    this.post(tab,{type:'attachment',path:file,...(requestId?{requestId}:{})});
  }
  private async pruneAttachments(){
    try{
      const dir=this.attachmentDir(); const now=Date.now();
      for(const name of await fsp.readdir(dir)){
        const f=nodePath.join(dir,name);
        try{const st=await fsp.stat(f);if(now-st.mtimeMs>ATTACHMENT_TTL_MS)await fsp.rm(f,{force:true});}catch{}
      }
    }catch{}
  }

  /**
   * Images travel in events as PATHS, not 1.7MB of base64: the host cache and
   * the webview's `state.events` keep short strings. Only when sending are they turned into webview URIs, because
   * only the host can call `asWebviewUri` (and each tab has its own origin).
   */
  private forWebview(tab:Tab,event:any){
    // A data URI has no file to turn into a URI.
    const uri=(p:string)=>p.startsWith('data:')?p:String(tab.panel.webview.asWebviewUri(vscode.Uri.file(p)));
    try{
      if(event?.type==='assistant_image'&&event.path)return {...event,src:uri(event.path)};
      if(event?.type==='user_message'&&event.images?.length)return {...event,imageSrcs:event.images.map(uri)};
    }catch{}
    return event;
  }

  // ---------- events from the manager ----------
  private tabsFor(provider:string,sessionId:string){const t=this.tabs.get(this.sessionKey(provider,sessionId));return t?[t]:[];}
  private onEvent(x:any){
    const key=this.sessionKey(x.provider,x.sessionId);
    // Only a transient signal: buffering it, a few dozen events per turn would push the transcript out of the cache
    // and show up again when the session is reopened, though it means nothing by then.
    if(x.event.type==='thinking'){
      for(const tab of this.tabsFor(x.provider,x.sessionId))this.post(tab,{type:'event',sessionId:x.sessionId,event:x.event});
      return;
    }
    this.buffers.append(key,x.event,(previous,next)=>previous?.type==='assistant_delta'&&next?.type==='assistant_delta'?{...next,text:previous.text+next.text}
      // A later view frame CONTAINS the previous one; keeping both duplicates one answer 30 times in the cache.
      :previous?.type==='assistant_view'&&next?.type==='assistant_view'?next:undefined);
    for(const tab of this.tabsFor(x.provider,x.sessionId)){
      if(x.event.type==='assistant_delta')tab.batcher.push({sessionId:x.sessionId,event:x.event});
      else{tab.batcher.flush();this.post(tab,{type:'event',sessionId:x.sessionId,event:this.forWebview(tab,x.event)});}
    }
    if(x.event.type==='usage')this.onUsageChanged();
  }
  private queues?:QueueStore;
  private queueStore(){return this.queues??=new QueueStore(this.storageDir||require('node:os').tmpdir());}
  private postQueue(tab:Tab){
    this.post(tab,{type:'queue',items:tab.queue.map(q=>({text:q.text,images:q.images?.length??0}))});
    const id=tab.session?.nativeSessionId;
    if(id)void this.queueStore().save(this.sessionKey(this.providerOf(tab),id),tab.queue);
  }
  /** Text the user typed in a previous window: handed back to read/copy, NOT auto-sent. */
  private async restoreLostQueue(tab:Tab){
    const id=tab.session?.nativeSessionId; if(!id)return;
    const items=await this.queueStore().take(this.sessionKey(this.providerOf(tab),id));
    if(!items.length)return;
    this.emitLocal(tab,{type:'warning',timestamp:Date.now(),
      message:`Dev Hub restarted with ${items.length} message${items.length>1?'s':''} still queued — they were not sent:\n`+
        items.map(i=>'\u00b7 '+(i.text||`${i.images?.length??0} image(s)`)).join('\n')});
  }
  /**
   * `SessionManager.consume` removes the session from `active` in its `finally`, i.e. AFTER emitting
   * `sessionUpdated`. Sending right inside the handler hits `claim()` and gets refused, so it must be deferred.
   */
  private scheduleFlush(tab:Tab){
    if(!tab.queue.length||tab.flushing)return;
    tab.flushing=true;
    const t:any=setTimeout(()=>{void this.flushQueue(tab).finally(()=>{tab.flushing=false;});},0);
    t.unref?.();
  }
  private async flushQueue(tab:Tab){
    const session=tab.session;
    if(!session||session.status==='running'||!tab.queue.length)return;
    if(!this.tabs.get(tab.key))return;   // the tab was closed while waiting
    // Stop emits 'cancelled' before the stream finishes draining; sending into that only earns
    // "already running a turn" and prints an error in the chat. The final `sessionUpdated` will call again.
    if(this.manager.isBusy(session.provider,session.nativeSessionId))return;
    const next=tab.queue.shift()!;
    this.postQueue(tab);
    try{
      tab.session=await this.manager.resume(session,next.text,{model:tab.model,effort:tab.effort,images:next.images});
      this.lastSelected=tab.session;this.onSelection(tab.session);
    }catch(e:any){
      // Resend failed: put the message back at the head of the queue so the user's typed text isn't lost.
      tab.queue.unshift(next);this.postQueue(tab);
      this.fail(tab,e?.message||String(e));
    }
  }
  // Stop only kills the running turn: the queue lives on and `sessionUpdated` ('cancelled') will
  // flush it — pressing Stop then typing a new message is how you change direction, not how you discard what you typed.
  private onSessionUpdated(s:DevHubSession){
    if(s.status!=='running')this.closePerms(s.provider,s.nativeSessionId,'the turn ended');
    for(const tab of this.tabsFor(s.provider,s.nativeSessionId)){tab.session=s;this.post(tab,{type:'sessionUpdated',session:s});
      if(s.status!=='running')this.scheduleFlush(tab);}
    if(this.lastSelected&&this.lastSelected.provider===s.provider&&this.lastSelected.nativeSessionId===s.nativeSessionId){this.lastSelected=s;this.onSelection(s);}
    this.onSessionChanged();
  }
  private onRekey(x:any){
    const oldKey=this.sessionKey(x.provider,x.oldId),nextKey=this.sessionKey(x.provider,x.newId);
    this.buffers.move(oldKey,nextKey);
    const tab=this.tabs.get(oldKey);
    if(tab){tab.session=x.session;this.rekeyTab(tab,nextKey);this.post(tab,{type:'sessionUpdated',session:x.session});}
    if(this.lastSelected&&this.lastSelected.provider===x.provider&&this.lastSelected.nativeSessionId===x.oldId){this.lastSelected=x.session;this.onSelection(x.session);}
    this.onSessionChanged();
  }

  /** Always send AFTER sessionSelected/draftSelected — those two replace the whole webview state. */
  private postOptions(tab:Tab){
    const provider=this.providerOf(tab);
    const adapter:any=this.providers[provider];
    // A provider without slash commands (planner) — hide the button instead of reporting an error on every click.
    const slash=(adapter?.slashCommands?.(tab.session?.nativeSessionId)||[]).length>0;
    this.post(tab,{type:'optionsChanged',model:tab.model,effort:tab.effort,provider,slash});}
  /** A permission request from the CLI -> the tab of that exact session. */
  /** `false` = no tab took it and the request was denied — the caller shouldn't offer "Open" any more. */
  showPermission(provider:string,sessionId:string,req:any):boolean{
    const tab=this.tabs.get(this.sessionKey(provider,sessionId));
    if(!tab){this.answerPermission(provider,sessionId,req.requestId,false);
      this.noteDenied(provider,sessionId,`${req.displayName||req.toolName||'A tool'} request was denied automatically — no open Dev Hub tab for this session.`);return false;}
    const id=String(req.requestId);
    const ms=req.requiresUserInteraction||req.toolName==='AskUserQuestion'?ASK_TIMEOUT_MS:PERM_TIMEOUT_MS;
    const timer:any=setTimeout(()=>{const p=this.pendingPerms.get(id);if(p)this.closeCard(p,id,'expired');
      this.settlePerm(id,false,undefined,true);},ms);
    timer.unref?.();
    this.pendingPerms.set(id,{provider,sessionId,timer,input:req.input,req});
    this.permissionObserver?.();
    this.post(tab,{type:'permission',request:req});
    return true;
  }
  /** Answer exactly ONCE per requestId. */
  private settlePerm(requestId:string,allow:boolean,answers?:Record<string,string>,expired?:boolean){
    const p=this.pendingPerms.get(requestId); if(!p)return;
    clearTimeout(p.timer); this.pendingPerms.delete(requestId);
    if(expired)this.noteDenied(p.provider,p.sessionId,`${p.req?.displayName||p.req?.toolName||'A tool'} request expired without an answer and was denied.`);
    // AskUserQuestion is answered by allowing with `answers` put back into the input.
    const updatedInput=answers?{...(p.input||{}),answers}:undefined;
    this.answerPermission(p.provider,p.sessionId,requestId,allow,updatedInput);
    this.permissionObserver?.();
  }
  /**
   * The tree draws the "awaiting approval" icon by asking `isAwaitingPermission`, so it must be woken
   * at BOTH ends: when the question appears and when it is answered. A setter rather than a
   * constructor parameter — that already has 10 parameters, and this is the same wiring style as
   * `setPermissionSink`/`setSlashStore`. NOT `onSessionChanged`: that is a full refresh,
   * while approval questions come far more often and change nothing in ports/tasks.
   */
  private permissionObserver?:()=>void;
  setPermissionObserver(fn:()=>void){this.permissionObserver=fn;}
  /** Does this session have a pending approval request? LIVE state — an unanswered question
   *  isn't part of the session's history, so it doesn't go into the store. */
  isAwaitingPermission(provider:string,sessionId:string){
    for(const [,p] of this.pendingPerms)if(p.provider===provider&&p.sessionId===sessionId)return true;
    return false;
  }
  /** Approval/question cards only live in the webview DOM, and `sessionSelected` wipes the DOM —
   *  without resending, the CLI keeps blocking on an invisible question. */
  private replayPerms(tab:Tab){
    const id=tab.session?.nativeSessionId; if(!id)return;
    const provider=this.providerOf(tab);
    for(const [,p] of this.pendingPerms)
      if(p.provider===provider&&p.sessionId===id&&p.req)this.post(tab,{type:'permission',request:p.req});
  }
  /** A dead card is still in the DOM: lock it with the reason, or the user clicks into
   *  something nobody is listening to (`proc.write` quietly returns false once the process is gone). */
  private closeCard(p:{provider:string;sessionId:string},requestId:string,note:string){
    for(const tab of this.tabsFor(p.provider,p.sessionId))this.post(tab,{type:'permissionClosed',requestId,note});
  }
  /** The CLI blocks the whole turn while waiting for approval, so a turn that left 'running' = every pending request is
   *  dead. Without cleanup `replayPerms` keeps rebuilding them and the timer fires "expired" warnings into
   *  a session that finished long ago. Still deny, to keep the invariant "the CLI always gets an answer". */
  private closePerms(provider:string,sessionId:string,note:string){
    for(const [id,p] of [...this.pendingPerms]){
      if(p.provider!==provider||p.sessionId!==sessionId)continue;
      this.closeCard(p,id,note);
      this.settlePerm(id,false);
    }
  }
  /** A silent deny looks just like a tool that quietly never ran; it must leave a trace. Goes through `onEvent`
   *  so the warning lands in the buffer too and doesn't vanish when the transcript is reloaded. */
  private noteDenied(provider:string,sessionId:string,message:string){
    const event={type:'warning',message,timestamp:Date.now()} as DevHubEvent;
    if(this.tabsFor(provider,sessionId).length)this.onEvent({provider,sessionId,event});
    else vscode.window.showWarningMessage(`Dev Hub: ${message}`);
  }
  private denyPermsFor(provider:string,sessionId?:string){
    for(const [id,p] of [...this.pendingPerms])
      if(p.provider===provider&&(!sessionId||p.sessionId===sessionId))this.settlePerm(id,false);
  }
  /**
   * The git chip in the header. Git is read only when a VISIBLE tab points at that repo; a hidden tab
   * (`retainContextWhenHidden`) still has its DOM but nobody is looking, so running git for it burns CPU.
   */
  private git?:GitStatusWatcher;
  setGitWatcher(watcher:GitStatusWatcher){
    this.git=watcher;
    this.disposers.push(watcher.addSource(()=>[...this.tabs.values()]
      .filter(t=>t.panel?.visible&&t.project?.gitRoot)
      .map(t=>({root:t.project!.gitRoot!,hot:t.session?.status==='running'}))));
    this.disposers.push(watcher.on((root,status)=>{
      for(const t of this.tabs.values())if(t.project?.gitRoot===root)this.post(t,{type:'scm',status});
    }));
  }
  /** Send what we have right away (no flicker), then re-read; a missing `status` = hide the chip. */
  private refreshScm(tab:Tab){
    const root=tab.project?.gitRoot;
    this.post(tab,{type:'scm',status:root?this.git?.get(root):undefined});
    if(root&&this.git)void this.git.refresh(root,HOT_SCM_MS);
  }
  /** The dirty file list comes from git, not from the DOM — the webview only draws the numbers. */
  private async pickChanged(tab:Tab){
    const root=tab.project?.gitRoot; if(!root||!this.git)return;
    await this.git.refresh(root,HOT_SCM_MS);
    const changes=this.git.get(root)?.changes||[];
    if(!changes.length){vscode.window.showInformationMessage('Dev Hub: nothing changed in this project.');return;}
    const pick=await vscode.window.showQuickPick(changes.map(c=>({
      label:nodePath.basename(c.path),
      description:c.untracked?'untracked':`+${c.added} \u2212${c.removed}`,
      detail:c.path,
      file:nodePath.join(root,c.path)})),
      {placeHolder:`${changes.length} changed file${changes.length>1?'s':''} in ${tab.project?.name||''}`,matchOnDetail:true});
    if(pick)await this.openPath((pick as any).file);
  }
  private post(tab:Tab,message:any){
    // When the webview is dead the getter/postMessage may throw synchronously, not just return false.
    if(tab.disposed)return;
    try{tab.panel?.webview?.postMessage(message);}catch(e:any){
      if(tab.disposed||/webview is disposed/i.test(String(e?.message||e))){tab.disposed=true;return;}
      throw e;
    }
  }
  private sessionKey(p:string,id:string){return `sess:${p}:${id}`;}

  private html(webview:any){
    const nonce=crypto.randomBytes(16).toString('hex');
    const {css,script}=webviewAssets();
    // Images on disk load through the webview's own source; without it don't put `undefined`
    // into the CSP, leaving data: as the only fallback.
    const imgSrc=typeof webview?.cspSource==='string'?webview.cspSource:'';
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc} data:; media-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${chatBodyMarkup()}<script nonce="${nonce}">${script}</script></body></html>`;
  }
}

/**
 * CSP is `default-src 'none'`, and `localResourceRoots` only opens the media roots (attached
 * images, `~` and tmp for media the agent mentions) —
 * css/js still have to be read by the host and inlined into the HTML. Paths are computed from `__dirname`
 * (`dist/src/devhub/views` -> the extension root) so they are right both from the repo and inside the .vsix.
 */
/** The chat page body. Shared by the webview panel and the mobile server — two transports,
 *  one set of ids: `chat.js` looks them up with getElementById, and one mismatched id fails silently. */
export function chatBodyMarkup(){return `<header><div class="left"><button id="provider" class="chip" title="Change provider">Dev Hub</button><button id="crumb" class="chip ghost" title="Search project">—</button><span id="branch" class="chip ghost" hidden></span><button id="scm" class="chip ghost" title="Uncommitted changes" hidden></button></div><div class="right"><button id="copyid" class="chip ghost" title="Copy session ID" hidden>ID</button><button id="history" class="chip ghost" title="Open an earlier session in this project">\u{1F553}</button><span id="status"></span><button id="newtab" class="chip ghost" title="New chat in this project">+</button></div></header><main id="messages"><div class="empty">Select a session or start a new Claude chat.</div></main><footer><div id="thinking" hidden><span id="spinner"></span><span id="thinkword">Cooking</span><span id="thinktime"></span><span id="thinktokens"></span><button id="cancel" title="Stop this turn">Stop</button></div><div class="composer-box"><div id="queue"></div><div id="attachments"></div><textarea id="input" rows="3" placeholder="Ask Claude…"></textarea><div class="composerbar"><button id="attach" class="chip ghost" title="Attach an image">\u{1F4CE}</button><input id="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><button id="slash" class="chip ghost" title="Slash command">/</button><button id="model" class="chip ghost" title="Model">auto</button><button id="effort" class="chip ghost" title="Thinking effort">auto</button><span id="cachewrap" class="quota" hidden><span id="cachelab" class="qlab">cache</span><span id="cachetext"></span><span id="cachetip" class="qtip" role="tooltip"></span></span><span class="spacer"></span><span id="q5wrap" class="quota" hidden><svg width="18" height="18" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--vscode-panel-border)" stroke-width="3"></circle><circle id="q5arc" cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 13 13)" stroke-dasharray="0 62.8"></circle></svg><span id="q5lab" class="qlab"></span><span id="q5text"></span><span id="q5tip" class="qtip" role="tooltip"></span></span><span id="q7wrap" class="quota" hidden><svg width="18" height="18" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--vscode-panel-border)" stroke-width="3"></circle><circle id="q7arc" cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 13 13)" stroke-dasharray="0 62.8"></circle></svg><span id="q7lab" class="qlab"></span><span id="q7text"></span><span id="q7tip" class="qtip" role="tooltip"></span></span><button id="ctxwrap" title="Context left \u2014 click to compact"><svg id="donut" width="22" height="22" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--vscode-panel-border)" stroke-width="3"></circle><circle id="arc" cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 13 13)" stroke-dasharray="0 62.8"></circle></svg><span id="ctxtext">—</span><span id="ctxtokens"></span><span id="ctxtip" class="qtip" role="tooltip"></span></span><button id="send" title="Send (⏎)">↑</button></div></div></footer>`;}
let assetCache:{css:string;script:string}|undefined;
export function webviewAssets(){
  if(assetCache)return assetCache;
  const dir=nodePath.join(__dirname,'..','..','..','..','media','webview');
  assetCache={css:fsSync.readFileSync(nodePath.join(dir,'chat.css'),'utf8'),
              script:fsSync.readFileSync(nodePath.join(dir,'chat.js'),'utf8')};
  return assetCache;
}
