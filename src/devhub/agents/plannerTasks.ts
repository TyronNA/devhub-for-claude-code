import { plannerSessionId, DEFAULT_PLANNER_ENDPOINT } from '../sessions/plannerIdentity';
export { DEFAULT_PLANNER_ENDPOINT } from '../sessions/plannerIdentity';
import { PlannerTask } from '../providers/planner/plannerClient';
import { DevHubProject, DevHubSession } from '../types';
import { AgentSpec } from './agentRunner';

/** Conversation ổn định theo tên agent; ID nội bộ còn chứa endpoint của daemon. */
export function plannerChatId(spec:AgentSpec){return `chat:${spec.name}`;}

/** Daemon đang làm việc trên task — không phải lượt chat của DevHub. */
const RUNNING=new Set(['ANALYZING','REANALYZING','IMPLEMENTING','VERIFYING']);
const BAD=new Set(['FAILED','BLOCKED','RECOVERY_REQUIRED']);

export interface TaskRow { label:string; description?:string; icon:string; color?:string; contextValue:string; }

/**
 * 12 trạng thái của daemon KHÔNG ánh xạ vào `SessionStatus` — chỉ hai cái trùng tên và
 * nghĩa đã khác. Giữ nguyên chuỗi của daemon ở description, còn icon gom về 5 nhóm.
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
  // contextValue quyết định menu nào hiện: Approve chỉ ở WAITING_APPROVAL, Execute chỉ ở APPROVED.
  // Stop cần một exec run THẬT: ANALYZING/REANALYZING là brain turn của scheduler, không có
  // `current_run_id` nào để dừng — hiện menu Stop ở đó là hứa một thứ không tồn tại.
  // Dismissed có menu RIÊNG (chỉ Revive): nó là terminal, mọi hành động khác đều vô nghĩa
  // và Dismiss lần nữa thì daemon trả 409.
  const suffix=status==='DISMISSED'?'Dismissed'
    :status==='WAITING_APPROVAL'?'Waiting':status==='APPROVED'?'Approved'
    :RUNNING.has(status)&&task.current_run_id?'Running':'';
  return {label:task.jira_key,description:bits.join(' · '),icon,color,contextValue:`devhubPlannerTask${suffix}`};
}

/** epoch giây của daemon -> ms. */
function ms(v:any){const n=Number(v);return Number.isFinite(n)&&n>0?Math.round(n*1000):0;}

/** Project của DevHub khớp theo đường dẫn repo bot; không có thì session vẫn mở được. */
function homeOf(spec:AgentSpec,projects:DevHubProject[]){
  return projects.find(p=>p.rootPath===spec.cwd);
}

/**
 * Task -> session để mở tab. ID nội bộ chứa endpoint; provider tách `conversation_id` gốc
 * trước khi gửi daemon, nên cùng ticket ở hai daemon không dùng chung tab.
 *
 * `status` luôn là `imported`: trạng thái THẬT của task nằm ở daemon và cây vẽ nó từ `/tasks`.
 * Ghi `running` vào store sẽ khiến statusbar đếm nó và `recoverStaleSessions()` sửa bậy lúc mở.
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

/** Inbox lên trước theo mức cần người: chờ duyệt -> đang chạy -> hỏng -> còn lại. */
export function sortTasks(tasks:PlannerTask[]):PlannerTask[]{
  const rank=(t:PlannerTask)=>t.status==='WAITING_APPROVAL'?0:RUNNING.has(t.status)?1:BAD.has(t.status)?2:t.status==='APPROVED'?3:4;
  return [...tasks].sort((a,b)=>rank(a)-rank(b)||ms(b.updated_at)-ms(a.updated_at));
}

export function endpointOf(spec:AgentSpec){return spec.endpoint||DEFAULT_PLANNER_ENDPOINT;}
export function isHttpAgent(spec:AgentSpec){return spec.kind==='http';}
