import { WorkspaceStore } from '../storage/workspaceStore';
import { ProjectResolver } from './projectResolver';
export class WorkspaceService {
  constructor(private store:WorkspaceStore,private resolver:ProjectResolver){}
  snapshot(){return this.store.snapshot();}
  createWorkspace(name:string){return this.store.createWorkspace(name);}
  renameWorkspace(id:string,name:string){return this.store.renameWorkspace(id,name);}
  removeProject(id:string){return this.store.removeProject(id);}
  async addProjects(workspaceId:string,paths:string[]){const out=[];for(const p of paths){const r=await this.resolver.resolve(p);out.push(await this.store.addProject(workspaceId,r));}return out;}
}
