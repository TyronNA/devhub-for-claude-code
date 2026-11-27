const fs=require('fs');const os=require('os');const nodePath=require('path');
/**
 * Acc Claude theo project: file `devHub.claude.altAccountFile`, mỗi dòng một thư mục gốc chạy
 * acc phụ; wrapper ở `devHub.claude.executable` đọc CÙNG file đó theo `pwd -P` lúc spawn. Dev Hub
 * không tự chọn acc — nó chỉ sửa file, nên một nguồn duy nhất quyết định, kể cả cho terminal.
 * So bằng realpath vì wrapper dùng `pwd -P`: path qua symlink sẽ lệch nếu so chữ.
 */
export function expandHome(p:string){return p==='~'?os.homedir():p.startsWith('~/')?nodePath.join(os.homedir(),p.slice(2)):p;}
function real(p:string){try{return fs.realpathSync(p);}catch{return nodePath.resolve(p);}}
export function readAltRoots(file:string):string[]{
  let text='';try{text=fs.readFileSync(expandHome(file),'utf8');}catch{return [];}
  return text.split('\n').map((l:string)=>l.trim()).filter((l:string)=>l&&!l.startsWith('#')).map((l:string)=>real(expandHome(l)));
}
const under=(path:string,root:string)=>path===root||path.startsWith(root.endsWith('/')?root:root+'/');
/** Dòng nào đang phủ `cwd` — `undefined` = acc mặc định. */
export function altRootFor(file:string,cwd:string){const p=real(cwd);return readAltRoots(file).find(r=>under(p,r));}
export function isUnder(path:string,root:string){return under(real(path),real(root));}
/**
 * Bật/tắt acc phụ cho `root`. Tắt chỉ gỡ được dòng của chính nó: project nằm dưới một dòng cha
 * (vd cả `~/work/acme`) thì gỡ dòng con vẫn chạy acc phụ — trả `inherited` để báo, không đụng dòng cha.
 * Ghi tmp + rename: wrapper đọc file mỗi lần spawn, không được thấy file ghi dở.
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
