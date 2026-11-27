import { plannerSessionId } from './devhub/sessions/plannerIdentity';
const vscode:any=require('vscode');
import { WorkspaceStore } from './devhub/storage/workspaceStore';
import { SessionStore } from './devhub/storage/sessionStore';
import { ProjectResolver } from './devhub/workspace/projectResolver';
import { WorkspaceService } from './devhub/workspace/workspaceService';
import { ProcessRunner } from './devhub/providers/processRunner';
import { ClaudeProvider } from './devhub/providers/claude/claudeProvider';
import { PlannerProvider } from './devhub/providers/planner/plannerProvider';
import { PlannerWatcher, PlannerReminderPush } from './devhub/providers/planner/plannerWatcher';
import { normalizeAgents } from './devhub/agents/agentRunner';
import { endpointOf, isHttpAgent } from './devhub/agents/plannerTasks';
import { SessionManager } from './devhub/sessions/sessionManager';
import { DevHubTreeProvider, setMediaRoot } from './devhub/views/devHubTreeProvider';
import { ChatPanelProvider } from './devhub/views/chatPanelProvider';
import { MobileServer, lanAddress } from './devhub/web/mobileServer';
import { GitStatusWatcher } from './devhub/workspace/gitStatusWatcher';
import { StatusBarController } from './devhub/views/statusBarController';
import { altRootFor, isUnder, toggleAltRoot } from './devhub/providers/claude/claudeAccount';
import { CliUpdateStatus } from './devhub/views/cliUpdateStatus';
import { updateCommandFor } from './devhub/providers/cliVersion';
import { registerCommands } from './devhub/commands';
import { providerLabel } from './devhub/ui/format';
import { findRestorableSession } from './devhub/sessions/selection';
import { reconcileImportedSessions } from './devhub/sessions/historyReconciler';

