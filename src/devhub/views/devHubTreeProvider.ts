const vscode:any=require('vscode');
const nodePath=require('node:path');
import { WorkspaceService } from '../workspace/workspaceService';
import { SessionStore } from '../storage/sessionStore';
import { buildTreeModel, recentSessions } from './treeModel';
import { AgentRunner, AgentSpec, AgentState, normalizeAgents } from '../agents/agentRunner';
import { readThreads } from '../agents/agentThreads';
import { groupPortsByProject, PINNED, PortGroup, scanListeningPorts } from '../ports/portScanner';
import { providerLabel } from '../ui/format';
import { cliMemoryMB } from '../providers/processMemory';
import { PlannerClient, PlannerTask } from '../providers/planner/plannerClient';
import { chatSession, endpointOf, isHttpAgent, sortTasks, taskRow, taskSession } from '../agents/plannerTasks';

export type DevHubTreeNode = {type:'workspace'|'project'|'session'|'more'|'recent'|'ports'|'portGroup'|'port'|'agents'|'agent'|'agentThread'|'agentMore'|'plannerChat'|'plannerTask'|'plannerEmpty'|'plannerOffline'|'newchat'|'mobileapp'; data:any; workspace?:any; project?:any};

const FIRST_PAGE=3;   // every project opens only 3 sessions — the tree stays readable
const PAGE_STEP=5;    // each "More" click adds 5
const RECENT_LIMIT=8;
/** The tree refreshes every time a session changes state; lsof takes ~75ms so it needs a TTL. */
const PORTS_TTL_MS=5000;
const MEM_TTL_MS=5000;
const TASKS_TTL_MS=5000;
/** The inbox is what people open the tree to see, so it expands further than 3 rows like sessions. */
const PLANNER_FIRST_PAGE=8;
/**
 * The daemon does NOT push `task_state` over SSE (`api/events.py` has a policy for that kind but
 * `inbox` only `log_event`s to SQLite), so task state has to be polled. It scans Jira behind
 * our back, so even a "static" inbox changes — without polling the user would have to press refresh for something
 * that should just appear.
 *
 * Self-limiting: the timer is only re-armed from inside `plannerTasks()`, which only runs when
 * VS Code asks for the agent row's children. A hidden view or a collapsed row turns the loop off by itself.
 */
