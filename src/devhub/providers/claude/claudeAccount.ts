const fs=require('fs');const os=require('os');const nodePath=require('path');
/**
 * Claude account per project: the file `devHub.claude.altAccountFile`, one root folder per line that runs
 * on the second account; the wrapper in `devHub.claude.executable` reads the SAME file against `pwd -P` at spawn. Dev Hub
 * never picks an account itself — it only edits the file, so a single source decides, terminals included.
 * Compared by realpath because the wrapper uses `pwd -P`: a path through a symlink would differ as text.
 */
export function expandHome(p:string){return p==='~'?os.homedir():p.startsWith('~/')?nodePath.join(os.homedir(),p.slice(2)):p;}
function real(p:string){try{return fs.realpathSync(p);}catch{return nodePath.resolve(p);}}
export function readAltRoots(file:string):string[]{
  let text='';try{text=fs.readFileSync(expandHome(file),'utf8');}catch{return [];}
  return text.split('\n').map((l:string)=>l.trim()).filter((l:string)=>l&&!l.startsWith('#')).map((l:string)=>real(expandHome(l)));
}
const under=(path:string,root:string)=>path===root||path.startsWith(root.endsWith('/')?root:root+'/');
/** Which line covers `cwd` — `undefined` = the default account. */
export function altRootFor(file:string,cwd:string){const p=real(cwd);return readAltRoots(file).find(r=>under(p,r));}
export function isUnder(path:string,root:string){return under(real(path),real(root));}
/**
 * Toggle the second account for `root`. Turning it off can only remove its own line: a project under a parent line
 * (e.g. all of `~/work/acme`) still runs on the second account after removing the child line — return `inherited` to say so, without touching the parent.
 * Write tmp + rename: the wrapper reads the file on every spawn and must never see a half-written file.
 */
export function toggleAltRoot(file:string,root:string):{alt:boolean;inherited?:string}{
  const path=expandHome(file);const target=real(root);
  let lines:string[]=[];try{lines=fs.readFileSync(path,'utf8').split('\n');}catch{}
  const own=(l:string)=>{const t=l.trim();return !!t&&!t.startsWith('#')&&real(expandHome(t))===target;};
  let alt:boolean;
  if(lines.some(own)){lines=lines.filter(l=>!own(l));alt=false;}
  else{
    const parent=readAltRoots(file).find(r=>under(target,r));if(parent)return {alt:true,inherited:parent};
    while(lines.length&&!lines[lines.length-1].trim())lines.pop();lines.push(target);alt=true;}
  fs.mkdirSync(nodePath.dirname(path),{recursive:true});
  const tmp=`${path}.${process.pid}.tmp`;fs.writeFileSync(tmp,lines.join('\n').replace(/\n*$/,'\n'));fs.renameSync(tmp,path);
  const inherited=alt?undefined:readAltRoots(file).find(r=>under(target,r));
  return inherited?{alt:true,inherited}:{alt};
}
