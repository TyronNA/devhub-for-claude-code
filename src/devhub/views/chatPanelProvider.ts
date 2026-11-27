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
/** Một tab = một webview panel. Draft tab đổi key thành session key ngay khi lượt đầu chạy. */
interface QueuedPrompt {text:string;images?:string[];}
interface Tab {key:string;panel:any;session?:DevHubSession;draft?:Draft;workspace?:DevHubWorkspace;project?:DevHubProject;batcher:EventBatcher<any>;model?:string;effort?:string;disposed:boolean;
  /** Tin nhắn gõ trong lúc lượt đang chạy. Host giữ danh sách, webview chỉ hiển thị. */
  queue:QueuedPrompt[];starting?:boolean;flushing?:boolean;}

const ATTACHMENT_TTL_MS=48*60*60*1000;
const PRUNE_EVERY_MS=6*60*60*1000;
const PERM_TIMEOUT_MS=5*60*1000;
// Mở tab / bấm chip là chấp nhận bản git mới hơn 2s; đừng chạy lại git cho mỗi cú bấm.
const HOT_SCM_MS=2000;
// Câu hỏi chặn cả lượt và phải chờ người thật; 5 phút của duyệt-tool là quá ngắn.
const ASK_TIMEOUT_MS=60*60*1000;
// Effort là cờ CLI cố định nên giữ trong code; danh sách MODEL nằm ở settings vì nó đổi liên tục.
const EFFORTS:Record<string,string[]>={claude:['low','medium','high','xhigh','max']};
function cfg(){return vscode.workspace.getConfiguration('devHub');}
function modelChoices(provider:string):string[]{const v=cfg().get(`${provider}.models`,[]);return Array.isArray(v)?v.filter((x:any)=>typeof x==='string'):[];}
function defaultsFor(provider:string){return {model:cfg().get(`${provider}.model`,'')||undefined,effort:cfg().get(`${provider}.effort`,'')||undefined};}
const EXT:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};

/**
 * Lựa chọn model/effort của một provider. Export vì server mobile cũng dựng đúng danh sách
 * này — hai chỗ tự tính là hai chỗ lệch nhau.
 */
export function optionChoices(provider:string,kind:'model'|'effort',model?:string):Array<{label:string;description?:string;value:string}>{
  const list=kind==='model'?modelChoices(provider):(EFFORTS[provider]||[]);
  return list.map((v:string)=>({label:v,value:v}));
}
/**
 * Ảnh đính kèm chỉ được nằm trong thư mục Dev Hub tự ghi ra. `attachments` là đường dẫn do
 * client gửi lên và đi thẳng vào prompt (nối vào prompt của Claude), nên một
 * client hỏng có thể trỏ vào file bất kỳ. Trả về đường dẫn xấu đầu tiên, undefined nếu sạch.
 */
export function foreignAttachment(paths:string[]|undefined,dir:string):string|undefined{
  const root=nodePath.resolve(dir)+nodePath.sep;
  return (paths||[]).find(p=>!nodePath.resolve(String(p)).startsWith(root));
}
/** Mốc thời gian trong QuickPick lịch sử; giờ cụ thể đã nằm ở `detail`. */
function ago(at:number){const m=Math.round((Date.now()-at)/60000);
  if(m<1)return 'just now'; if(m<60)return `${m}m ago`;
  const h=Math.round(m/60); return h<24?`${h}h ago`:`${Math.round(h/24)}d ago`;}
/** Session không thuộc project nào (planner) thì tiêu đề tab lấy khúc đầu của title. */
export function shortTabTitle(title:string|undefined){
  const head=String(title||'').split(' \u00b7 ')[0].trim();
  return head?(head.length>24?head.slice(0,23)+'\u2026':head):undefined;
}
/** Model/effort mặc định lấy từ settings; mobile mở session mới cũng phải khớp panel. */
export function defaultTurnOptions(provider:string){return defaultsFor(provider);}

