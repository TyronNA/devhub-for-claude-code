import { plannerConversationId } from '../../src/devhub/sessions/plannerIdentity';
export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { chatSession, endpointOf, isHttpAgent, plannerChatId, sortTasks, taskRow, taskSession } from '../../src/devhub/agents/plannerTasks';
import { normalizeAgents } from '../../src/devhub/agents/agentRunner';

const spec={name:'my-planner',cwd:'/tmp/my-planner',kind:'http' as const};
const projects=[{id:'p1',workspaceId:'w1',name:'my-planner',rootPath:'/tmp/my-planner',createdAt:0,updatedAt:0}];

test('a task row keeps the daemon status verbatim and adds version + confidence',()=>{
  const row=taskRow({jira_key:'ABC-1',status:'WAITING_APPROVAL',plan_version:2,confidence:0.815});
  assert.equal(row.label,'ABC-1');
  assert.equal(row.description,'WAITING_APPROVAL · v2 · 0.81');
  assert.equal(row.contextValue,'devhubPlannerTaskWaiting');
  assert.equal(row.icon,'bell');
});

test('only the states that need a human get their own context value',()=>{
  // The Approve/Execute/Stop menus hang off this; other states must fall back to a plain row.
  assert.equal(taskRow({jira_key:'A-1',status:'APPROVED'}).contextValue,'devhubPlannerTaskApproved');
  // Stop only means something with a real exec run; ANALYZING is the scheduler's brain turn and can't be stopped.
  assert.equal(taskRow({jira_key:'A-1',status:'IMPLEMENTING',current_run_id:7}).contextValue,'devhubPlannerTaskRunning');
  assert.equal(taskRow({jira_key:'A-1',status:'IMPLEMENTING'}).contextValue,'devhubPlannerTask');
  assert.equal(taskRow({jira_key:'A-1',status:'ANALYZING'}).contextValue,'devhubPlannerTask');
  assert.equal(taskRow({jira_key:'A-1',status:'DONE'}).contextValue,'devhubPlannerTask');
  assert.equal(taskRow({jira_key:'A-1',status:'DISCOVERED'}).contextValue,'devhubPlannerTask');
});

test('a working task spins, a broken one goes red',()=>{
  for(const s of ['ANALYZING','REANALYZING','IMPLEMENTING','VERIFYING'])
    assert.equal(taskRow({jira_key:'A-1',status:s}).icon,'loading~spin',s);
  for(const s of ['FAILED','BLOCKED','RECOVERY_REQUIRED'])
    assert.equal(taskRow({jira_key:'A-1',status:s}).icon,'error',s);
});

test('a task session is a conversation id the daemon already understands',()=>{
  const s=taskSession(spec,{jira_key:'ABC-1',status:'ANALYZING',summary:'fix it',updated_at:1_700_000_000},projects);
  assert.equal(s.provider,'planner');
  assert.equal(plannerConversationId(s.nativeSessionId),'task:ABC-1');
  assert.equal(s.title,'ABC-1 · ANALYZING — fix it');
  assert.equal(s.projectId,'p1');
  assert.equal(s.cwd,'/tmp/my-planner');
  assert.equal(s.updatedAt,1_700_000_000_000,'the daemon\'s epoch seconds must be converted to ms');
});

test('a running task is still stored as imported',()=>{
  // `running` in the store makes the status bar count it and recoverStaleSessions() wrongly fix it on open —
  // the real state lives in the daemon, the tree reads it from /tasks.
  assert.equal(taskSession(spec,{jira_key:'A-1',status:'IMPLEMENTING'},projects).status,'imported');
});

test('a task opens even when the bot repo is not a Dev Hub project',()=>{
  const s=taskSession(spec,{jira_key:'A-1',status:'DONE'},[]);
  assert.equal(s.projectId,'');assert.equal(s.workspaceId,'');
});

test('the free-chat row reuses one conversation id so the daemon keeps its cache',()=>{
  assert.equal(plannerConversationId(chatSession(spec,projects).nativeSessionId),plannerChatId(spec));
  assert.equal(plannerConversationId(chatSession(spec,projects).nativeSessionId),'chat:my-planner');
  assert.equal(chatSession(spec,projects).title,'Ask my-planner');
});

test('two http agents get two conversation ids, not one shared row',()=>{
  // The store key is provider + nativeSessionId: a shared id lets the second daemon's row
  // overwrite the first daemon's `plannerEndpoint`.
  const other={name:'other-planner',cwd:'/tmp/other',kind:'http' as const,endpoint:'http://127.0.0.1:9'};
  const a=chatSession(spec,projects),b=chatSession(other,projects);
  assert.notEqual(a.nativeSessionId,b.nativeSessionId);
  assert.equal(b.plannerEndpoint,'http://127.0.0.1:9');
});

test('the inbox sorts by what needs a human first',()=>{
  const order=sortTasks([
    {jira_key:'D',status:'DONE'},{jira_key:'R',status:'IMPLEMENTING'},
    {jira_key:'W',status:'WAITING_APPROVAL'},{jira_key:'F',status:'FAILED'},
    {jira_key:'A',status:'APPROVED'}]).map(t=>t.jira_key);
  assert.deepEqual(order,['W','R','F','A','D']);
});

test('kind and endpoint survive the settings normalizer',()=>{
  const [a]=normalizeAgents([{name:'my-planner',cwd:'~/x',kind:'http',endpoint:'http://127.0.0.1:9000'}]);
  assert.equal(isHttpAgent(a),true);
  assert.equal(endpointOf(a),'http://127.0.0.1:9000');
  const [b]=normalizeAgents([{name:'other',cwd:'~/x'}]);
  assert.equal(isHttpAgent(b),false);
  assert.equal(endpointOf(b),'http://127.0.0.1:7341','no endpoint declared falls back to the default port');
});
