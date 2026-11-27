import { plannerSessionId, DEFAULT_PLANNER_ENDPOINT } from '../sessions/plannerIdentity';
export { DEFAULT_PLANNER_ENDPOINT } from '../sessions/plannerIdentity';
import { PlannerTask } from '../providers/planner/plannerClient';
import { DevHubProject, DevHubSession } from '../types';
import { AgentSpec } from './agentRunner';

/** A conversation stable per agent name; the internal ID also contains the daemon's endpoint. */
export function plannerChatId(spec:AgentSpec){return `chat:${spec.name}`;}

/** The daemon is working on the task — not a Dev Hub chat turn. */
const RUNNING=new Set(['ANALYZING','REANALYZING','IMPLEMENTING','VERIFYING']);
const BAD=new Set(['FAILED','BLOCKED','RECOVERY_REQUIRED']);

export interface TaskRow { label:string; description?:string; icon:string; color?:string; contextValue:string; }

/**
 * The daemon's 12 states do NOT map onto `SessionStatus` — only two share a name and
 * their meanings already differ. Keep the daemon's string in the description; icons collapse into 5 groups.
 */
export function taskRow(task:PlannerTask):TaskRow{
  const status=String(task.status||'');
  const bits=[status];
  if(task.plan_version)bits.push(`v${task.plan_version}`);
  if(typeof task.confidence==='number')bits.push(task.confidence.toFixed(2));
  let icon='circle-outline',color:string|undefined='disabledForeground';
  if(RUNNING.has(status)){icon='loading~spin';color='charts.green';}
  else if(status==='WAITING_APPROVAL'){icon='bell';color='charts.yellow';}
  else if(status==='APPROVED'){icon='check';color='charts.blue';}
  else if(status==='DONE'){icon='pass-filled';color='charts.green';}
  else if(status==='DISMISSED'){icon='circle-slash';color='disabledForeground';}
  else if(status==='STALE'){icon='warning';color='charts.yellow';}
  else if(BAD.has(status)){icon='error';color='errorForeground';}
  // contextValue decides which menu shows: Approve only on WAITING_APPROVAL, Execute only on APPROVED.
  // Stop needs a REAL exec run: ANALYZING/REANALYZING are the scheduler's brain turns, with no
  // `current_run_id` to stop — showing Stop there promises something that doesn't exist.
  // Dismissed has its OWN menu (Revive only): it is terminal, every other action is meaningless
  // and dismissing again makes the daemon return 409.
  const suffix=status==='DISMISSED'?'Dismissed'
    :status==='WAITING_APPROVAL'?'Waiting':status==='APPROVED'?'Approved'
    :RUNNING.has(status)&&task.current_run_id?'Running':'';
  return {label:task.jira_key,description:bits.join(' · '),icon,color,contextValue:`devhubPlannerTask${suffix}`};
}

/** Daemon epoch seconds -> ms. */
function ms(v:any){const n=Number(v);return Number.isFinite(n)&&n>0?Math.round(n*1000):0;}

/** A Dev Hub project matched by the bot's repo path; without one the session still opens. */
function homeOf(spec:AgentSpec,projects:DevHubProject[]){
  return projects.find(p=>p.rootPath===spec.cwd);
}

/**
 * Task -> session to open a tab. The internal ID contains the endpoint; the provider strips the original
 * `conversation_id` before sending to the daemon, so the same ticket on two daemons doesn't share a tab.
 *
 * `status` is always `imported`: the task's REAL state lives in the daemon and the tree draws it from `/tasks`.
 * Writing `running` to the store would make the status bar count it and `recoverStaleSessions()` mangle it on open.
 */
export function taskSession(spec:AgentSpec,task:PlannerTask,projects:DevHubProject[]):DevHubSession{
  const home=homeOf(spec,projects);
  const summary=task.summary?` — ${task.summary}`:'';
  return {provider:'planner',nativeSessionId:plannerSessionId(endpointOf(spec),`task:${task.jira_key}`),plannerEndpoint:endpointOf(spec),
    workspaceId:home?.workspaceId??'',projectId:home?.id??'',cwd:spec.cwd,
    title:`${task.jira_key} · ${task.status}${summary}`,status:'imported',
    createdAt:ms(task.created_at)||Date.now(),updatedAt:ms(task.updated_at)||Date.now()};
}

export function chatSession(spec:AgentSpec,projects:DevHubProject[]):DevHubSession{
  const home=homeOf(spec,projects);
  return {provider:'planner',nativeSessionId:plannerSessionId(endpointOf(spec),plannerChatId(spec)),plannerEndpoint:endpointOf(spec),
    workspaceId:home?.workspaceId??'',projectId:home?.id??'',cwd:spec.cwd,
    title:`Ask ${spec.name}`,status:'imported',createdAt:0,updatedAt:0};
}

/** Inbox ordered by how much it needs a human: awaiting approval -> running -> failed -> the rest. */
export function sortTasks(tasks:PlannerTask[]):PlannerTask[]{
  const rank=(t:PlannerTask)=>t.status==='WAITING_APPROVAL'?0:RUNNING.has(t.status)?1:BAD.has(t.status)?2:t.status==='APPROVED'?3:4;
  return [...tasks].sort((a,b)=>rank(a)-rank(b)||ms(b.updated_at)-ms(a.updated_at));
}

export function endpointOf(spec:AgentSpec){return spec.endpoint||DEFAULT_PLANNER_ENDPOINT;}
export function isHttpAgent(spec:AgentSpec){return spec.kind==='http';}