export class ChatPanelProvider {
  private tabs=new Map<string,Tab>();
  private active?:Tab;
  private buffers=new SessionEventCache<DevHubEvent>(12,1500);
  /** key -> số event đầu buffer đến từ `loadTranscript`; xem `mergeTranscript`. */
  private historyLen=new Map<string,number>();
  private disposers:Array<()=>void>=[];
  private lastSelected?:DevHubSession;
  /** requestId -> huỷ hẹn giờ. CLI chặn cho tới khi có control_response, nên mọi
   *  đường thoát (đóng tab, hết hạn, dispose) đều phải trả lời DENY. */
  private pendingPerms=new Map<string,{provider:string;sessionId:string;timer:any;input?:any;req:any}>();
  /** Cột của nhóm editor chứa Dev Hub. Ghim lại để tab thứ 2 trở đi nằm cạnh tab cũ
   *  thay vì `Beside` tự tách split mới mỗi lần. */
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
    // Quét một lần lúc dựng là TTL 48h không bao giờ được thi hành trên cửa sổ mở cả tuần.
    this.pruneTimer=setInterval(()=>void this.pruneAttachments(),PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
  }
  private pruneTimer:any;
  dispose(){clearInterval(this.pruneTimer);this.pruneTimer=undefined;
    for(const id of [...this.pendingPerms.keys()])this.settlePerm(id,false);
    for(const d of this.disposers)d();for(const t of this.tabs.values()){t.batcher.dispose();t.panel?.dispose();}this.tabs.clear();}

