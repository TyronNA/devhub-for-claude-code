const test=require('node:test');
const assert=require('node:assert/strict');
import { buildTreeModel } from '../../src/devhub/views/treeModel';

test('tree model groups workspace project and running sessions first',()=>{
  const ws:any=[{id:'w',name:'Game'}]; const projects:any=[{id:'p',workspaceId:'w',name:'repo',rootPath:'/repo'}];
  const sessions:any=[
    {provider:'claude',nativeSessionId:'old',workspaceId:'w',projectId:'p',title:'old',status:'done',updatedAt:30},
    {provider:'codex',nativeSessionId:'run',workspaceId:'w',projectId:'p',title:'run',status:'running',updatedAt:10}
  ];
  const tree=buildTreeModel(ws,projects,sessions);assert.equal(tree[0].runningCount,1);assert.equal(tree[0].projects[0].sessions[0].nativeSessionId,'run');
});
