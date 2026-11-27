export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { groupPortsByProject, parseCwds, parseListen, portOf } from '../../src/devhub/ports/portScanner';

test('lsof -F output is parsed per process, and IPv4+IPv6 on one port counts once',()=>{
  // The same port shows up on two lines when a process binds both address families.
  const out=['p35642','cmain','f33','n*:8003','f34','n*:8003','f35','n[::1]:6003',
             'p612','crapportd','f10','n127.0.0.1:57557','f11','nnope'].join('\n');
  const byPid=parseListen(out);
  assert.deepEqual([...byPid.keys()],[35642,612]);
  assert.deepEqual(byPid.get(35642),{pid:35642,command:'main',ports:[6003,8003]});
  assert.deepEqual(byPid.get(612)!.ports,[57557],'lines without a port are dropped');
});

test('port is read off the tail of every address shape lsof prints',()=>{
  assert.equal(portOf('*:8080'),8080);
  assert.equal(portOf('127.0.0.1:8080'),8080);
  assert.equal(portOf('[::1]:8080'),8080);
  assert.equal(portOf('/tmp/some.sock'),undefined);
  assert.equal(portOf(''),undefined);
});

test('cwd lookup keeps the first cwd per pid',()=>{
  const cwds=parseCwds(['p1','fcwd','n/a','p2','fcwd','n/b'].join('\n'));
  assert.equal(cwds.get(1),'/a');
  assert.equal(cwds.get(2),'/b');
});

test('ports group under the owning project, unknown repos keep their own group, System last',()=>{
  const projects=[{id:'p1',name:'Order',rootPath:'/repos/order'}];
  const procs=[
    {pid:1,command:'main',cwd:'/repos/order/cmd',ports:[8080]},
    {pid:2,command:'node',cwd:'/repos/web',ports:[3000]},
    {pid:3,command:'rapportd',ports:[57557]},
    {pid:4,command:'main',cwd:'/repos/order',ports:[9090]},
    // A cwd inside ~/Library is the app's internal folder: the basename is 'Data', meaningless.
    {pid:5,command:'com.docker.backend',cwd:'/Users/x/Library/Containers/com.docker.docker/Data',ports:[6379]},
  ];
  const groups=groupPortsByProject(procs as any,projects);
  assert.deepEqual(groups.map(g=>g.name),['Order','com.docker.backend','web','System'],
    'projects first, unknown repos in the middle, no cwd last');
  assert.equal(groups[1].procs[0].pid,5,'a process in ~/Library uses its command name as the label');
  assert.equal(groups[0].known,true);
  assert.equal(groups[0].procs.length,2,'two processes of one project go into one group');
  assert.equal(groups[1].known,false,'a repo not added to Dev Hub has known=false');
  assert.equal(groups[2].projectId,undefined);
});

test('pinned ports move to a Pinned group on top and leave their old group',()=>{
  const projects=[{id:'p1',name:'Order',rootPath:'/repos/order'}];
  const procs=[
    {pid:1,command:'main',cwd:'/repos/order/cmd',ports:[5003,8003]},
    {pid:3,command:'rapportd',ports:[57557]},
  ];
  const groups=groupPortsByProject(procs as any,projects,[8003]);
  assert.deepEqual(groups.map(g=>g.name),['Pinned','Order','System'],'Pinned goes first, System stays last');
  assert.deepEqual(groups[0].procs[0].ports,[8003]);
  // The original group comes along so a row in Pinned keeps its project context.
  assert.equal(groups[0].procs[0].group,'Order');
  assert.equal(groups[0].pinned,true);
  assert.deepEqual(groups[1].procs[0].ports,[5003],'a pinned port is no longer in its old group');
  // Pinning every port of a process makes the old group disappear, leaving no empty row.
  const all=groupPortsByProject(procs as any,projects,[5003,8003]);
  assert.deepEqual(all.map(g=>g.name),['Pinned','System']);
  assert.deepEqual(all[0].procs[0].ports,[5003,8003]);
  // With nothing pinned it must be identical to before this feature existed.
  assert.deepEqual(groupPortsByProject(procs as any,projects).map(g=>g.name),['Order','System']);
});

test('two different repos that share a folder name stay two groups',()=>{
  const procs=[{pid:1,command:'node',cwd:'/home/u/a/api',ports:[3000]},
               {pid:2,command:'node',cwd:'/home/u/b/api',ports:[3001]}];
  // Grouping by LABEL puts two servers from different repos in one group and nobody can tell them apart.
  const groups=groupPortsByProject(procs as any,[],[]);
  assert.equal(groups.length,2);
  assert.deepEqual(groups.map(g=>g.name),['api','api']);
});

test('a bot repo is labelled with its agent name, not the folder basename',()=>{
  const agents=[{name:'agent-acme',cwd:'/repos/agent-planner'}];
  const procs=[{pid:1,command:'Python',cwd:'/repos/agent-planner',ports:[7341]},
               {pid:2,command:'node',cwd:'/repos/agent-planner/web',ports:[3000]}];
  const groups=groupPortsByProject(procs as any,[],[],agents);
  // The Agents section calls it 'agent-acme'; the Ports group must use the same name, it is the same process.
  assert.deepEqual(groups.map(g=>g.name),['agent-acme']);
  assert.equal(groups[0].procs.length,2,'child processes in the bot repo join the agent group');
  assert.equal(groups[0].known,false,'an agent is not a Dev Hub project');
  // A registered project still wins: the name in the tree must match the project name.
  const projects=[{id:'p1',name:'Planner',rootPath:'/repos/agent-planner'}];
  assert.deepEqual(groupPortsByProject(procs as any,projects,[],agents).map(g=>g.name),['Planner']);
  // With no agents configured keep the old behaviour.
  assert.deepEqual(groupPortsByProject(procs as any,[],[]).map(g=>g.name),['agent-planner','web']);
});
