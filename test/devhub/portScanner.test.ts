export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { groupPortsByProject, parseCwds, parseListen, portOf } from '../../src/devhub/ports/portScanner';

test('lsof -F output is parsed per process, and IPv4+IPv6 on one port counts once',()=>{
  // Cùng một cổng xuất hiện hai dòng khi process bind cả hai họ địa chỉ.
  const out=['p35642','cmain','f33','n*:8003','f34','n*:8003','f35','n[::1]:6003',
             'p612','crapportd','f10','n127.0.0.1:57557','f11','nnope'].join('\n');
  const byPid=parseListen(out);
  assert.deepEqual([...byPid.keys()],[35642,612]);
  assert.deepEqual(byPid.get(35642),{pid:35642,command:'main',ports:[6003,8003]});
  assert.deepEqual(byPid.get(612)!.ports,[57557],'dòng không có cổng bị bỏ');
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
    // cwd trong ~/Library là thư mục nội bộ của app: basename ra 'Data', vô nghĩa.
    {pid:5,command:'com.docker.backend',cwd:'/Users/x/Library/Containers/com.docker.docker/Data',ports:[6379]},
  ];
  const groups=groupPortsByProject(procs as any,projects);
  assert.deepEqual(groups.map(g=>g.name),['Order','com.docker.backend','web','System'],
    'project trước, repo lạ giữa, không cwd xuống cuối');
  assert.equal(groups[1].procs[0].pid,5,'process trong ~/Library lấy tên lệnh làm nhãn');
  assert.equal(groups[0].known,true);
  assert.equal(groups[0].procs.length,2,'hai process cùng project vào một group');
  assert.equal(groups[1].known,false,'repo chưa add vào Dev Hub thì known=false');
  assert.equal(groups[2].projectId,undefined);
});

test('pinned ports move to a Pinned group on top and leave their old group',()=>{
  const projects=[{id:'p1',name:'Order',rootPath:'/repos/order'}];
  const procs=[
    {pid:1,command:'main',cwd:'/repos/order/cmd',ports:[5003,8003]},
    {pid:3,command:'rapportd',ports:[57557]},
  ];
  const groups=groupPortsByProject(procs as any,projects,[8003]);
  assert.deepEqual(groups.map(g=>g.name),['Pinned','Order','System'],'Pinned lên đầu, System vẫn cuối');
  assert.deepEqual(groups[0].procs[0].ports,[8003]);
  // Group gốc đi kèm để hàng trong Pinned không mất ngữ cảnh project.
  assert.equal(groups[0].procs[0].group,'Order');
  assert.equal(groups[0].pinned,true);
  assert.deepEqual(groups[1].procs[0].ports,[5003],'cổng đã ghim không còn nằm ở group cũ');
  // Ghim hết cổng của một process thì group cũ biến mất, không để lại hàng rỗng.
  const all=groupPortsByProject(procs as any,projects,[5003,8003]);
  assert.deepEqual(all.map(g=>g.name),['Pinned','System']);
  assert.deepEqual(all[0].procs[0].ports,[5003,8003]);
  // Không ghim gì thì phải giống hệt trước khi có tính năng này.
  assert.deepEqual(groupPortsByProject(procs as any,projects).map(g=>g.name),['Order','System']);
});

test('two different repos that share a folder name stay two groups',()=>{
  const procs=[{pid:1,command:'node',cwd:'/home/u/a/api',ports:[3000]},
               {pid:2,command:'node',cwd:'/home/u/b/api',ports:[3001]}];
  // Gộp theo NHÃN thì hai server khác repo nằm chung một nhóm và không ai phân biệt được.
  const groups=groupPortsByProject(procs as any,[],[]);
  assert.equal(groups.length,2);
  assert.deepEqual(groups.map(g=>g.name),['api','api']);
});

test('a bot repo is labelled with its agent name, not the folder basename',()=>{
  const agents=[{name:'agent-acme',cwd:'/repos/agent-planner'}];
  const procs=[{pid:1,command:'Python',cwd:'/repos/agent-planner',ports:[7341]},
               {pid:2,command:'node',cwd:'/repos/agent-planner/web',ports:[3000]}];
  const groups=groupPortsByProject(procs as any,[],[],agents);
  // Mục Agents gọi nó là 'agent-acme'; nhóm Ports phải gọi y hệt, cùng một process.
  assert.deepEqual(groups.map(g=>g.name),['agent-acme']);
  assert.equal(groups[0].procs.length,2,'process con trong repo bot vào chung nhóm agent');
  assert.equal(groups[0].known,false,'agent không phải project của Dev Hub');
  // Project đã đăng ký vẫn thắng: tên trong cây phải khớp tên project.
  const projects=[{id:'p1',name:'Planner',rootPath:'/repos/agent-planner'}];
  assert.deepEqual(groupPortsByProject(procs as any,projects,[],agents).map(g=>g.name),['Planner']);
  // Không cấu hình agent thì giữ nguyên hành vi cũ.
  assert.deepEqual(groupPortsByProject(procs as any,[],[]).map(g=>g.name),['agent-planner','web']);
});
