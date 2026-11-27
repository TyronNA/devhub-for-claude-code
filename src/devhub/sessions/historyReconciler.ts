import { DevHubSession } from '../types';

function key(session:Pick<DevHubSession,'provider'|'nativeSessionId'>){
  return `${session.provider}\u0000${session.nativeSessionId}`;
}

export function reconcileImportedSessions(existing:DevHubSession[], imported:DevHubSession[]):DevHubSession[]{
  const current=new Map(existing.map(s=>[key(s),s] as const));
  const changes:DevHubSession[]=[];
  for(const discovered of imported){
    const old=current.get(key(discovered));
    if(!old){changes.push(discovered);continue;}
    if(old.status!=='imported'&&old.status!=='unavailable') continue;
    const next:DevHubSession={
      ...discovered,
      title:old.title || discovered.title,
      status:'imported',
      createdAt:Math.min(old.createdAt,discovered.createdAt),
      updatedAt:Math.max(old.updatedAt,discovered.updatedAt),
      usage:old.usage ?? discovered.usage,
    };
    const changed=next.updatedAt!==old.updatedAt || old.status!=='imported' || next.workspaceId!==old.workspaceId || next.projectId!==old.projectId || next.cwd!==old.cwd;
    if(changed) changes.push(next);
  }
  return changes;
}
