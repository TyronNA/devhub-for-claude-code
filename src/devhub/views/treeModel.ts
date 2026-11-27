import { DevHubProject, DevHubSession, DevHubWorkspace } from '../types';
export interface TreeProject { project:DevHubProject; sessions:DevHubSession[]; }
export interface TreeWorkspace { workspace:DevHubWorkspace; projects:TreeProject[]; runningCount:number; }

export function buildTreeModel(workspaces:DevHubWorkspace[],projects:DevHubProject[],sessions:DevHubSession[]):TreeWorkspace[]{
  const sessionsByProject=new Map<string,DevHubSession[]>();
  for(const session of sessions){
    let bucket=sessionsByProject.get(session.projectId);
    if(!bucket){bucket=[];sessionsByProject.set(session.projectId,bucket);}
    bucket.push(session);
  }
  for(const bucket of sessionsByProject.values()){
    bucket.sort((a,b)=>{
      const ar=a.status==='running'?1:0,br=b.status==='running'?1:0;
      return br-ar||b.updatedAt-a.updatedAt;
    });
  }

  const projectsByWorkspace=new Map<string,TreeProject[]>();
  for(const project of projects){
    let bucket=projectsByWorkspace.get(project.workspaceId);
    if(!bucket){bucket=[];projectsByWorkspace.set(project.workspaceId,bucket);}
    bucket.push({project,sessions:sessionsByProject.get(project.id) ?? []});
  }

  return workspaces.map(workspace=>{
    const ps=projectsByWorkspace.get(workspace.id) ?? [];
    let runningCount=0;
    for(const p of ps) for(const s of p.sessions) if(s.status==='running') runningCount++;
    return {workspace,projects:ps,runningCount};
  });
}

/** Session mới nhất trên toàn bộ workspace — đang chạy lên trước, rồi theo updatedAt. */
export function recentSessions(sessions:DevHubSession[],limit=10):DevHubSession[]{
  return [...sessions].sort((a,b)=>{
    const ar=a.status==='running'?1:0,br=b.status==='running'?1:0;
    return br-ar||b.updatedAt-a.updatedAt;
  }).slice(0,limit);
}
