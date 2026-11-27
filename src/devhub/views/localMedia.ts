const nodePath=require('node:path');
const os=require('node:os');
const fsSync=require('node:fs');

/**
 * Media the agent mentions in a reply (`![](/abs/x.gif)`, `` `/tmp/shot.png` ``) is a file it just
 * created somewhere in the project or a temp folder — unpredictable, so the roots are all of `~` and tmp.
 * The panel only lets its own JS load (CSP blocks every way out), but mobile's `/api/file` goes
 * over the LAN: there roots this wide are ONLY safe because the file extension is pinned to `MEDIA_MIME` after realpath.
 */
export const MEDIA_MIME:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
  '.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'};
/** realpath: on macOS `/tmp` is a symlink to `/private/tmp`, and `os.tmpdir()` lives under `/private/var`. */
export function localMediaRoots():string[]{
  const out=new Set<string>();
  // Keep BOTH the raw and the realpath form: the agent writes `/tmp/x.png`, while comparing after realpath gives `/private/tmp/x.png`.
  for(const p of [os.homedir(),'/tmp',os.tmpdir()]){if(!p)continue;out.add(nodePath.resolve(p));try{out.add(fsSync.realpathSync(p));}catch{}}
  return [...out];
}
