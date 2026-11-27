const cp=require('node:child_process');
const util=require('node:util');
const execFile=util.promisify(cp.execFile);

export interface GitChange {path:string;added:number;removed:number;untracked?:boolean;}
/** The DIRTY working tree (vs HEAD) + branch position vs upstream. Not a diff of the whole branch. */
export interface GitStatus {branch?:string;upstream?:string;ahead:number;behind:number;
  files:number;untracked:number;added:number;removed:number;changes:GitChange[];}
export interface GitBranchInfo {branch?:string;upstream?:string;ahead:number;behind:number;untracked:string[];}

/** With tens of thousands of dirty files the list is no longer readable, yet postMessage still has to carry it. */
const MAX_CHANGES=500;

/**
 * `status --porcelain=v2 -b -z`: every record ends in NUL and paths are RAW — no
 * core.quotePath, so non-ASCII names aren't escaped. Trap: a rename record `2 ` swallows
 * ONE more token, the old path; skip it or the old path is read as a separate record.
 */
export function parseBranchStatus(out:string):GitBranchInfo{
  const parts=String(out||'').split('\0');
  const info:GitBranchInfo={ahead:0,behind:0,untracked:[]};
  for(let i=0;i<parts.length;i++){
    const rec=parts[i]; if(!rec)continue;
    if(rec.startsWith('# branch.head '))info.branch=rec.slice(14)||undefined;
    else if(rec.startsWith('# branch.upstream '))info.upstream=rec.slice(18)||undefined;
    else if(rec.startsWith('# branch.ab ')){
      const m=/^\+(\d+) -(\d+)$/.exec(rec.slice(12));
      if(m){info.ahead=Number(m[1]);info.behind=Number(m[2]);}
    }
    else if(rec.startsWith('2 '))i++;
    else if(rec.startsWith('? '))info.untracked.push(rec.slice(2));
  }
  return info;
}

/** `diff --numstat --no-renames -z`: `added\tremoved\tpath\0`. Binary files print `-`. */
export function parseNumstat(out:string):GitChange[]{
  const changes:GitChange[]=[];
  for(const rec of String(out||'').split('\0')){
    if(!rec)continue;
    const a=rec.indexOf('\t'); if(a<0)continue;
    const b=rec.indexOf('\t',a+1); if(b<0)continue;
    const path=rec.slice(b+1); if(!path)continue;
    const added=Number(rec.slice(0,a)),removed=Number(rec.slice(a+1,b));
    changes.push({path,added:Number.isFinite(added)?added:0,removed:Number.isFinite(removed)?removed:0});
  }
  return changes;
}

/**
 * Untracked files count toward the FILE count but not the line count: `git diff HEAD` can't see
 * unadded files, and counting their lines would take one more command per file. The tooltip says so.
 */
export function summarize(info:GitBranchInfo,tracked:GitChange[]):GitStatus{
  let added=0,removed=0; for(const c of tracked){added+=c.added;removed+=c.removed;}
  const changes=tracked.slice().sort((x,y)=>(y.added+y.removed)-(x.added+x.removed));
  for(const p of info.untracked)changes.push({path:p,added:0,removed:0,untracked:true});
  // `files` is taken BEFORE trimming: the number on the chip is the truth, only the list is trimmed.
  return {branch:info.branch,upstream:info.upstream,ahead:info.ahead,behind:info.behind,
    files:changes.length,untracked:info.untracked.length,added,removed,changes:changes.slice(0,MAX_CHANGES)};
}

export type GitRunner=(args:string[])=>Promise<string>;
/** `undefined` = not a git repo (or git couldn't run) — the chip is fully hidden, no "—" drawn. */
export async function readGitStatus(root:string,run?:GitRunner):Promise<GitStatus|undefined>{
  const go:GitRunner=run||(async(args:string[])=>String((await execFile('git',['-C',root,...args],{timeout:3000,maxBuffer:1<<22})).stdout));
  let head:string;
  try{ head=await go(['status','--porcelain=v2','-b','-z']); }catch{ return undefined; }
  const info=parseBranchStatus(head);
  // A repo with no commits makes `diff HEAD` fail; the branch and untracked list are still right.
  let tracked:GitChange[]=[];
  try{ tracked=parseNumstat(await go(['diff','--numstat','--no-renames','-z','HEAD'])); }catch{}
  return summarize(info,tracked);
}