const TASKS_POLL_MS=15000;
const PROJECT_LABEL_MAX=16;
const TITLE_LABEL_MAX=60;
/** The title comes from the first message, so it often carries box-drawing characters / newlines from a paste. */
function cleanTitle(raw:string,max=TITLE_LABEL_MAX){
  const t=String(raw||'').replace(/[\u2500-\u257f\u2400-\u243f`]+/g,' ').replace(/\s+/g,' ').trim();
  return t.length>max?t.slice(0,max-1)+'\u2026':(t||'Untitled');
}
function shortName(raw:string,max=PROJECT_LABEL_MAX){
  const t=String(raw||'').trim();
  return t.length>max?t.slice(0,max-1)+'\u2026':t;
}
/**
 * Workspaces get colours from a hash, so they are unpredictable; the three fixed groups below are the opposite —
 * their colours are constants so the eye remembers their position, and they avoid the hash range above.
 */
export const SECTION={recent:'charts.blue',ports:'charts.green',agents:'charts.purple'} as const;
const ACCENTS=['charts.blue','charts.purple','charts.orange','charts.green','charts.yellow','charts.red'];
/** Name hash -> a fixed colour: the same workspace always gets the same accent, regardless of order. */
export function workspaceAccent(name:string){
  let h=0; for(let i=0;i<name.length;i++)h=(h*31+name.charCodeAt(i))>>>0;
  return ACCENTS[h%ACCENTS.length];
}
let MEDIA='';
export function setMediaRoot(dir:string){MEDIA=dir;}
/** The brand mark for every session, running ones included: recognising the vendor matters more than animation. */
function providerIcon(provider:string){
  // The planner has no vendor mark to borrow; it is a self-hosted daemon.
  if(provider==='planner')return new vscode.ThemeIcon('robot');
  if(!MEDIA)return new vscode.ThemeIcon('sparkle');
  return {light:vscode.Uri.file(nodePath.join(MEDIA,'claude-light.svg')),dark:vscode.Uri.file(nodePath.join(MEDIA,'claude-dark.svg'))};
}
export class DevHubTreeProvider {
  private emitter=new vscode.EventEmitter(); readonly onDidChangeTreeData=this.emitter.event;
  /** projectId -> number of sessions shown. In memory only: a reload goes back to 3. */
  private shown=new Map<string,number>();
  private agentRunner=new AgentRunner();
  /** agent name -> number of threads shown. Same paging as sessions: 3 then +5. */
  private agentShown=new Map<string,number>();
  private portsCache?:{at:number;groups:PortGroup[]};
  /**
   * RAM of the CLI processes, measured with one `ps` (~16ms). `refresh()` must NOT clear this cache:
   * it runs every time a session status changes, so every delta of a running turn would be a `ps`.
   * Expires by time, not by event.
   */
  private memCache?:{at:number;totalMB:number};
  private memPending=false;
  /** endpoint -> the inbox just read. A loopback GET is cheap, but tree refreshes are very frequent. */
  private tasksCache=new Map<string,{at:number;tasks:PlannerTask[];error?:string}>();
  private clients=new Map<string,PlannerClient>();
  private pollTimer:any;
  /** Pinned by PORT NUMBER, not pid — the pid changes on every server restart, the port doesn't. */
  private pins=new Set<number>();
  showMoreAgentThreads(name:string){this.agentShown.set(name,(this.agentShown.get(name)??FIRST_PAGE)+PAGE_STEP);}
  constructor(private workspaces:WorkspaceService,private sessions:SessionStore,
              private pinStore?:{get():number[];set(v:number[]):void},
              /** A pending approval request is LIVE state, not in the store — ask the panel
               *  and the mobile page while drawing instead of consulting a copy that drifts. */
              private awaiting?:(provider:string,sessionId:string)=>boolean,
              /** pids of every live CLI. Only Claude keeps a process after a turn; the planner is HTTP
               *  so it contributes nothing. */
              private livePids?:()=>number[]){
    for(const p of pinStore?.get?.()??[])if(Number.isInteger(p))this.pins.add(p);
  }
  pinnedPorts(){return [...this.pins].sort((a,b)=>a-b);}
  setPinned(port:number,on:boolean){
    if(!Number.isInteger(port))return;
    if(on)this.pins.add(port);else this.pins.delete(port);
    this.pinStore?.set?.(this.pinnedPorts());
  }
  refresh(node?:any){this.portsCache=undefined;this.tasksCache.clear();this.emitter.fire(node);}
  /**
   * Redraw rows WITHOUT dropping the ports/tasks cache. Used for things that happen often, like an
   * approval request appearing and being answered: `refresh()` clears the cache, and if the Ports group is
   * expanded each of those would be one `lsof` (~75ms) plus one GET `/tasks` — neither of which
   * changes because of an approval question.
   */
  refreshRows(){this.emitter.fire(undefined);}
  dispose(){if(this.pollTimer)clearTimeout(this.pollTimer);this.pollTimer=undefined;}
  private client(endpoint:string){
    let c=this.clients.get(endpoint);
    if(!c){c=new PlannerClient(endpoint,8000);this.clients.set(endpoint,c);}
    return c;
  }
  /** Schedule exactly ONE refresh for this draw; the next draw schedules the next one. */
  private schedulePoll(){
    if(this.pollTimer)return;
    this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;this.refresh();},TASKS_POLL_MS);
    this.pollTimer?.unref?.();
  }
  private async plannerTasks(spec:AgentSpec):Promise<{tasks:PlannerTask[];error?:string}>{
    const endpoint=endpointOf(spec);
    const hit=this.tasksCache.get(endpoint);
    if(hit&&Date.now()-hit.at<TASKS_TTL_MS)return hit;
    let entry:{at:number;tasks:PlannerTask[];error?:string};
    try{entry={at:Date.now(),tasks:await this.client(endpoint).tasks()};}
    catch(e:any){entry={at:Date.now(),tasks:[],error:String(e?.message||e).slice(0,120)};}
    this.tasksCache.set(endpoint,entry);
    this.schedulePoll();
    return entry;
  }
  agents(){return this.agentRunner;}
  showMore(projectId:string,total:number){
    const next=Math.min((this.shown.get(projectId)??FIRST_PAGE)+PAGE_STEP,total);
    this.shown.set(projectId,next);
  }
  collapseSessions(projectId:string){this.shown.delete(projectId);}
  /** MB already known; if not, measure in the background then redraw exactly ONCE (the fresh cache is still valid so
   *  that draw doesn't measure again — no render loop). */
  private cliMemory():number|undefined{
    const hit=this.memCache;
    if(hit&&Date.now()-hit.at<MEM_TTL_MS)return hit.totalMB;
    if(!this.memPending&&this.livePids){
      this.memPending=true;
      void cliMemoryMB(this.livePids()).catch(()=>0).then(mb=>{
        this.memCache={at:Date.now(),totalMB:mb};this.memPending=false;this.refreshRows();});
    }
    return hit?.totalMB;
  }
  private async portGroups():Promise<PortGroup[]>{
    const hit=this.portsCache;
    if(hit&&Date.now()-hit.at<PORTS_TTL_MS)return hit.groups;
    const [procs,snap]=await Promise.all([scanListeningPorts(),this.workspaces.snapshot()]);
    const agents=normalizeAgents(vscode.workspace.getConfiguration('devHub').get('agents',[]));
    const groups=groupPortsByProject(procs,snap.projects,this.pins,agents);
    this.portsCache={at:Date.now(),groups};
    return groups;
  }
  async getChildren(element?:DevHubTreeNode):Promise<DevHubTreeNode[]>{
    if(element?.type==='workspace')return element.data.projects.map((p:any)=>({type:'project',data:p,workspace:element.data.workspace,project:p.project}));
    if(element?.type==='project'){
      const all=element.data.sessions as any[];
      const id=element.data.project.id;
      const limit=Math.min(this.shown.get(id)??FIRST_PAGE,all.length);
      const nodes:DevHubTreeNode[]=all.slice(0,limit).map((s:any)=>({type:'session',data:s,workspace:element.workspace,project:element.project}));
      if(all.length>limit)nodes.push({type:'more',data:{projectId:id,shown:limit,total:all.length},workspace:element.workspace,project:element.project});
      return nodes;
    }
    if(element?.type==='agents'){
      const states=await Promise.all((element.data.agents as AgentSpec[]).map(a=>this.agentRunner.status(a)));
      return states.map(st=>({type:'agent',data:st} as DevHubTreeNode));
    }
    if(element?.type==='agent'&&isHttpAgent((element.data as AgentState).spec)){
      const st=element.data as AgentState;
      const {tasks,error}=await this.plannerTasks(st.spec);
      const snap=await this.workspaces.snapshot();
      const nodes:DevHubTreeNode[]=[];
      if(error)return [{type:'plannerOffline',data:{spec:st.spec,error}}];
      const sorted=sortTasks(tasks);
      // An empty inbox is a NORMAL state (the JQL matched nothing, the sprint isn't open); returning [] makes the
      // agent row expand to nothing, indistinguishable from a tree that hasn't finished loading.
      if(!sorted.length)return [{type:'plannerEmpty',data:{spec:st.spec}}];
      const want=this.agentShown.get(st.spec.name)??PLANNER_FIRST_PAGE;
      for(const task of sorted.slice(0,want))
        nodes.push({type:'plannerTask',data:{spec:st.spec,task,session:taskSession(st.spec,task,snap.projects)}});
      if(sorted.length>want)nodes.push({type:'agentMore',data:{name:st.spec.name,shown:want}});
      return nodes;
    }
    if(element?.type==='agent'){
      const st=element.data as AgentState;
      const want=this.agentShown.get(st.spec.name)??FIRST_PAGE;
      const rows=await readThreads(st.spec.cwd,st.spec.db,want+1);
      const nodes:DevHubTreeNode[]=rows.slice(0,want).map(t=>({type:'agentThread',data:{thread:t,spec:st.spec}}));
      if(rows.length>want)nodes.push({type:'agentMore',data:{name:st.spec.name,shown:want}});
      return nodes;
    }
    if(element?.type==='ports'){
      const groups=await this.portGroups();
      return groups.map(g=>({type:'portGroup',data:g} as DevHubTreeNode));
    }
    if(element?.type==='portGroup'){
      const g=element.data as PortGroup;
      return g.procs.flatMap(proc=>proc.ports.map(port=>({type:'port',data:{proc,port,pinned:!!g.pinned}} as DevHubTreeNode)));
    }
    if(element?.type==='recent'){
      const byId=new Map<string,any>((element.data.projects||[]).map((p:any)=>[p.id,p]));
      return (element.data.sessions as any[]).map((s:any)=>({type:'session',data:s,project:byId.get(s.projectId)}));
    }
    if(element)return [];
    const [snap,sessionList]=await Promise.all([this.workspaces.snapshot(),this.sessions.list()]);
    const nodes:DevHubTreeNode[]=buildTreeModel(snap.workspaces,snap.projects,sessionList).map(w=>({type:'workspace',data:w,workspace:w.workspace}));
    const recent=recentSessions(sessionList,RECENT_LIMIT);
    if(recent.length)nodes.push({type:'recent',data:{sessions:recent,projects:snap.projects}});
    nodes.push({type:'ports',data:{}});
    const agents=normalizeAgents(vscode.workspace.getConfiguration('devHub').get('agents',[]));
    if(agents.length)nodes.push({type:'agents',data:{agents}});
    // Asking "anything to do?" is the most common action, so it must not sit behind expanding the tree.
    for(const spec of agents.filter(isHttpAgent))
      nodes.push({type:'plannerChat',data:{spec,session:chatSession(spec,snap.projects)}});
    // VS Code allows no floating button in a TreeView; the last row of the tree is the closest thing.
    if(snap.projects.length)nodes.push({type:'newchat',data:{}});
    nodes.push({type:'mobileapp',data:{}});
    return nodes;
  }
  getTreeItem(node:DevHubTreeNode){
    if(node.type==='workspace'){
      const item=new vscode.TreeItem(node.data.workspace.name,vscode.TreeItemCollapsibleState.Expanded);item.contextValue='devhubWorkspace';item.iconPath=new vscode.ThemeIcon('root-folder-opened',new vscode.ThemeColor(workspaceAccent(node.data.workspace.name)));item.description=node.data.runningCount?`\u25cf ${node.data.runningCount}`:undefined;item.tooltip=`${node.data.projects.length} project(s)`;return item;
    }
    if(node.type==='project'){
      const item=new vscode.TreeItem(node.data.project.name,vscode.TreeItemCollapsibleState.Expanded);item.contextValue='devhubProject';item.iconPath=new vscode.ThemeIcon(node.data.project.gitRoot?'repo':'folder');const run=node.data.sessions.filter((s:any)=>s.status==='running').length;item.description=run?`\u25cf ${run}`:undefined;item.tooltip=node.data.project.rootPath;return item;
    }
    if(node.type==='newchat'){
      const item=new vscode.TreeItem('New chat\u2026',vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubNewChat';item.iconPath=new vscode.ThemeIcon('add',new vscode.ThemeColor('charts.green'));
      item.tooltip='Pick a project, then a provider  (\u2325\u2318J)';
      item.command={command:'devhub.searchProject',title:'New chat'};
      return item;
    }
    if(node.type==='mobileapp'){
      const item=new vscode.TreeItem('Open on phone\u2026',vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubMobileApp';item.iconPath=new vscode.ThemeIcon('device-mobile',new vscode.ThemeColor(SECTION.recent));
      item.tooltip='Serve this chat as a real web page and copy its URL \u2014 not a webview, so it renders where the panel stays blank (iOS)';
      item.command={command:'devhub.openMobileApp',title:'Open on phone'};
      return item;
    }
    if(node.type==='agents'){
      const item=new vscode.TreeItem('Agents',vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue='devhubAgents';item.iconPath=new vscode.ThemeIcon('server-process',new vscode.ThemeColor(SECTION.agents));
      item.description=`${node.data.agents.length}`;item.tooltip='Long-running terminal bots';return item;
    }
    if(node.type==='plannerChat'){
      const item=new vscode.TreeItem(node.data.session.title,vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubPlannerChat';item.iconPath=new vscode.ThemeIcon('comment-discussion',new vscode.ThemeColor(SECTION.agents));
      item.tooltip='Ask anything — same conversation, so the daemon keeps its cache';
      item.command={command:'devhub.openPlannerSession',title:'Ask the agent',arguments:[node]};
      return item;
    }
    if(node.type==='plannerEmpty'){
      const item=new vscode.TreeItem('inbox empty',vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubPlannerEmpty';
      item.iconPath=new vscode.ThemeIcon('inbox',new vscode.ThemeColor('disabledForeground'));
      item.description=endpointOf(node.data.spec);
      item.tooltip='The daemon is up but has no tasks yet — it scans Jira periodically and rows will appear by themselves';
      return item;
    }
    if(node.type==='plannerOffline'){
      const item=new vscode.TreeItem('daemon unreachable',vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubPlannerOffline';
      item.iconPath=new vscode.ThemeIcon('error',new vscode.ThemeColor('errorForeground'));
      item.description=node.data.error;item.tooltip=`${endpointOf(node.data.spec)}\n${node.data.error}`;
      return item;
    }
    if(node.type==='plannerTask'){
      const task=node.data.task as PlannerTask;
      const row=taskRow(task);
      const item=new vscode.TreeItem(row.label,vscode.TreeItemCollapsibleState.None);
      item.contextValue=row.contextValue;item.description=row.description;
      item.iconPath=new vscode.ThemeIcon(row.icon,row.color?new vscode.ThemeColor(row.color):undefined);
      item.tooltip=[task.summary,task.affected_repos?.length?`repos: ${task.affected_repos.join(', ')}`:'',
                    task.approved_plan_version?`approved v${task.approved_plan_version}`:'',
                    task.last_error?`error: ${task.last_error}`:'',
                    task.updated_at?new Date(task.updated_at*1000).toLocaleString():''].filter(Boolean).join('\n');
      item.command={command:'devhub.openPlannerSession',title:'Open task',arguments:[node]};
      return item;
    }
    if(node.type==='agent'){
      const st=node.data as AgentState;
      const item=new vscode.TreeItem(st.spec.name,vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue=st.running?'devhubAgentRunning':'devhubAgentStopped';
      item.iconPath=new vscode.ThemeIcon(st.running?'circle-filled':'circle-outline',
        new vscode.ThemeColor(st.running?'charts.green':'disabledForeground'));
      item.description=st.detail;item.tooltip=`${st.spec.cwd}\n${st.detail}`;return item;
    }
    if(node.type==='recent'){
      const item=new vscode.TreeItem('Recent',vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue='devhubRecent';item.iconPath=new vscode.ThemeIcon('history',new vscode.ThemeColor(SECTION.recent));
      const mb=this.cliMemory();
      // The total includes sessions with no visible row (collapsed projects, beyond the first page,
      // outside the Recent top 8) — exactly the kind of process eating RAM that the tree doesn't show.
      item.description=mb?`${node.data.sessions.length} \u00b7 ${mb}MB`:`${node.data.sessions.length}`;
      item.tooltip=mb?`Most recent sessions across every workspace\nLive CLI processes: ${mb}MB`
                     :'Most recent sessions across every workspace';
      return item;
    }
    if(node.type==='ports'){
      const item=new vscode.TreeItem('Ports',vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue='devhubPorts';item.iconPath=new vscode.ThemeIcon('plug',new vscode.ThemeColor(SECTION.ports));
      const cached=this.portsCache?.groups;
      if(cached)item.description=`${cached.reduce((n,g)=>n+g.procs.reduce((m,p)=>m+p.ports.length,0),0)}`;
      item.tooltip='TCP ports listening under your user, grouped by project';
      return item;
    }
    if(node.type==='portGroup'){
      const g=node.data as PortGroup;
      const item=new vscode.TreeItem(shortName(g.name,24),vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue=g.pinned?'devhubPortGroupPinned':'devhubPortGroup';
      const [pgIcon,pgColor]=g.pinned?['pinned','charts.yellow']:g.known?['repo',SECTION.ports]
        :g.name==='System'?['gear','disabledForeground']:['folder','descriptionForeground'];
      item.iconPath=new vscode.ThemeIcon(pgIcon,new vscode.ThemeColor(pgColor));
      item.description=`${g.procs.reduce((n,p)=>n+p.ports.length,0)}`;
      item.tooltip=g.name===PINNED?'Ports you pinned \u2014 they stay at the top':
        g.procs.map(p=>`${p.command} (pid=${p.pid})\n${p.cwd||''}`).join('\n\n');
      return item;
    }
    if(node.type==='port'){
      const {proc,port,pinned}=node.data;
      const item=new vscode.TreeItem(`:${port}`,vscode.TreeItemCollapsibleState.None);
      item.contextValue=pinned?'devhubPortPinned':'devhubPort';
      item.iconPath=new vscode.ThemeIcon('circle-filled',new vscode.ThemeColor('charts.green'));
      // The Pinned group loses project context, so put the original group name in the description.
      item.description=proc.group?`${shortName(proc.command,20)} \u00b7 ${shortName(proc.group,16)}`:shortName(proc.command,28);
      item.tooltip=`${proc.command} · pid ${proc.pid}\n${proc.cwd||'(no cwd)'}\nhttp://localhost:${port}`;
      item.command={command:'devhub.openPort',title:'Open in browser',arguments:[node]};
      return item;
    }
    if(node.type==='agentThread'){
      const t=node.data.thread;
      const item=new vscode.TreeItem(cleanTitle(t.title),vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubAgentThread';item.iconPath=new vscode.ThemeIcon('comment',new vscode.ThemeColor('descriptionForeground'));
      const names=vscode.workspace.getConfiguration('devHub').get('agentNames',{}) as Record<string,string>;
      const nm=(v?:string)=>v?(names[v]||v):undefined;
      // Raw Slack ids are hard to read; devHub.agentNames lets you set friendly names.
      const bits=[nm(t.channel),nm(t.user),t.at?new Date(t.at).toLocaleString():undefined].filter(Boolean);
      item.description=bits.join(' \u00b7 ')||undefined;
      item.tooltip=[node.data.spec.name,t.channel?`channel ${nm(t.channel)}`:'',t.user?`user ${nm(t.user)}`:'',t.id]
        .filter(Boolean).join('\n');
      item.command={command:'devhub.copyAgentThreadId',title:'Copy thread id',arguments:[node]};
      return item;
    }
    if(node.type==='agentMore'){
      const item=new vscode.TreeItem(`More\u2026 (${node.data.shown})`,vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubAgentMore';item.iconPath=new vscode.ThemeIcon('ellipsis');
      item.command={command:'devhub.showMoreAgentThreads',title:'Show more',arguments:[node]};
      return item;
    }
    if(node.type==='more'){
      const {shown,total,projectId}=node.data;
      const item=new vscode.TreeItem(`More\u2026 (${shown}/${total})`,vscode.TreeItemCollapsibleState.None);
      item.contextValue='devhubMore';item.iconPath=new vscode.ThemeIcon('ellipsis');
      item.tooltip=`Show ${Math.min(PAGE_STEP,total-shown)} more session(s)`;
      item.command={command:'devhub.showMoreSessions',title:'Show more',arguments:[node]};
      void projectId;return item;
    }
    const s=node.data;
    // The label is [status emoji] + name; the brand mark is in iconPath. Recent no longer has a repo prefix: it ate
    // all of the narrow width, and users name rows themselves (double-click) to tell them apart; the repo is in the tooltip.
    const asking=!!this.awaiting?.(s.provider,s.nativeSessionId);
    const item=new vscode.TreeItem([statusGlyph(s.status,asking),sessionLabel(s)].filter(Boolean).join(' '),vscode.TreeItemCollapsibleState.None);item.contextValue=s.status==='running'?'devhubSessionRunning':'devhubSession';
    item.description=sessionNote(s.status);item.iconPath=providerIcon(s.provider);item.tooltip=`${providerLabel(s.provider)} · ${asking?'waiting for approval':s.status}${node.project?" · "+node.project.name:""}\n${s.cwd}\n${s.nativeSessionId}`;item.command={command:'devhub.openChat',title:'Open Chat',arguments:[node]};return item;
  }
}
/**
 * Time is redundant — rows are already sorted newest first. `running`/`done` are redundant too since ⏳/✅ say it,
 * and `imported` is the default (a session found on disk, Dev Hub hasn't run a turn) so printing it
 * is just jargon. The three abnormal states need WORDS: 🔴/⚫/🟡 say "something is wrong" but not
 * what.
 */
const NOTED=new Set(['failed','cancelled','unavailable']);
export function sessionNote(status:string):string|undefined{
  return NOTED.has(status)?status:undefined;
}
/** A name set by hand beats the first prompt. */
export function sessionLabel(s:{title:string;name?:string}):string{
  return s.name||cleanTitle(s.title);
}
/**
 * A `TreeItem` has only ONE `iconPath`, and `label`/`description` do NOT render `$(name)`
 * codicons — only a MarkdownString tooltip does. So the status icon has to be
 * an emoji in the label; in return the brand mark no longer has to give way when something is wrong, as it did before.
 */
const GLYPH:Record<string,string>={running:'\u23F3',done:'\u2705',failed:'\u{1F534}',
  cancelled:'\u26AB',unavailable:'\u{1F7E1}'};
export function statusGlyph(status:string,asking?:boolean){
  // Awaiting approval beats every other state: it is the ONLY row that needs a human hand,
  // and the store still records it as `running`.
  // `imported` has NO glyph: it is a row Dev Hub hasn't run a turn on, and the empty space next to
  // ✅ is exactly what tells it apart from a row that finished.
  return asking?'\u2753':(GLYPH[status]||'');
}
