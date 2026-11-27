import { plannerConversationId } from './sessions/plannerIdentity';
const vscode:any=require('vscode');
import { WorkspaceService } from './workspace/workspaceService';
import { DevHubTreeProvider, DevHubTreeNode } from './views/devHubTreeProvider';
import { ChatPanelProvider } from './views/chatPanelProvider';
import { SessionStore } from './storage/sessionStore';
import { SessionManager } from './sessions/sessionManager';
import { PlannerClient, PlannerTask } from './providers/planner/plannerClient';
import { chatSession, endpointOf, isHttpAgent } from './agents/plannerTasks';
import { normalizeAgents } from './agents/agentRunner';
import { DevHubSession } from './types';

/** Signal 0 sends nothing; it only asks whether the process is still alive. */
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
function signal(pid:number,sig:'SIGTERM'|'SIGKILL'){
  try{process.kill(pid,sig);return true;}
  catch(e:any){vscode.window.showWarningMessage(`Dev Hub: cannot ${sig} pid ${pid} \u2014 ${e?.message||e}`);return false;}
}

export function registerCommands(ctx:any,deps:{workspaces:WorkspaceService;tree:DevHubTreeProvider;chat:ChatPanelProvider;sessions:SessionStore;manager:SessionManager;refreshHistory:()=>Promise<void>}){
  const r=(id:string,fn:(...a:any[])=>any)=>ctx.subscriptions.push(vscode.commands.registerCommand(id,fn));
  r('devhub.addWorkspace',async()=>{const name=await vscode.window.showInputBox({prompt:'Workspace name',placeHolder:'SideProject / DayJob / ClientWork'});if(!name?.trim())return;await deps.workspaces.createWorkspace(name);deps.tree.refresh();});
  r('devhub.renameWorkspace',async(node?:DevHubTreeNode)=>{const ws=node?.type==='workspace'?node.data.workspace:undefined;if(!ws)return;const name=await vscode.window.showInputBox({prompt:'Rename workspace',value:ws.name});if(!name?.trim())return;await deps.workspaces.renameWorkspace(ws.id,name);deps.tree.refresh();});
  r('devhub.addProject',async(node?:DevHubTreeNode)=>{const snap=await deps.workspaces.snapshot();let ws=node?.type==='workspace'?node.data.workspace:undefined;if(!ws){const pick=await vscode.window.showQuickPick(snap.workspaces.map(w=>({label:w.name,id:w.id})),{placeHolder:'Choose Dev Hub workspace'});if(!pick)return;ws=snap.workspaces.find(w=>w.id===pick.id);}if(!ws){vscode.window.showInformationMessage('Create a Dev Hub workspace first.');return;}const uris=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:true,openLabel:'Add to Dev Hub'});if(!uris?.length)return;for(const uri of uris){try{await deps.workspaces.addProjects(ws.id,[uri.fsPath]);}catch(e:any){vscode.window.showWarningMessage(`Dev Hub: ${e?.message||e}`);}}deps.tree.refresh();});
  r('devhub.removeProject',async(node?:DevHubTreeNode)=>{if(node?.type!=='project')return;const answer=await vscode.window.showWarningMessage(`Remove ${node.data.project.name} from Dev Hub? Native Claude history is not deleted.`,'Remove');if(answer!=='Remove')return;await deps.workspaces.removeProject(node.data.project.id);deps.tree.refresh();});
  const newChat=async(provider:'claude',node?:DevHubTreeNode)=>{const snap=await deps.workspaces.snapshot();let project=node?.type==='project'?node.data.project:undefined;let workspace=node?.workspace ?? (node?.type==='workspace'?node.data.workspace:undefined);if(!project){const candidates=workspace?snap.projects.filter(p=>p.workspaceId===workspace.id):snap.projects;const picks=candidates.map(p=>({label:p.name,description:snap.workspaces.find(w=>w.id===p.workspaceId)?.name,project:p}));const pick=await vscode.window.showQuickPick(picks,{placeHolder:`Choose project for ${provider}`});if(!pick)return;project=pick.project;workspace=snap.workspaces.find(w=>w.id===project.workspaceId);}if(project&&workspace)await deps.chat.newChat(workspace,project,provider);};
  r('devhub.newClaudeChat',(node?:DevHubTreeNode)=>newChat('claude',node));
  // TreeView has no double-click event: every click re-runs the item's command, so two
  // openChat calls on the same row in quick succession = double-click → rename. The first click still opens the chat as before.
  let lastClick={key:'',at:0};
  const renameSession=async(s:DevHubSession)=>{const name=await vscode.window.showInputBox({prompt:'Rename chat (empty = back to the first prompt)',value:s.name||s.title});if(name===undefined)return;await deps.sessions.rename(s.provider,s.nativeSessionId,name);deps.tree.refresh();};
  r('devhub.openChat',async(node?:DevHubTreeNode)=>{if(node?.type!=='session'){deps.chat.showCurrent();return;}
    const key=`${node.data.provider}\u0000${node.data.nativeSessionId}`,now=Date.now(),dbl=key===lastClick.key&&now-lastClick.at<500;
    lastClick=dbl?{key:'',at:0}:{key,at:now};
    if(dbl){await renameSession((await deps.sessions.get(node.data.provider,node.data.nativeSessionId))??node.data);return;}
    await deps.chat.openSession(node.data);});
  r('devhub.renameSession',async(node?:DevHubTreeNode)=>{if(node?.type!=='session')return;await renameSession((await deps.sessions.get(node.data.provider,node.data.nativeSessionId))??node.data);});
  r('devhub.searchProject',async()=>{const snap=await deps.workspaces.snapshot();
    const items=snap.projects.map(p=>({label:p.name,description:snap.workspaces.find(w=>w.id===p.workspaceId)?.name,detail:p.rootPath,project:p}));
    const pick=await vscode.window.showQuickPick(items,{placeHolder:'Search project\u2026',matchOnDescription:true,matchOnDetail:true});if(!pick)return;
    const ws=snap.workspaces.find(w=>w.id===pick.project.workspaceId);if(!ws)return;
    await deps.chat.newChat(ws,pick.project,'claude');});
  r('devhub.showMoreSessions',(node?:DevHubTreeNode)=>{if(node?.type!=='more')return;deps.tree.showMore(node.data.projectId,node.data.total);deps.tree.refresh();});
  const agentAction=async(node:any,verb:'start'|'stop')=>{
    if(node?.type!=='agent')return;const spec=node.data.spec;
    try{ const out=await deps.tree.agents().run(spec,verb);
      vscode.window.setStatusBarMessage(`${spec.name}: ${out.split('\n').pop()||verb}`,3000);
    }catch(e:any){vscode.window.showWarningMessage(`${spec.name} ${verb} failed: ${e?.message||e}`);}
    deps.tree.refresh();
  };
  r('devhub.showMoreAgentThreads',(n?:any)=>{if(n?.type!=='agentMore')return;
    deps.tree.showMoreAgentThreads(n.data.name);deps.tree.refresh();});
  r('devhub.copyAgentThreadId',async(n?:any)=>{if(n?.type!=='agentThread')return;
    await vscode.env.clipboard.writeText(n.data.thread.id);
    vscode.window.setStatusBarMessage('Thread id copied',1500);});
  /**
   * A session is only written to the store when the user actually opens it — the inbox is not history.
   * `upsert` merges SHALLOW so whatever field the new row declares wins, and both `taskSession` and
   * `chatSession` declare `status:'imported'`: reopening a running session would erase 'running'
   * from the store and the status bar would lose "1 running" mid-turn. `chatSession` also declares timestamp 0,
   * enough to sink that row to the bottom of every list sorted by `updatedAt`.
   */
  const openPlanner=async(fresh:DevHubSession)=>{
    const old=await deps.sessions.get('planner',fresh.nativeSessionId);
    const session=await deps.sessions.upsert(old?{...fresh,
      ...(old.status==='running'?{status:old.status}:{}),
      createdAt:fresh.createdAt||old.createdAt,updatedAt:fresh.updatedAt||old.updatedAt}:fresh);
    await deps.chat.openSession(session);
    deps.tree.refresh();
  };
  r('devhub.openPlannerSession',async(n?:any)=>{
    if(n?.type!=='plannerTask'&&n?.type!=='plannerChat')return;
    await openPlanner(n.data.session);
  });
  /** A free-form question, callable from the palette so it doesn't depend on the tree being open or collapsed. */
  r('devhub.askAgent',async()=>{
    const agents=normalizeAgents(vscode.workspace.getConfiguration('devHub').get('agents',[])).filter(isHttpAgent);
    if(!agents.length){vscode.window.showInformationMessage('No task agent configured — add one to devHub.agents with "kind":"http".');return;}
    const spec=agents.length===1?agents[0]
      :(await vscode.window.showQuickPick(agents.map(a=>({label:a.name,description:endpointOf(a),spec:a})),{placeHolder:'Ask which agent?'}))?.spec;
    if(!spec)return;
    const snap=await deps.workspaces.snapshot();
    await openPlanner(chatSession(spec,snap.projects));
  });
  const plannerClient=(n:any)=>new PlannerClient(endpointOf(n.data.spec),20000);
  /** A tree row may be stale; every action re-reads the REAL task before touching it. */
  const freshTask=async(n:any):Promise<{client:PlannerClient;task:PlannerTask}|undefined>=>{
    const client=plannerClient(n);
    try{return {client,task:await client.task(n.data.task.jira_key)};}
    catch(e:any){vscode.window.showWarningMessage(`Dev Hub: ${n.data.task.jira_key} unreadable \u2014 ${e?.message||e}`);return undefined;}
  };
  const afterPlanner=(task:PlannerTask,note:string)=>{
    vscode.window.setStatusBarMessage(`${task.jira_key}: ${note}`,3000);deps.tree.refresh();};
  r('devhub.plannerApprove',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const fresh=await freshTask(n);if(!fresh)return;
    const {client,task}=fresh;
    const version=Number(task.plan_version||0);
    if(task.status!=='WAITING_APPROVAL'||!version){
      vscode.window.showWarningMessage(`${task.jira_key} is ${task.status}, not WAITING_APPROVAL \u2014 nothing to approve.`);
      deps.tree.refresh();return;}
    // Modal: approving lets it write code. The version must be in the question, not implied.
    const detail=[task.summary,`plan v${version}`,
      typeof task.confidence==='number'?`confidence ${task.confidence.toFixed(2)}`:'',
      task.affected_repos?.length?`repos: ${task.affected_repos.join(', ')}`:''].filter(Boolean).join('\n');
    const pick=await vscode.window.showWarningMessage(`Approve ${task.jira_key} plan v${version}?`,{modal:true,detail},'Approve');
    if(pick!=='Approve')return;
    try{afterPlanner(await client.approve(task.jira_key,version),`approved v${version}`);}
    catch(e:any){vscode.window.showErrorMessage(`Approve failed \u2014 ${e?.message||e}`);deps.tree.refresh();}
  });
  r('devhub.plannerReject',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const fresh=await freshTask(n);if(!fresh)return;
    const reason=await vscode.window.showInputBox({prompt:`Reject ${fresh.task.jira_key} \u2014 why?`,placeHolder:'wrong service / missing context / later'});
    if(reason===undefined)return;
    try{afterPlanner(await fresh.client.reject(fresh.task.jira_key,reason),'rejected');}
    catch(e:any){vscode.window.showErrorMessage(`Reject failed \u2014 ${e?.message||e}`);deps.tree.refresh();}
  });
  /**
   * The ticket was finished outside the agent (merged by hand, closed by the PM). DON'T use Reject for this:
   * reject sends the task back to ANALYZING and deep-plans again for $5-7, while dismiss ends it.
   */
  r('devhub.plannerDismiss',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const fresh=await freshTask(n);if(!fresh)return;
    const {client,task}=fresh;
    const detail=[task.summary,`now ${task.status}`,
      'The agent stops tracking it. The scan will not plan it again, even if Jira changes.',
      'Reversible with "Watch Again".'].filter(Boolean).join('\n');
    const pick=await vscode.window.showWarningMessage(`Dismiss ${task.jira_key}?`,{modal:true,detail},'Dismiss');
    if(pick!=='Dismiss')return;
    const reason=await vscode.window.showInputBox({prompt:`Dismiss ${task.jira_key} — why? (optional)`,
      placeHolder:'done by hand / closed by PM / no longer needed'});
    if(reason===undefined)return;
    try{afterPlanner(await client.dismiss(task.jira_key,reason),'dismissed');}
    catch(e:any){vscode.window.showErrorMessage(`Dismiss failed — ${e?.message||e}`);deps.tree.refresh();}
  });
  r('devhub.plannerRevive',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const fresh=await freshTask(n);if(!fresh)return;
    try{afterPlanner(await fresh.client.revive(fresh.task.jira_key),'watching again');}
    catch(e:any){vscode.window.showErrorMessage(`Revive failed — ${e?.message||e}`);deps.tree.refresh();}
  });
  r('devhub.plannerExecute',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const fresh=await freshTask(n);if(!fresh)return;
    const {client,task}=fresh;
    if(task.status!=='APPROVED'){
      vscode.window.showWarningMessage(`${task.jira_key} is ${task.status}; only an APPROVED plan can run.`);
      deps.tree.refresh();return;}
    const detail=[task.summary,`approved v${task.approved_plan_version??task.plan_version}`,
      task.affected_repos?.length?`repos: ${task.affected_repos.join(', ')}`:'',
      'It writes commits in its own worktrees and pushes nothing.'].filter(Boolean).join('\n');
    const pick=await vscode.window.showWarningMessage(`Let the agent implement ${task.jira_key}?`,{modal:true,detail},'Execute');
    if(pick!=='Execute')return;
    // Preflight (Jira/repo changes) runs inside this POST and can take a few seconds; don't leave the window silent.
    await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`${task.jira_key}: preflight + execute`},async()=>{
      try{afterPlanner(await client.execute(task.jira_key),'executing');}
      catch(e:any){vscode.window.showErrorMessage(`Execute refused \u2014 ${e?.message||e}`);deps.tree.refresh();}
    });
  });
  r('devhub.plannerRefreshTask',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const client=plannerClient(n);
    try{afterPlanner(await client.refresh(n.data.task.jira_key),'refreshed from Jira');}
    catch(e:any){vscode.window.showWarningMessage(`Refresh failed \u2014 ${e?.message||e}`);}
  });
  r('devhub.plannerStopRun',async(n?:any)=>{
    if(n?.type!=='plannerTask')return;
    const fresh=await freshTask(n);if(!fresh)return;
    const runId=Number(fresh.task.current_run_id||0);
    if(!runId){vscode.window.showWarningMessage(`${fresh.task.jira_key} has no run to stop.`);deps.tree.refresh();return;}
    // `/runs/{id}/stop` only writes status='blocked' to the DB; the executor doesn't re-read it between fix
    // rounds, so the worker may still commit after this row changed colour. Don't say "stopped".
    try{await fresh.client.stopRun(runId);afterPlanner(fresh.task,`run ${runId} marked blocked — the worker may still finish its current fix loop`);}
    catch(e:any){vscode.window.showErrorMessage(`Stop failed \u2014 ${e?.message||e}`);deps.tree.refresh();}
  });
  r('devhub.copyJiraKey',async(n?:any)=>{if(n?.type!=='plannerTask')return;
    await vscode.env.clipboard.writeText(n.data.task.jira_key);
    vscode.window.setStatusBarMessage(`Copied ${n.data.task.jira_key}`,1500);});
  r('devhub.startAgent',(n?:any)=>agentAction(n,'start'));
  r('devhub.stopAgent',(n?:any)=>agentAction(n,'stop'));
  r('devhub.restartAgent',async(n?:any)=>{await agentAction(n,'stop');await agentAction(n,'start');});
  r('devhub.openAgentLogs',(n?:any)=>{
    if(n?.type!=='agent')return;const spec=n.data.spec;
    // The log runs `tail -f`, so it needs a real terminal rather than being swallowed into an output channel.
    const t=vscode.window.createTerminal({name:`${spec.name} logs`,cwd:spec.cwd});
    t.sendText(deps.tree.agents().logsCommand(spec));t.show();
  });
  r('devhub.revealAgent',async(n?:any)=>{if(n?.type!=='agent')return;
    await vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(n.data.spec.cwd));});
  // Jump between RUNNING sessions — exactly when your hands are busiest.
  const cycleRunning=async(delta:number)=>{
    const all=await deps.sessions.list();
    const running=all.filter((s:any)=>s.status==='running').sort((a:any,b:any)=>a.updatedAt-b.updatedAt);
    if(!running.length){vscode.window.setStatusBarMessage('Dev Hub: no running session',2000);return;}
    const cur=deps.chat.currentSessionId?.();
    const at=running.findIndex((s:any)=>s.nativeSessionId===cur);
    const next=running[((at<0?0:at+delta)%running.length+running.length)%running.length];
    await deps.chat.openSession(next);
  };
  r('devhub.nextRunning',()=>cycleRunning(1));
  r('devhub.previousRunning',()=>cycleRunning(-1));
  r('devhub.focusView',()=>vscode.commands.executeCommand('devHub.sessions.focus'));
  r('devhub.openPort',async(node?:DevHubTreeNode)=>{if(node?.type!=='port')return;await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${node.data.port}`));});
  r('devhub.copyPort',async(node?:DevHubTreeNode)=>{if(node?.type!=='port')return;await vscode.env.clipboard.writeText(String(node.data.port));vscode.window.setStatusBarMessage(`Copied :${node.data.port}`,1500);});
  const setPin=(node:any,on:boolean)=>{if(node?.type!=='port')return;
    deps.tree.setPinned(node.data.port,on);
    vscode.window.setStatusBarMessage(`:${node.data.port} ${on?'pinned':'unpinned'}`,1500);
    deps.tree.refresh();};
  r('devhub.pinPort',(n?:any)=>setPin(n,true));
  r('devhub.unpinPort',(n?:any)=>setPin(n,false));
  r('devhub.killPort',async(node?:DevHubTreeNode)=>{
    if(node?.type!=='port')return;
    const {proc,port}=node.data as any;
    // Modal: one mistake kills ControlCenter/Code Helper, with no undo.
    const answer=await vscode.window.showWarningMessage(
      `Kill ${proc.command} (pid ${proc.pid}) listening on :${port}?`,
      {modal:true,detail:proc.cwd||'(no cwd)'},'Kill');
    if(answer!=='Kill')return;
    if(!signal(proc.pid,'SIGTERM'))return;
    // SIGTERM so it cleans up itself; only a process that ignores it gets asked about SIGKILL.
    await new Promise(res=>setTimeout(res,1200));
    if(alive(proc.pid)){
      const force=await vscode.window.showWarningMessage(
        `pid ${proc.pid} still running after SIGTERM.`,'Force kill');
      if(force==='Force kill')signal(proc.pid,'SIGKILL');
    } else vscode.window.setStatusBarMessage(`:${port} killed`,2000);
    deps.tree.refresh();
  });
  r('devhub.refreshHistory',async()=>{await deps.refreshHistory();vscode.window.setStatusBarMessage('Dev Hub history refreshed',1500);});

  r('devhub.revealProject',async(node?:DevHubTreeNode)=>{if(node?.type!=='project')return;await vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(node.data.project.rootPath));});
  r('devhub.copySessionId',async(node?:DevHubTreeNode)=>{if(node?.type!=='session')return;await vscode.env.clipboard.writeText(node.data.provider==='planner'?plannerConversationId(node.data.nativeSessionId):node.data.nativeSessionId);vscode.window.setStatusBarMessage('Dev Hub session ID copied',1500);});
  r('devhub.stopSession',async(node?:DevHubTreeNode)=>{if(node?.type!=='session')return;await deps.manager.cancel(node.data.provider,node.data.nativeSessionId);deps.tree.refreshRows();});
}
