const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const util = require('node:util');
const execFile = util.promisify(cp.execFile);
export class ProjectResolver {
  async resolve(input:string):Promise<{name:string;rootPath:string;gitRoot?:string}>{
    let selected:string;
    try { selected=await fs.realpath(path.resolve(input)); } catch { throw new Error(`Folder does not exist: ${input}`); }
    const stat=await fs.stat(selected); if(!stat.isDirectory()) throw new Error(`Not a folder: ${input}`);
    try {
      const result=await execFile('git',['-C',selected,'rev-parse','--show-toplevel'],{timeout:3000});
      const gitRoot=await fs.realpath(String(result.stdout).trim());
      return {name:path.basename(gitRoot),rootPath:gitRoot,gitRoot};
    } catch { return {name:path.basename(selected),rootPath:selected}; }
  }
}
