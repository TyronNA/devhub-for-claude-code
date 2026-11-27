const nodePath=require('node:path');
const os=require('node:os');
const fsSync=require('node:fs');

/**
 * Media agent nhắc tới trong câu trả lời (`![](/abs/x.gif)`, `` `/tmp/shot.png` ``) là file nó vừa
 * tạo ra ở đâu đó trong project hoặc thư mục tạm — không đoán trước được, nên gốc là cả `~` và tmp.
 * Panel chỉ cho JS của chính nó nạp (CSP chặn mọi đường ra ngoài), nhưng `/api/file` của mobile đi
 * qua LAN: ở đó gốc rộng thế này CHỈ an toàn nhờ chốt đuôi file trong `MEDIA_MIME` sau realpath.
 */
export const MEDIA_MIME:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
  '.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'};
/** realpath: trên macOS `/tmp` là symlink sang `/private/tmp`, `os.tmpdir()` nằm dưới `/private/var`. */
export function localMediaRoots():string[]{
  const out=new Set<string>();
  // Giữ CẢ bản thô lẫn bản realpath: agent viết `/tmp/x.png`, còn so sau realpath lại ra `/private/tmp/x.png`.
  for(const p of [os.homedir(),'/tmp',os.tmpdir()]){if(!p)continue;out.add(nodePath.resolve(p));try{out.add(fsSync.realpathSync(p));}catch{}}
  return [...out];
}
