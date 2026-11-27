const path = require('node:path');
const crypto = require('node:crypto');
import { DevHubProject, DevHubWorkspace } from '../types';
import { normalizeProjectPath, readJson, writeJsonAtomic } from './jsonStore';

interface WorkspaceStoreFile { version:1; workspaces:DevHubWorkspace[]; projects:DevHubProject[]; }
const empty = ():WorkspaceStoreFile => ({version:1, workspaces:[], projects:[]});

export class WorkspaceStore {
  private file:string;
  private data:WorkspaceStoreFile|undefined;
  private loading:Promise<WorkspaceStoreFile>|undefined;
  constructor(private storageDir:string){ this.file = path.join(storageDir, 'devhub', 'workspaces.json'); }
  private async load(){
    if(this.data) return this.data;
    if(!this.loading){
      this.loading=readJson<WorkspaceStoreFile>(this.file, empty()).then(data=>{
        this.data=data;this.loading=undefined;return data;
      },err=>{this.loading=undefined;throw err;});
    }
    return this.loading;
  }
  private async save(data:WorkspaceStoreFile){ this.data=data; await writeJsonAtomic(this.file, data); }
  /**
   * Every write goes through one queue, just like `SessionStore`/`QueueStore`. Without it two parallel commands
   * both await `normalizeProjectPath` (a disk read) between the check and the push —
   * enough for two projects with the same path to slip through the dedupe, and for two `writeJsonAtomic`s to clobber each other.
   */
  private chain:Promise<any>=Promise.resolve();
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{ const next=this.chain.then(fn,fn); this.chain=next.then(()=>undefined,()=>undefined); return next; }
  async snapshot(){ const data=await this.load(); return {version:1 as const,workspaces:[...data.workspaces],projects:[...data.projects]}; }
  async createWorkspace(name:string){ return this.exclusive(async()=>{
    const trimmed = name.trim(); if (!trimmed) throw new Error('Workspace name is required');
    const data = await this.load(); const now = Date.now();
    const workspace:DevHubWorkspace = {id:crypto.randomUUID(), name:trimmed, createdAt:now, updatedAt:now};
    data.workspaces.push(workspace); await this.save(data); return workspace;
  }); }
  async renameWorkspace(id:string, name:string){ return this.exclusive(async()=>{
    const trimmed=name.trim(); if(!trimmed) throw new Error('Workspace name is required');
    const data=await this.load(); const ws=data.workspaces.find(w=>w.id===id); if(!ws) throw new Error('Workspace not found');
    ws.name=trimmed; ws.updatedAt=Date.now(); await this.save(data); return ws;
  }); }
  async addProject(workspaceId:string, input:{name:string;rootPath:string;gitRoot?:string}){ return this.exclusive(async()=>{
    const data=await this.load(); if(!data.workspaces.some(w=>w.id===workspaceId)) throw new Error('Workspace not found');
    const normalized = await normalizeProjectPath(input.rootPath);
    for (const p of data.projects.filter(p=>p.workspaceId===workspaceId)) {
      if ((await normalizeProjectPath(p.rootPath)).key === normalized.key) throw new Error('Project already exists in workspace');
    }
    const now=Date.now(); const project:DevHubProject={id:crypto.randomUUID(),workspaceId,name:input.name || path.basename(normalized.display),rootPath:normalized.display,gitRoot:input.gitRoot,createdAt:now,updatedAt:now};
    data.projects.push(project); await this.save(data); return project;
  }); }
  async moveProject(rootPath:string, targetWorkspaceId:string){ return this.exclusive(async()=>{
    const data=await this.load(); if(!data.workspaces.some(w=>w.id===targetWorkspaceId)) throw new Error('Workspace not found');
    const key=(await normalizeProjectPath(rootPath)).key; let found:DevHubProject|undefined;
    for(const p of data.projects){ if((await normalizeProjectPath(p.rootPath)).key===key){ found=p; break; } }
    if(!found) throw new Error('Project not found'); found.workspaceId=targetWorkspaceId; found.updatedAt=Date.now(); await this.save(data); return found;
  }); }
  async removeProject(id:string){ return this.exclusive(async()=>{ const data=await this.load(); data.projects=data.projects.filter(p=>p.id!==id); await this.save(data); }); }
  async removeWorkspace(id:string){ return this.exclusive(async()=>{ const data=await this.load(); data.workspaces=data.workspaces.filter(w=>w.id!==id); data.projects=data.projects.filter(p=>p.workspaceId!==id); await this.save(data); }); }
}