  /**
   * Webview panel bị huỷ khi Reload Window. Serializer nhận lại panel VS Code dựng sẵn
   * kèm state webview đã `setState`, rồi gắn lại vào một Tab như chưa có gì xảy ra.
   */
  registerSerializer(context:any){
    const api=vscode.window.registerWebviewPanelSerializer?.('devHub.chat',{
      deserializeWebviewPanel:async(panel:any,state:any)=>{await this.adopt(panel,state);},
    });
    if(api)context.subscriptions.push(api);
  }
  private async adopt(panel:any,state:any){
    // Reload/đóng tab có thể huỷ panel giữa hai await của serializer; panel chết thì bỏ hydrate.
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
   * Tab chưa gửi tin nào không có session để tra; nó chỉ là workspace+project+provider.
   * Không dựng lại thì Reload Window vứt cả tab lẫn chữ đang gõ trong đó.
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

  // ---------- mở / tạo tab ----------
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
        // `set()` cắt từ ĐẦU khi quá hạn, nên tiền tố lịch sử co lại đúng số event bị cắt.
        this.historyLen.set(key,Math.max(0,merged.historyLen-(merged.events.length-events.length)));
      }catch(e:any){
        if(tab.disposed)return;
        // Đọc lại hỏng thì giữ nguyên buffer: một lần gọi daemon lỗi không được xoá trắng tab
        // đang có nội dung, cũng không được đánh dấu session unavailable.
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

  /** Mọi đường gửi `sessionSelected` phải qua đây: bỏ `forWebview` là ảnh mất `imageSrcs`
   *  và webview không có gì để vẽ. */
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
  /** Ảnh người dùng đính kèm và media agent nhắc tới (`localMediaRoots`). */
  private imageRoots(){return [this.attachmentDir(),...localMediaRoots()].map(p=>vscode.Uri.file(p));}
  /** Webview không tự gọi được `asWebviewUri`; đưa nó gốc `/` để tự nối đường dẫn tuyệt đối vào. */
  private postMediaBase(tab:Tab){try{this.post(tab,{type:'mediaBase',base:String(tab.panel.webview.asWebviewUri(vscode.Uri.file('/'))).replace(/\/$/,'')});}catch{}}
  private attach(key:string,panel:any,init:Partial<Tab>):Tab{
    const tab:Tab={key,panel,batcher:undefined as any,queue:[],disposed:false,...init};
    // Panel khôi phục sau reload mang option cũ; gán lại trước khi ghi html.
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
    // Logo lên tab thay cho tiền tố "Claude ·".
    if(this.providerOf(tab)==='planner'){tab.panel.iconPath=new vscode.ThemeIcon('robot');return;}
    if(this.mediaRoot){
      const base='claude';
      tab.panel.iconPath={light:vscode.Uri.file(nodePath.join(this.mediaRoot,`${base}-light.svg`)),
                          dark:vscode.Uri.file(nodePath.join(this.mediaRoot,`${base}-dark.svg`))};
    }
  }

  // ---------- message từ webview ----------
  private async handleMessage(tab:Tab,raw:any){
    try{
      const m=parseWebviewMessage(raw); if(!m){
        if(raw?.type==='pasteImage')this.post(tab,{type:'attachmentError',requestId:raw.requestId,message:'Ảnh không hợp lệ hoặc vượt giới hạn 9 MiB.'});
        return;
      }
      if(m.type==='ready'){this.retitle(tab);this.postMediaBase(tab);
        if(tab.session)await this.pushSession(tab);else if(tab.draft)this.post(tab,{type:'draftSelected',draft:tab.draft,events:[]});else this.post(tab,{type:'empty'});
        this.postOptions(tab);this.postQueue(tab);this.refreshScm(tab);return;}
      if(m.type==='dequeue'){const i=Number(m.index);
        if(Number.isInteger(i)&&i>=0&&i<tab.queue.length){tab.queue.splice(i,1);this.postQueue(tab);}return;}
      // "Back" của một app điện thoại: mở lại sidebar kèm cây session. `<viewId>.focus` là
      // command VS Code tự đăng ký cho mọi view được contribute. Chỉ chạy khi người dùng bấm —
      // KHÔNG có chiều ngược lại: tự đóng sidebar thì bấm mở nó lại là bị đóng ngay, ngáo.
      // Bố cục là của người dùng; extension chỉ đi khi được bấm.
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
        catch{this.post(tab,{type:'attachmentError',requestId:m.requestId,message:'Không lưu được ảnh. Hãy chọn lại ảnh.'});}
        return;
      }
      if(m.type==='cancel'&&tab.session){
        await this.manager.cancel(tab.session.provider,tab.session.nativeSessionId);return;}
      if(m.type==='compact'){await this.compact(tab);return;}
      if(m.type==='copySessionId'){
        // Planner: ID trong store được scope theo daemon, thứ trace được là conversation gốc —
        // giống hệt devhub.copySessionId trên cây.
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
        // Chỉ đính ảnh, không gõ chữ, là một tin hợp lệ — trước đây nó bị bỏ im lặng ở đây
        // trong khi webview đã xoá chip ảnh, nên tấm ảnh biến mất không một lời nào.
        if(!text&&!images?.length)return;
        if(tab.session){
          // Lượt đang chạy: xếp hàng thay vì bỏ im. Flush khi status rời 'running'.
          if(tab.session.status==='running'||this.manager.isBusy(tab.session.provider,tab.session.nativeSessionId)){
            tab.queue.push({text,images});this.postQueue(tab);return;}
          // Lượt đã rảnh mà hàng chờ còn tin (lần gửi trước hỏng): resume lỗi KHÔNG phát
          // `sessionUpdated` nên không có gì gọi scheduleFlush. Coi `queue.length` là lý do
          // để xếp tiếp thì tab thành chỉ-ghi. Xếp tin mới vào cuối rồi lấy đầu hàng ra chạy.
          let head:QueuedPrompt={text,images};
          if(tab.queue.length){tab.queue.push(head);head=tab.queue.shift()!;this.postQueue(tab);}
          // Webview đã xoá ô nhập và chip ảnh lúc gửi; gửi hỏng mà không trả tin vào hàng
          // chờ là mất luôn chữ đã gõ. Hai nhánh kia (flushQueue, start) đã làm đúng thế.
          try{
            tab.session=await this.manager.resume(tab.session,head.text,{model:tab.model,effort:tab.effort,images:head.images});
          }catch(e){tab.queue.unshift(head);this.postQueue(tab);throw e;}
          this.lastSelected=tab.session;this.onSelection(tab.session);
          await this.pushSession(tab);
        }else if(tab.draft){
          // Enter hai lần trước khi session kịp sinh ra sẽ tạo hai session.
          if(tab.starting){tab.queue.push({text,images});this.postQueue(tab);return;}
          // Lần start trước hỏng thì hàng chờ còn tin cũ và chưa có session nào để flush vào.
          // Gửi thẳng tin mới là đảo thứ tự — xếp nó vào cuối rồi lấy đầu hàng ra chạy.
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
   * Claude nén bằng slash command thật của CLI; planner là daemon HTTP, không có khái niệm nén.
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

  /** `showTextDocument` mở PNG ra thành ký tự rác; ảnh phải đi qua `vscode.open`. */
  private async openPath(p:string){
    const uri=vscode.Uri.file(p);
    if(Object.values(EXT).includes(nodePath.extname(p).slice(1).toLowerCase()))
      await vscode.commands.executeCommand('vscode.open',uri,{preview:true});
    else await vscode.window.showTextDocument(uri,{preview:true});
  }

  /**
   * Lỗi cũng là bản ghi. `post({type:'error'})` chỉ vẽ một dòng rồi thôi — lần vẽ lại kế
   * tiếp lấy event từ buffer của host, và dòng đó không có ở đó. Đúng lúc cần soi lại thì
   * không còn gì để soi. Tab chưa có session (draft) thì đành gửi suông.
   */
  private fail(tab:Tab,message:string){
    if(tab.session)this.emitLocal(tab,{type:'error',message,timestamp:Date.now()});
    else this.post(tab,{type:'error',message});
  }
  /** Sự kiện do chính panel sinh ra: vào buffer trước, nếu không nó chết ở lần vẽ lại. */
  private emitLocal(tab:Tab,event:DevHubEvent){
    const id=tab.session?.nativeSessionId; if(!id)return;
    this.buffers.append(this.sessionKey(this.providerOf(tab),id),event);
    this.post(tab,{type:'event',sessionId:id,event:this.forWebview(tab,event)});
  }
  /**
   * Event do bên ngoài đẩy vào, không thuộc lượt nào (reminder của planner tự nổ).
   *
   * Chỉ append khi buffer đã có: append vào key rỗng sẽ tạo một buffer chỉ có event này, và
   * lần mở tab sau thấy buffer không rỗng nên bỏ luôn `loadTranscript` — tab chỉ còn một dòng
   * reminder, mất sạch lịch sử. Không có buffer thì cứ để daemon kể lại (`/conversations`).
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
    // Lựa chọn thuộc về session, không phải tab: đóng tab mở lại vẫn phải là model vừa chọn.
    if(tab.session)tab.session=await this.manager.setTurnOptions(tab.session,{model:tab.model,effort:tab.effort});
    // Qua postOptions: post trần thiếu `slash`, và webview đọc `!!x.slash` nên nút `/` biến mất.
    this.postOptions(tab);
  }
  private rekeyTab(tab:Tab,next:string){if(tab.key===next)return;this.tabs.delete(tab.key);tab.key=next;this.tabs.set(next,tab);}

  /** Đổi provider/project trên một session đã chạy thì mở draft mới — không sửa lịch sử session cũ. */
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
   * Nút `+` = chat mới NGAY trong project đang mở, không hỏi lại project — bắt chọn lại
   * mỗi lần thì đang chat dở không mở thêm được. Đổi project vẫn ở chip breadcrumb.
   */
  private async openPickerChat(tab:Tab){
    const provider=this.providerOf(tab);
    if(tab.workspace&&tab.project){await this.newChat(tab.workspace,tab.project,provider);return;}
    const target=await this.pickProject(); if(!target)return;
    await this.newChat(target.workspace,target.project,provider);
  }
  /** QuickPick có sẵn filter -> đây cũng là ô "search project nhanh". */
  /** Danh sách slash command do chính CLI khai trong `system init` — không hardcode. */
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
   * Lịch sử của project đang mở. Quét lại trước khi liệt kê: session mở từ terminal không đi
   * qua Dev Hub, store chỉ mới tới lần refresh gần nhất (lúc sidebar hiện ra).
   */
  private async pickHistory(tab:Tab){
    try{await this.refreshHistory();}catch{}
    const project=tab.project;
    const all=(await this.listSessions()).slice().sort((a,b)=>b.updatedAt-a.updatedAt);
    // Session planner không thuộc project nào; ở tab đó lọc theo projectId sẽ ra rỗng.
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

  // ---------- ảnh dán ----------
  private attachmentDir(){return nodePath.join(this.storageDir||require('node:os').tmpdir(),'devhub','attachments');}
  private async saveAttachment(tab:Tab,mime:string,b64:string,requestId?:string){
    const dir=this.attachmentDir();
    await fsp.mkdir(dir,{recursive:true});
    const file=nodePath.join(dir,`${Date.now()}-${crypto.randomUUID().slice(0,8)}.${EXT[mime]||'png'}`);
    await fsp.writeFile(file,Buffer.from(b64,'base64'));
    // Đường dẫn quay lại webview, rồi đi kèm sendPrompt.attachments.
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
   * Ảnh đi trong event dưới dạng ĐƯỜNG DẪN, không phải 1,7MB base64: cache của host và
   * `state.events` của webview giữ chuỗi ngắn. Chỉ tới lúc gửi mới đổi sang webview URI, vì
   * chỉ host mới gọi được `asWebviewUri` (và mỗi tab một origin khác nhau).
   */
  private forWebview(tab:Tab,event:any){
    // data URI không có file để đổi URI.
    const uri=(p:string)=>p.startsWith('data:')?p:String(tab.panel.webview.asWebviewUri(vscode.Uri.file(p)));
    try{
      if(event?.type==='assistant_image'&&event.path)return {...event,src:uri(event.path)};
      if(event?.type==='user_message'&&event.images?.length)return {...event,imageSrcs:event.images.map(uri)};
    }catch{}
    return event;
  }

  // ---------- sự kiện từ manager ----------
  private tabsFor(provider:string,sessionId:string){const t=this.tabs.get(this.sessionKey(provider,sessionId));return t?[t]:[];}
  private onEvent(x:any){
    const key=this.sessionKey(x.provider,x.sessionId);
    // Chỉ báo nhất thời: vào buffer thì vài chục event/lượt sẽ đẩy transcript ra khỏi cache
    // và hiện lại khi mở lại session, dù nó chẳng còn nghĩa gì lúc đó.
    if(x.event.type==='thinking'){
      for(const tab of this.tabsFor(x.provider,x.sessionId))this.post(tab,{type:'event',sessionId:x.sessionId,event:x.event});
      return;
    }
    this.buffers.append(key,x.event,(previous,next)=>previous?.type==='assistant_delta'&&next?.type==='assistant_delta'?{...next,text:previous.text+next.text}
      // View frame sau CHỨA cả frame trước; giữ cả hai là nhân bản một câu trả lời 30 lần trong cache.
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
  /** Chữ người dùng đã gõ ở cửa sổ trước: trả lại để đọc/chép, KHÔNG tự gửi. */
  private async restoreLostQueue(tab:Tab){
    const id=tab.session?.nativeSessionId; if(!id)return;
    const items=await this.queueStore().take(this.sessionKey(this.providerOf(tab),id));
    if(!items.length)return;
    this.emitLocal(tab,{type:'warning',timestamp:Date.now(),
      message:`Dev Hub restarted with ${items.length} message${items.length>1?'s':''} still queued — they were not sent:\n`+
        items.map(i=>'\u00b7 '+(i.text||`${i.images?.length??0} image(s)`)).join('\n')});
  }
  /**
   * `SessionManager.consume` xoá session khỏi `active` trong `finally`, tức SAU khi phát
   * `sessionUpdated`. Gửi ngay trong handler sẽ đụng `claim()` và bị từ chối, nên phải hoãn.
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
    if(!this.tabs.get(tab.key))return;   // tab đã đóng trong lúc chờ
    // Stop phát 'cancelled' trước khi stream drain xong; gửi vào đó chỉ tổ ăn
    // "already running a turn" rồi in lỗi lên khung chat. `sessionUpdated` cuối sẽ gọi lại.
    if(this.manager.isBusy(session.provider,session.nativeSessionId))return;
    const next=tab.queue.shift()!;
    this.postQueue(tab);
    try{
      tab.session=await this.manager.resume(session,next.text,{model:tab.model,effort:tab.effort,images:next.images});
      this.lastSelected=tab.session;this.onSelection(tab.session);
    }catch(e:any){
      // Gửi lại thất bại: trả tin về đầu hàng chờ để không mất chữ người dùng đã gõ.
      tab.queue.unshift(next);this.postQueue(tab);
      this.fail(tab,e?.message||String(e));
    }
  }
  // Stop chỉ giết lượt đang chạy: hàng chờ sống tiếp và `sessionUpdated` ('cancelled') sẽ
  // flush nó — bấm Stop rồi gõ tin mới là cách đổi hướng, không phải cách bỏ tin đã gõ.
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

  /** Luôn gửi SAU sessionSelected/draftSelected — hai cái đó thay nguyên state ở webview. */
  private postOptions(tab:Tab){
    const provider=this.providerOf(tab);
    const adapter:any=this.providers[provider];
    // Provider không có slash command (planner) — ẩn nút thay vì báo lỗi mỗi lần bấm.
    const slash=(adapter?.slashCommands?.(tab.session?.nativeSessionId)||[]).length>0;
    this.post(tab,{type:'optionsChanged',model:tab.model,effort:tab.effort,provider,slash});}
  /** Yêu cầu duyệt quyền từ CLI -> đúng tab của session đó. */
  /** `false` = không có tab nào nhận, request đã bị deny — người gọi đừng mời "Open" nữa. */
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
  /** Trả lời đúng MỘT lần cho mỗi requestId. */
  private settlePerm(requestId:string,allow:boolean,answers?:Record<string,string>,expired?:boolean){
    const p=this.pendingPerms.get(requestId); if(!p)return;
    clearTimeout(p.timer); this.pendingPerms.delete(requestId);
    if(expired)this.noteDenied(p.provider,p.sessionId,`${p.req?.displayName||p.req?.toolName||'A tool'} request expired without an answer and was denied.`);
    // AskUserQuestion trả lời bằng cách allow kèm `answers` nhét lại vào input.
    const updatedInput=answers?{...(p.input||{}),answers}:undefined;
    this.answerPermission(p.provider,p.sessionId,requestId,allow,updatedInput);
    this.permissionObserver?.();
  }
  /**
   * Tree vẽ icon "chờ duyệt" bằng cách hỏi `isAwaitingPermission`, nên nó phải được đánh
   * thức ở CẢ hai đầu: lúc câu hỏi hiện ra và lúc nó được trả lời. Setter chứ không phải
   * tham số constructor — cái đó đã 10 tham số, và đây là cùng lối wiring của
   * `setPermissionSink`/`setSlashStore`. KHÔNG dùng `onSessionChanged`: cái đó là refresh
   * đầy đủ, còn câu hỏi duyệt đến dày hơn nhiều và không đổi gì ở ports/tasks.
   */
  private permissionObserver?:()=>void;
  setPermissionObserver(fn:()=>void){this.permissionObserver=fn;}
  /** Session này có request duyệt đang treo? Trạng thái SỐNG — một câu hỏi chưa trả lời
   *  không phải lịch sử của session, nên nó không đi vào store. */
  isAwaitingPermission(provider:string,sessionId:string){
    for(const [,p] of this.pendingPerms)if(p.provider===provider&&p.sessionId===sessionId)return true;
    return false;
  }
  /** Thẻ duyệt/câu hỏi chỉ sống trong DOM webview, mà `sessionSelected` xoá sạch DOM —
   *  không gửi lại thì CLI cứ chặn với một câu hỏi vô hình. */
  private replayPerms(tab:Tab){
    const id=tab.session?.nativeSessionId; if(!id)return;
    const provider=this.providerOf(tab);
    for(const [,p] of this.pendingPerms)
      if(p.provider===provider&&p.sessionId===id&&p.req)this.post(tab,{type:'permission',request:p.req});
  }
  /** Thẻ đã chết vẫn nằm trên DOM: khoá lại kèm lý do, không thì người dùng bấm vào
   *  chỗ không còn ai nghe (`proc.write` trả false lặng lẽ khi process đã đi). */
  private closeCard(p:{provider:string;sessionId:string},requestId:string,note:string){
    for(const tab of this.tabsFor(p.provider,p.sessionId))this.post(tab,{type:'permissionClosed',requestId,note});
  }
  /** CLI chặn cả lượt để chờ duyệt, nên lượt đã rời 'running' = mọi request còn treo là đồ
   *  chết. Không dọn thì `replayPerms` dựng lại nó mãi và timer bắn warning "expired" vào
   *  một session xong từ lâu. Vẫn deny để giữ bất biến "CLI luôn có câu trả lời". */
  private closePerms(provider:string,sessionId:string,note:string){
    for(const [id,p] of [...this.pendingPerms]){
      if(p.provider!==provider||p.sessionId!==sessionId)continue;
      this.closeCard(p,id,note);
      this.settlePerm(id,false);
    }
  }
  /** Deny ngầm trông y như tool im lặng không chạy; phải để lại dấu vết. Đi qua `onEvent`
   *  để warning vào cả buffer, khỏi biến mất khi transcript được nạp lại. */
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
   * Chip git trên header. Đọc git chỉ khi có tab đang HIỆN trỏ vào repo đó; tab ẩn
   * (`retainContextWhenHidden`) vẫn còn DOM nhưng không ai nhìn, chạy git cho nó là đốt CPU.
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
  /** Gửi bản đang có ngay (khỏi chớp) rồi mới đọc lại; `status` vắng = ẩn chip. */
  private refreshScm(tab:Tab){
    const root=tab.project?.gitRoot;
    this.post(tab,{type:'scm',status:root?this.git?.get(root):undefined});
    if(root&&this.git)void this.git.refresh(root,HOT_SCM_MS);
  }
  /** Danh sách file bẩn lấy từ git, không lấy từ DOM — webview chỉ vẽ con số. */
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
    // Webview chết thì getter/postMessage có thể ném đồng bộ, không chỉ trả false.
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
    // Ảnh trên đĩa nạp qua nguồn của chính webview; thiếu nó thì đừng nhét `undefined`
    // vào CSP, chỉ còn data: là đường lùi.
    const imgSrc=typeof webview?.cspSource==='string'?webview.cspSource:'';
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc} data:; media-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${chatBodyMarkup()}<script nonce="${nonce}">${script}</script></body></html>`;
  }
}

/**
 * CSP là `default-src 'none'`, và `localResourceRoots` chỉ mở các gốc media (ảnh
 * đính kèm, `~` và tmp cho media agent nhắc tới) —
 * css/js vẫn phải do host đọc rồi nhúng thẳng vào HTML. Đường dẫn tính từ `__dirname`
 * (`dist/src/devhub/views` -> gốc extension) nên đúng cả từ repo và trong .vsix.
 */
/** Thân trang chat. Dùng chung cho webview panel và cho server mobile — hai transport,
 *  một bộ id: `chat.js` tra cứu chúng bằng getElementById, lệch một id là chết lặng. */
export function chatBodyMarkup(){return `<header><div class="left"><button id="provider" class="chip" title="Change provider">Dev Hub</button><button id="crumb" class="chip ghost" title="Search project">—</button><span id="branch" class="chip ghost" hidden></span><button id="scm" class="chip ghost" title="Uncommitted changes" hidden></button></div><div class="right"><button id="copyid" class="chip ghost" title="Copy session ID" hidden>ID</button><button id="history" class="chip ghost" title="Open an earlier session in this project">\u{1F553}</button><span id="status"></span><button id="newtab" class="chip ghost" title="New chat in this project">+</button></div></header><main id="messages"><div class="empty">Select a session or start a new Claude chat.</div></main><footer><div id="thinking" hidden><span id="spinner"></span><span id="thinkword">Cooking</span><span id="thinktime"></span><span id="thinktokens"></span><button id="cancel" title="Stop this turn">Stop</button></div><div class="composer-box"><div id="queue"></div><div id="attachments"></div><textarea id="input" rows="3" placeholder="Ask Claude…"></textarea><div class="composerbar"><button id="attach" class="chip ghost" title="Attach an image">\u{1F4CE}</button><input id="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><button id="slash" class="chip ghost" title="Slash command">/</button><button id="model" class="chip ghost" title="Model">auto</button><button id="effort" class="chip ghost" title="Thinking effort">auto</button><span id="cachewrap" class="quota" hidden><span id="cachelab" class="qlab">cache</span><span id="cachetext"></span><span id="cachetip" class="qtip" role="tooltip"></span></span><span class="spacer"></span><span id="q5wrap" class="quota" hidden><svg width="18" height="18" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--vscode-panel-border)" stroke-width="3"></circle><circle id="q5arc" cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 13 13)" stroke-dasharray="0 62.8"></circle></svg><span id="q5lab" class="qlab"></span><span id="q5text"></span><span id="q5tip" class="qtip" role="tooltip"></span></span><span id="q7wrap" class="quota" hidden><svg width="18" height="18" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--vscode-panel-border)" stroke-width="3"></circle><circle id="q7arc" cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 13 13)" stroke-dasharray="0 62.8"></circle></svg><span id="q7lab" class="qlab"></span><span id="q7text"></span><span id="q7tip" class="qtip" role="tooltip"></span></span><button id="ctxwrap" title="Context left \u2014 click to compact"><svg id="donut" width="22" height="22" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--vscode-panel-border)" stroke-width="3"></circle><circle id="arc" cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 13 13)" stroke-dasharray="0 62.8"></circle></svg><span id="ctxtext">—</span><span id="ctxtokens"></span><span id="ctxtip" class="qtip" role="tooltip"></span></span><button id="send" title="Send (⏎)">↑</button></div></div></footer>`;}
let assetCache:{css:string;script:string}|undefined;
export function webviewAssets(){
  if(assetCache)return assetCache;
  const dir=nodePath.join(__dirname,'..','..','..','..','media','webview');
  assetCache={css:fsSync.readFileSync(nodePath.join(dir,'chat.css'),'utf8'),
              script:fsSync.readFileSync(nodePath.join(dir,'chat.js'),'utf8')};
  return assetCache;
}