// ~30s: enough for the old extension host to exit after Reload Window.
const MOBILE_PORT_RETRIES=15,MOBILE_PORT_RETRY_MS=2000;
let manager:SessionManager|undefined;let chat:ChatPanelProvider|undefined;let status:StatusBarController|undefined;let mobile:MobileServer|undefined;let plannerWatch:PlannerWatcher|undefined;let gitWatcher:GitStatusWatcher|undefined;
export async function activate(context:any){
  setMediaRoot(vscode.Uri.joinPath(context.extensionUri,'media').fsPath);
  const output=vscode.window.createOutputChannel('Dev Hub');context.subscriptions.push(output);output.appendLine('Dev Hub activating');
  const storageDir=context.globalStorageUri.fsPath;const workspaceStore=new WorkspaceStore(storageDir);const sessionStore=new SessionStore(storageDir);const workspaces=new WorkspaceService(workspaceStore,new ProjectResolver());const runner=new ProcessRunner();const cfg=vscode.workspace.getConfiguration('devHub');const maxHistory=cfg.get('history.maxFilesPerProvider',1500);
  const providers:any={claude:new ClaudeProvider(runner,cfg.get('claude.executable','claude'),maxHistory,undefined,cfg.get('claude.permissionMode','')||undefined,cfg.get('claude.appendSystemPrompt','')||undefined,Math.max(0,cfg.get('claude.sessionIdleMinutes',30))*60000,cfg.get('claude.autoCompact','auto')||undefined,cfg.get('claude.mcp','inherit')==='none',cfg.get('claude.artifacts',true),cfg.get('claude.promptCacheTtl','')||undefined),planner:new PlannerProvider(cfg.get('planner.endpoint','')||undefined)};manager=new SessionManager(sessionStore,providers,cfg.get('maxConcurrentTurns',4));
  const tree=new DevHubTreeProvider(workspaces,sessionStore,{
    get:()=>context.globalState.get('devhub.pinnedPorts',[]) as number[],
    set:(v:number[])=>void context.globalState.update('devhub.pinnedPorts',v)},
    // A closure, not a value: `tree` is built BEFORE `chat`/`mobile`, and the mobile page is
    // asked for approval before the panel, so a waiting row may sit at either end.
    (prov:string,id:string)=>!!chat?.isAwaitingPermission?.(prov,id)||!!mobile?.isAwaitingPermission?.(prov,id),
    ()=>providers.claude.livePids?.()||[]);const treeView=vscode.window.createTreeView('devHub.sessions',{treeDataProvider:tree,showCollapseAll:true});context.subscriptions.push(treeView);context.subscriptions.push({dispose:()=>tree.dispose()});
  // Read the setting on every call: changing the file/label needs no reload, and the wrapper also reads the file on every spawn.
  const altAccount=()=>{const c=vscode.workspace.getConfiguration('devHub');return {file:c.get('claude.altAccountFile','').trim(),alt:c.get('claude.altAccountName','Alt'),main:c.get('claude.defaultAccountName','Default')};};
  const accountOf=(root:string)=>{const a=altAccount();return a.file?(altRootFor(a.file,root)?a.alt:a.main):undefined;};
  // Panel and mobile page share one path: retire the open session so the old CLI doesn't keep running on the old account.
  const switchAccount=async(root:string,name:string):Promise<{level:'info'|'warn'|'error';message:string}>=>{
    const a=altAccount();
    let r;try{r=toggleAltRoot(a.file,root);}catch(e:any){return {level:'error',message:`cannot write ${a.file}: ${e?.message||e}`};}
    const n=providers.claude.retireUnder(root);await status?.update();
    if(r.inherited)return {level:'warn',message:`${name} stays on ${a.alt} — covered by ${r.inherited} in ${a.file}.`};
    return {level:'info',message:`${name} → Claude ${r.alt?a.alt:a.main}. ${n?`${n} open session(s) respawn on their next turn.`:'Applies to the next session.'}`};
  };
  status=new StatusBarController(sessionStore,accountOf);context.subscriptions.push(status);
  context.subscriptions.push(vscode.commands.registerCommand('devhub.switchClaudeAccount',async(arg?:any)=>{
    const a=altAccount();
    if(!a.file){vscode.window.showWarningMessage('Dev Hub: set `devHub.claude.altAccountFile` (and point `devHub.claude.executable` at a wrapper that reads it) first.');return;}
    const snap=await workspaces.snapshot();
    let project=arg?.type==='project'?arg.data.project:typeof arg==='string'?snap.projects.filter(p=>isUnder(arg,p.rootPath)).sort((x,y)=>y.rootPath.length-x.rootPath.length)[0]:undefined;
    const root:string|undefined=project?.rootPath??(typeof arg==='string'?arg:undefined);
    if(!root){const pick=await vscode.window.showQuickPick(snap.projects.map(p=>({label:p.name,description:altRootFor(a.file,p.rootPath)?a.alt:a.main,detail:p.rootPath,project:p})),{placeHolder:'Switch Claude account for project\u2026',matchOnDetail:true});if(!pick)return;project=pick.project;}
    const target=root??project.rootPath;const r=await switchAccount(target,project?.name??target);
    vscode.window[r.level==='error'?'showErrorMessage':r.level==='warn'?'showWarningMessage':'showInformationMessage'](`Dev Hub: ${r.message}`);
  }));
  const cliUpdate=new CliUpdateStatus(runner,
    ()=>{const c=vscode.workspace.getConfiguration('devHub');return {claude:c.get('claude.executable','claude')};},
    {get:()=>context.globalState.get('devhub.cliVersionCache',{}),set:(v:any)=>void context.globalState.update('devhub.cliVersionCache',v)},
    ()=>vscode.workspace.getConfiguration('devHub').get('cliUpdateCheck',true));
  context.subscriptions.push(cliUpdate);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e:any)=>{
    if(e.affectsConfiguration('devHub.cliUpdateCheck')||e.affectsConfiguration('devHub.claude.executable'))void cliUpdate.refresh();
  }));
  /**
   * Claude's spawn flags CANNOT be hot-swapped: a ClaudeProvider keeps processes alive across
   * turns, and it also has the slash store + permission sink attached below — rebuilding it abandons those processes
   * and cuts the permission reply path, and a permission request MUST be answered.
   * So just tell the truth here: it needs a reload. Silence is what cost the user a whole morning.
   */
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async(e:any)=>{
    if(!['claude.executable','claude.permissionMode','claude.appendSystemPrompt','claude.sessionIdleMinutes',
         'claude.autoCompact','claude.mcp','claude.artifacts','claude.promptCacheTtl']
      .some(k=>e.affectsConfiguration('devHub.'+k)))return;
    const pick=await vscode.window.showInformationMessage(
      'Dev Hub: Claude spawn settings only apply to processes started after a reload.','Reload Window');
    if(pick==='Reload Window')void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('devhub.updateCli',async()=>{
    const drifts=cliUpdate.current();
    if(!drifts.length)return void vscode.window.showInformationMessage('Dev Hub: Claude CLI is up to date.');
    // Don't run npm automatically: a global install may ask for permissions, and the user must see the command before it runs.
    const pick=drifts.length===1?drifts[0]:(await vscode.window.showQuickPick(
      drifts.map(d=>({label:d.provider,description:`${d.installed} \u2192 ${d.latest}`,drift:d})),
      {placeHolder:'Update which CLI?'}))?.drift;
    if(!pick)return;
    const cmd=updateCommandFor(pick.pkg);
    const go=await vscode.window.showInformationMessage(`Run \`${cmd}\`? Sessions already running keep the old binary until they end.`,'Run','Copy');
    if(go==='Copy')return void await vscode.env.clipboard.writeText(cmd);
    if(go!=='Run')return;
    const term=vscode.window.createTerminal('Dev Hub CLI update');term.show(true);term.sendText(cmd);
  }));
  chat=new ChatPanelProvider(manager,providers,async()=>{const s=await workspaces.snapshot();return {workspaces:s.workspaces,projects:s.projects};},s=>{status?.setSelected(s);if(s)context.globalState.update('devhub.lastSession',{provider:s.provider,nativeSessionId:s.nativeSessionId});},()=>{tree.refreshRows();status?.update();},()=>{status?.update();},storageDir,vscode.Uri.joinPath(context.extensionUri,'media').fsPath,(prov:string,id:string)=>sessionStore.get(prov,id),
    (prov:string,sid:string,rid:string,allow:boolean,updatedInput?:any)=>providers[prov]?.answerPermission?.(sid,rid,
      allow?(updatedInput?{behavior:'allow',updatedInput}:{behavior:'allow'}):{behavior:'deny',message:'Denied in Dev Hub'}),
    ()=>sessionStore.list(),
    // A closure, not a direct reference: `refreshHistory` is declared after this point.
    ()=>refreshHistory());
  const refreshHistory=async()=>{const snap=await workspaces.snapshot();const imported=(await Promise.all(Object.values(providers).map((p:any)=>p.discoverHistory(snap.projects).catch((e:any)=>{output.appendLine(`history ${p.id} failed: ${e?.message||e}`);return [];})))).flat();const existing=await sessionStore.list();const changes=reconcileImportedSessions(existing,imported);if(changes.length)await sessionStore.upsertMany(changes);tree.refresh();await status?.update();};
  providers.claude.setSlashStore?.(
    ()=>context.globalState.get('devhub.slashCommands',[]) as string[],
    (v:string[])=>void context.globalState.update('devhub.slashCommands',v));
  providers.claude.setPermissionSink?.((req:any)=>{
    // The mobile web app is asked FIRST: it only accepts when a real client holds that session,
    // and the person at the phone can't see the panel to approve.
    if(mobile?.showPermission('claude',req.sessionId,req))return;
    // `false` = no tab, the request was denied right away. Offering "Open" would open nothing to approve.
    if(chat?.showPermission('claude',req.sessionId,req)===false)return;
    if(notifyMode()!=='off'&&chat?.currentSessionId?.()!==req.sessionId)
      vscode.window.showWarningMessage(`${req.displayName||req.toolName} needs approval`,'Open')
        .then(async(pick:any)=>{if(pick!=='Open')return;const s=await sessionStore.get('claude',req.sessionId);if(s)void chat?.openSession(s);});
  });
  providers.claude.setIdleEventSink?.((sessionId:string,event:any)=>manager.ingestOutOfTurn('claude',sessionId,event));
  context.subscriptions.push({dispose:()=>providers.claude.dispose?.()});
  // A single watcher for both the panel and the mobile page: same repo = same cache, same
  // single-flight. No visible tab means it runs no git command.
  gitWatcher=new GitStatusWatcher();
  context.subscriptions.push({dispose:()=>{gitWatcher?.dispose();gitWatcher=undefined;}});
  chat.setGitWatcher(gitWatcher);
  chat.setPermissionObserver(()=>{tree.refreshRows();status?.update();});
  chat.registerSerializer(context);
  registerCommands(context,{workspaces,tree,chat,sessions:sessionStore,manager,refreshHistory});
  /**
   * Mobile web app: a real HTTP page, opened on the LAN for a phone on the same Wi-Fi.
   * Not built at activate — opening a port opens a path that controls a CLI,
   * so it only runs when the user explicitly turns it on.
   */
  const mobileServer=()=>{
    if(mobile)return mobile;
    mobile=new MobileServer({
      manager:manager!,providers,
      lookup:async()=>{const s=await workspaces.snapshot();return {workspaces:s.workspaces,projects:s.projects};},
      listSessions:()=>sessionStore.list(),
      findSession:(prov:string,id:string)=>sessionStore.get(prov,id),
      answerPermission:(prov:string,sid:string,rid:string,allow:boolean,updatedInput?:any)=>providers[prov]?.answerPermission?.(sid,rid,
        allow?(updatedInput?{behavior:'allow',updatedInput}:{behavior:'allow'}):{behavior:'deny',message:'Denied in Dev Hub'}),
      onSelection:(s:any)=>{status?.setSelected(s);context.globalState.update('devhub.lastSession',{provider:s.provider,nativeSessionId:s.nativeSessionId});},
      onChanged:()=>{tree.refreshRows();status?.update();},
      storageDir,
      passcode:()=>String(vscode.workspace.getConfiguration('devHub').get('mobile.passcode','')||''),
      log:(line:string)=>output.appendLine(line),
      gitWatcher,
      accounts:{label:accountOf,toggle:switchAccount},
    });
    context.subscriptions.push({dispose:()=>{mobile?.dispose();mobile=undefined;}});
    return mobile;
  };
  // Turning the setting off must CLOSE the open port. Otherwise that switch only goes one way,
  // and someone who thinks they just turned it off is still serving a CLI control path.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e:any)=>{
    if(!e.affectsConfiguration('devHub.mobile.enabled'))return;
    if(vscode.workspace.getConfiguration('devHub').get('mobile.enabled',false))return;
    if(!mobile)return;
    mobile.dispose();mobile=undefined;
    output.appendLine('mobile web app stopped — devHub.mobile.enabled turned off');
  }));
  // A 24/7 machine (tunnel host) has nobody to run a command after every extension host restart:
  // the setting is explicitly on — the consent modal was shown when it was turned on — so activate must reopen the port itself,
  // or the page on the phone dies silently.
  // Reload Window builds the new host before the old one releases the port: a single attempt hits EADDRINUSE and stays dead
  // until the next reload. Only wait on that error — if a second window really holds the port, it still reports as before once time runs out.
  void (async()=>{
    for(let attempt=0;;attempt++){
      const conf=vscode.workspace.getConfiguration('devHub');
      if(!conf.get('mobile.enabled',false))return;
      try{
        const {port}=await mobileServer().start(Math.max(0,conf.get('mobile.port',39642)),!!conf.get('mobile.lan',true));
        output.appendLine(`mobile web app auto-started on port ${port}${attempt?` (after ${attempt} retr${attempt>1?'ies':'y'})`:''}`);
        return;
      }catch(e:any){
        const msg=String(e?.message||e);
        if(/EADDRINUSE/.test(msg)&&attempt<MOBILE_PORT_RETRIES){await new Promise(r=>setTimeout(r,MOBILE_PORT_RETRY_MS));continue;}
        output.appendLine(`mobile web app auto-start failed: ${msg}`);
        return;
      }
    }
  })();
  context.subscriptions.push(vscode.commands.registerCommand('devhub.openMobileApp',async()=>{
    const conf=vscode.workspace.getConfiguration('devHub');
    if(!conf.get('mobile.enabled',false)){
      const pick=await vscode.window.showWarningMessage(
        'The Dev Hub mobile web app serves this machine\'s Claude sessions over HTTP on your local network. Anyone on this Wi-Fi holding the URL can start and steer agents here.',
        {modal:true},'Enable');
      if(pick!=='Enable')return;
      await conf.update('mobile.enabled',true,vscode.ConfigurationTarget.Global);
    }
    try{
      const lan=conf.get('mobile.lan',true);
      const wanted=Math.max(0,conf.get('mobile.port',39642));
      const {port}=await mobileServer().start(wanted,!!lan);
      // The link must carry the LAN IP, not 127.0.0.1: on the phone loopback is the phone itself.
      // Only when the socket really is open to the LAN — previously this fallback only changed the URL while still binding 0.0.0.0.
      const host=(lan&&lanAddress())||'127.0.0.1';
      // No more `?t=`: the page asks for the passcode itself. The URL is now constant, so bookmarks/PWAs keep working.
      const link=`http://${host}:${port}/`;
      const external=vscode.Uri.parse(link);
      await vscode.env.clipboard.writeText(link);
      output.appendLine(`mobile web app on ${link}`);
      const note=host!=='127.0.0.1'?'':lan?' (no private LAN address found — this machine only)'
        :' (loopback only — devHub.mobile.lan is off)';
      // Port 0 takes a free port on every activate, i.e. the URL just copied dies after Reload Window —
      // exactly what the passcode exists to end, so say it rather than leave it to be discovered.
      const drift=wanted?'':' — devHub.mobile.port is 0, so this URL dies on the next window reload';
      const pick=await vscode.window.showInformationMessage(`Dev Hub mobile URL copied${note} — ${link}${drift}`,'Open');
      if(pick==='Open')await vscode.env.openExternal(external);
    }catch(e:any){
      const msg=String(e?.message||e);
      // The port is pinned so a clash is real (a second window, a tunnel host); say which port rather
      // than jumping to another one — the URL saved on the phone is what's being protected.
      if(/EADDRINUSE/.test(msg)){
        const go=await vscode.window.showErrorMessage(
          `Dev Hub: port ${conf.get('mobile.port',39642)} is already in use — something else (another window serving this page?) holds it. Free it, or change devHub.mobile.port.`,'Open Settings');
        if(go==='Open Settings')await vscode.commands.executeCommand('workbench.action.openSettings','devHub.mobile.port');
        return;
      }
      if(!/passcode/.test(msg))return void vscode.window.showErrorMessage(`Dev Hub: mobile web app failed to start — ${msg}`);
      const go=await vscode.window.showErrorMessage(
        'Dev Hub: set a passcode before serving the page — devHub.mobile.passcode takes 4-12 digits. It is the only thing guarding a page that can run agents on this machine.','Open Settings');
      if(go==='Open Settings')await vscode.commands.executeCommand('workbench.action.openSettings','devHub.mobile.passcode');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('devhub.rotateMobileToken',async()=>{
    // Every device's cookie points at the old token; changing the token kicks them all out, including a lost one.
    if(!mobile)return void vscode.window.showInformationMessage('Dev Hub: the mobile web app is not running — nothing is signed in.');
    const pick=await vscode.window.showWarningMessage(
      'Sign every phone out of the Dev Hub mobile web app? Each one has to enter the passcode again.',{modal:true},'Sign out all');
    if(pick!=='Sign out all')return;
    mobile.rotateToken();
    output.appendLine('mobile token rotated — every signed-in device was logged out');
    vscode.window.showInformationMessage('Dev Hub: every device was signed out of the mobile web app.');
  }));
  let firstVisible=true;const openDevHub=async()=>{if(!firstVisible)return;firstVisible=false;void cliUpdate.refresh();await manager?.recoverStaleSessions();await refreshHistory();const key=context.globalState.get('devhub.lastSession');const restored=findRestorableSession(await sessionStore.list(),key as any);if(restored)await chat?.restoreSelection(restored);};treeView.onDidChangeVisibility(async(e:any)=>{if(e.visible)await openDevHub();});if(treeView.visible)void openDevHub();
  // Only notify when the session is NOT the one being viewed — that one the eye already sees.
  const notifyMode=()=>vscode.workspace.getConfiguration('devHub').get('notify','background');
  const nameOf=async(s:any)=>{const snap=await workspaces.snapshot();
    return snap.projects.find((p:any)=>p.id===s.projectId)?.name||s.cwd;};
  const wasRunning=new Map<string,boolean>();
  manager.on('sessionUpdated',async(s:any)=>{
    const key=`${s.provider}:${s.nativeSessionId}`;
    const before=wasRunning.get(key);wasRunning.set(key,s.status==='running');
    if(before!==true||s.status==='running')return;
    const mode=notifyMode(); if(mode==='off')return;
    if(mode==='background'&&chat?.currentSessionId?.()===s.nativeSessionId)return;
    const label=s.status==='done'?'finished':s.status;
    vscode.window.showInformationMessage(`${await nameOf(s)} · ${providerLabel(s.provider)} ${label}`,'Open')
      .then((pick:any)=>{if(pick==='Open')void chat?.openSession(s);});
  });
  /**
   * Planner reminder: the daemon wakes itself and speaks into the scheduled conversation. This is the
   * ONLY path where it speaks first — everything else is Dev Hub asking. With no tab open `injectEvent`
   * writes nothing and the daemon keeps that turn in `/conversations`, so the next open still reads it.
   */
  const plannerEndpoints=()=>{
    const conf=vscode.workspace.getConfiguration('devHub');
    const eps=normalizeAgents(conf.get('agents',[])).filter(isHttpAgent).map(endpointOf);
    const fallback=String(conf.get('planner.endpoint','')||'');
    if(!eps.length&&fallback)eps.push(fallback);
    return [...new Set(eps)];
  };
  plannerWatch=new PlannerWatcher(async(push:PlannerReminderPush)=>{
    const sessionId=plannerSessionId(push.endpoint,push.conversationId);
    const session=await sessionStore.get('planner',sessionId);
    const event:any={type:'assistant_message',text:push.reply,timestamp:Date.now()};
    chat?.injectEvent('planner',sessionId,event);
    mobile?.injectEvent('planner',sessionId,event);
    tree.refresh();
    output.appendLine(`planner reminder fired: ${push.conversationId} ${push.note}`);
    if(notifyMode()==='off')return;
    if(notifyMode()==='background'&&chat?.currentSessionId?.()===sessionId)return;
    const label=[push.jiraKey,push.note].filter(Boolean).join(' · ')||'scheduled check';
    const pick=await vscode.window.showInformationMessage(`Planner: ${label}`,'Open');
    // A session not yet in the store means nobody has opened that tab; tapping the row in the tree is enough.
    if(pick==='Open'&&session)void chat?.openSession(session);
  },(line:string)=>output.appendLine(line));
  plannerWatch.watch(plannerEndpoints());
  context.subscriptions.push({dispose:()=>{plannerWatch?.dispose();plannerWatch=undefined;}});
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e:any)=>{
    if(!e.affectsConfiguration('devHub.agents')&&!e.affectsConfiguration('devHub.planner.endpoint'))return;
    plannerWatch?.watch(plannerEndpoints());
  }));
  manager.on('sessionUpdated',()=>{tree.refreshRows();status?.update();});manager.on('sessionAdded',()=>{tree.refreshRows();status?.update();});manager.on('sessionRekeyed',()=>{tree.refreshRows();status?.update();});
  output.appendLine('Dev Hub ready');
}
export async function deactivate(){try{await manager?.cancelAll();await manager?.waitForIdle();}catch{}try{chat?.dispose();mobile?.dispose();status?.dispose();}catch{}}
