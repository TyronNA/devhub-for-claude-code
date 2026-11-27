const cp=require('node:child_process');
const util=require('node:util');
const execFile=util.promisify(cp.execFile);

export interface GitChange {path:string;added:number;removed:number;untracked?:boolean;}
/** Cây làm việc BẨN (so với HEAD) + vị trí branch so với upstream. Không phải diff cả branch. */
export interface GitStatus {branch?:string;upstream?:string;ahead:number;behind:number;
  files:number;untracked:number;added:number;removed:number;changes:GitChange[];}
export interface GitBranchInfo {branch?:string;upstream?:string;ahead:number;behind:number;untracked:string[];}

/** Cây bẩn cả chục nghìn file thì danh sách không còn để đọc, mà postMessage vẫn phải cõng. */
const MAX_CHANGES=500;

/**
 * `status --porcelain=v2 -b -z`: mỗi bản ghi kết bằng NUL và path để TRẦN — không có
 * core.quotePath nên tên tiếng Việt không bị escape. Bẫy: bản ghi rename `2 ` nuốt thêm
 * MỘT token nữa là path cũ; không bỏ qua nó thì path cũ bị đọc thành một bản ghi riêng.
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

/** `diff --numstat --no-renames -z`: `added\tremoved\tpath\0`. File nhị phân in ra `-`. */
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
 * Untracked được đếm vào SỐ FILE nhưng không vào số dòng: `git diff HEAD` không nhìn thấy
 * file chưa add, đếm dòng cho nó phải chạy thêm một lệnh mỗi file. Tooltip nói rõ chuyện này.
 */
export function summarize(info:GitBranchInfo,tracked:GitChange[]):GitStatus{
  let added=0,removed=0; for(const c of tracked){added+=c.added;removed+=c.removed;}
  const changes=tracked.slice().sort((x,y)=>(y.added+y.removed)-(x.added+x.removed));
  for(const p of info.untracked)changes.push({path:p,added:0,removed:0,untracked:true});
  // `files` lấy TRƯỚC khi cắt: con số trên chip là sự thật, danh sách mới là thứ bị cắt.
  return {branch:info.branch,upstream:info.upstream,ahead:info.ahead,behind:info.behind,
    files:changes.length,untracked:info.untracked.length,added,removed,changes:changes.slice(0,MAX_CHANGES)};
}

export type GitRunner=(args:string[])=>Promise<string>;
/** `undefined` = không phải repo git (hoặc git không chạy được) — chip ẩn hẳn, không vẽ "—". */
export async function readGitStatus(root:string,run?:GitRunner):Promise<GitStatus|undefined>{
  const go:GitRunner=run||(async(args:string[])=>String((await execFile('git',['-C',root,...args],{timeout:3000,maxBuffer:1<<22})).stdout));
  let head:string;
  try{ head=await go(['status','--porcelain=v2','-b','-z']); }catch{ return undefined; }
  const info=parseBranchStatus(head);
  // Repo chưa có commit nào thì `diff HEAD` lỗi; branch và danh sách untracked vẫn đúng.
  let tracked:GitChange[]=[];
  try{ tracked=parseNumstat(await go(['diff','--numstat','--no-renames','-z','HEAD'])); }catch{}
  return summarize(info,tracked);
}
