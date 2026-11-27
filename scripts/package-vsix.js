const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');
async function copy(src,dst){await fsp.mkdir(path.dirname(dst),{recursive:true});const st=await fsp.stat(src);if(st.isDirectory()){await fsp.mkdir(dst,{recursive:true});for(const name of await fsp.readdir(src))await copy(path.join(src,name),path.join(dst,name));}else await fsp.copyFile(src,dst);}
(async()=>{
  const root=path.resolve(__dirname,'..');const pkg=JSON.parse(await fsp.readFile(path.join(root,'package.json'),'utf8'));const stage=await fsp.mkdtemp(path.join(os.tmpdir(),'devhub-vsix-'));const ext=path.join(stage,'extension');await fsp.mkdir(ext,{recursive:true});
  // LICENSE nằm trong `files` của package.json nhưng chưa từng được copy — gói ra thiếu nó.
  for(const rel of ['package.json','README.md','LICENSE','media','dist/src'])await copy(path.join(root,rel),path.join(ext,rel));
  const manifest=`<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/><DisplayName>${escapeXml(pkg.displayName)}</DisplayName><Description xml:space="preserve">${escapeXml(pkg.description)}</Description><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines.vscode)}"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>`;
  const content=`<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="xml" ContentType="text/xml"/><Override PartName="/extension/LICENSE" ContentType="text/plain"/></Types>`;
  await fsp.writeFile(path.join(stage,'extension.vsixmanifest'),manifest);await fsp.writeFile(path.join(stage,'[Content_Types].xml'),content);
  const out=path.join(root,`${pkg.name}-${pkg.version}.vsix`);try{await fsp.unlink(out)}catch{}
  cp.execFileSync('zip',['-qr',out,'.'],{cwd:stage});console.log(out);
})();
function escapeXml(s){return String(s).replace(/[<>&\"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','\"':'&quot;',"'":'&apos;'}[c]));}
