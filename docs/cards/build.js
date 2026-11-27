#!/usr/bin/env node
// Renders the README illustration cards to docs/images/card-<name>-<theme>.png.
// GitHub and the Marketplace strip CSS and SVG from READMEs, so the cards ship as PNGs; this file is their source.
// Usage: node docs/cards/build.js [name...]   (needs Google Chrome or Edge, and python3 with Pillow for trimming)
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');

const CSS=`
:root{--bg:#ffffff;--card:#f6f8fa;--soft:#ffffff;--line:#d8dee4;--text:#1f2328;--muted:#59636e;--faint:#8c959f;
 --teal:#0f9d7a;--teal-soft:#e3f6f0;--blue:#2f6fdd;--blue-soft:#e8f0fc;--violet:#6a4ce2;--violet-soft:#efebfc;
 --amber:#b97c00;--amber-soft:#fdf3dc;--red:#cf3b3b;--red-soft:#fdeaea;--green:#1a7f37;--green-soft:#e6f4e8;--arrow:#8c959f}
:root.dark{--bg:#0d1117;--card:#161b22;--soft:#0d1117;--line:#30363d;--text:#e6edf3;--muted:#9198a1;--faint:#6e7681;
 --teal:#3fc8a4;--teal-soft:#0f2a24;--blue:#58a6ff;--blue-soft:#132339;--violet:#a28ff2;--violet-soft:#221d3a;
 --amber:#e3a521;--amber-soft:#2e2510;--red:#f07171;--red-soft:#3a1c1c;--green:#3fb950;--green-soft:#132a17;--arrow:#6e7681}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;width:960px;padding:8px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 24px}
h1{font-size:34px;line-height:1.1;margin:0 0 6px;letter-spacing:-.025em}
h3{font-size:16px;margin:0 0 2px}
.note{font-size:13px;color:var(--muted)}
.sec-h{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.ico{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none}
.ico svg,.ic svg{width:22px;height:22px}
.grid{display:grid;gap:12px}.g2{grid-template-columns:repeat(2,1fr)}.g3{grid-template-columns:repeat(3,1fr)}.g4{grid-template-columns:repeat(4,1fr)}
.sc{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--soft);position:relative}
.sc .num{position:absolute;top:12px;right:14px;font-size:12px;font-weight:750;color:var(--faint)}
.sc .ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;margin-bottom:10px}
.sc h3{font-size:15px}
.sc ul{margin:6px 0 0;padding-left:16px;font-size:13px;color:var(--muted)}.sc li{margin:3px 0}
.sc.you{border-style:dashed;border-width:1.5px}
.stat{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--soft)}
.stat .v{font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1}
.stat .l{font-size:12.5px;color:var(--muted);margin-top:6px}
kbd,code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 5px;color:var(--text)}
svg.ill{width:100%;height:auto;display:block}
svg text{font-family:inherit}
.t1{fill:var(--text);font-size:14px;font-weight:700}.t2{fill:var(--muted);font-size:12px}.t3{fill:var(--faint);font-size:11px;font-weight:700;letter-spacing:.08em}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.warn{display:flex;gap:10px;align-items:flex-start;margin-top:14px;border:1px solid var(--amber);background:var(--amber-soft);border-radius:12px;padding:10px 14px;font-size:13px}
`;

// 24x24 stroke icons, drawn for these cards.
const P={
  window:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chat:'<path d="M4 5h16v11H9l-5 4z"/>',
  phone:'<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
  term:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  shield:'<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  gauge:'<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  plug:'<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  download:'<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  puzzle:'<path d="M5 8h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3H5z"/>',
  rocket:'<path d="M12 3c3 2 5 5 5 9l-2 4H9l-2-4c0-4 2-7 5-9z"/><circle cx="12" cy="10" r="1.6"/><path d="M9 16l-2 4M15 16l2 4"/>',
  send:'<path d="M4 12l16-8-6 16-3-6z"/>',
  lock:'<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  queue:'<path d="M5 6h14M5 12h14M5 18h9"/>',
  key:'<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l3 3"/>',
};
const DEFS='<svg width="0" height="0" style="position:absolute"><defs>'+Object.entries(P).map(([k,v])=>`<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`).join('')
  +'<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--arrow)"/></marker></defs></svg>';
const ic=(name,c)=>`<div class="ic" style="background:var(--${c}-soft);color:var(--${c})"><svg><use href="#i-${name}"/></svg></div>`;
const head=(name,c,title,note)=>`<div class="sec-h"><div class="ico" style="background:var(--${c}-soft);color:var(--${c})"><svg><use href="#i-${name}"/></svg></div><div><h3>${title}</h3><div class="note">${note}</div></div></div>`;
const use=(name,x,y,s,c)=>`<use href="#i-${name}" x="${x}" y="${y}" width="${s}" height="${s}" style="color:var(--${c})"/>`;
const box=(x,y,w,h,fill,stroke)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="var(--${fill})" stroke="var(--${stroke})"/>`;
const arrow=(x1,y1,x2,y2)=>`<path d="M${x1},${y1} L${x2},${y2}" stroke="var(--arrow)" stroke-width="2" marker-end="url(#arr)"/>`;

const CARDS={
// Before/after: many windows vs one sidebar.
hero:()=>`<section style="background:linear-gradient(135deg,var(--teal-soft),var(--blue-soft))">
  <h1>Dev Hub for Claude Code</h1>
  <div style="font-size:17px;color:var(--muted);margin-bottom:16px">Every repo and every Claude Code chat in one VS Code window, and on your phone.</div>
  <svg class="ill" viewBox="0 0 910 250" role="img">
    <text class="t3" x="0" y="14">WITHOUT DEV HUB</text>
    ${[0,1,2].map(i=>`${box(i*104,26,92,74,'soft','line')}${use('window',i*104+30,36,32,'red')}<text class="t2" x="${i*104+46}" y="88" text-anchor="middle">repo ${String.fromCharCode(65+i)}</text>`).join('')}
    <text class="t1" x="320" y="58" style="fill:var(--red)">1 window per repo</text>
    <text class="t2" x="320" y="78">~1 GB RAM each · indexers, watchers</text>
    <text class="t3" x="0" y="140">WITH DEV HUB</text>
    ${box(0,152,300,92,'soft','teal')}${use('window',14,166,30,'teal')}
    <text class="t1" x="54" y="178">One VS Code window</text>
    <text class="t2" x="54" y="198">repos are paths, never indexed</text>
    <text class="t2" x="54" y="218">30 repos cost the same as one</text>
    ${arrow(300,198,356,198)}
    ${[0,1,2].map(i=>`${box(360,152+i*32-2,236,28,'soft','line').replace('rx="12"','rx="8"')}${use('term',370,156+i*32,18,'blue')}<text class="mono" x="396" y="${169+i*32}" style="fill:var(--text)">claude  cwd=~/repo-${String.fromCharCode(97+i)}</text>`).join('')}
    ${arrow(596,198,652,198)}
    ${box(656,152,250,92,'soft','line')}${use('chat',670,166,26,'violet')}${use('phone',870,166,26,'violet')}
    <text class="t1" x="704" y="184">Chat tab + phone</text>
    <text class="t2" x="670" y="210">same chat, two screens</text>
    <text class="t2" x="670" y="228">your CLAUDE.md, skills, memory</text>
  </svg>
  <div class="grid g4" style="margin-top:14px">
    <div class="stat"><div class="v" style="color:var(--teal)">1</div><div class="l">window for all your repos</div></div>
    <div class="stat"><div class="v">0</div><div class="l">runtime dependencies</div></div>
    <div class="stat"><div class="v">0</div><div class="l">API keys: uses your own Claude Code login</div></div>
    <div class="stat"><div class="v" style="color:var(--violet)">LAN</div><div class="l">phone page, no cloud relay</div></div>
  </div>
</section>`,

// Four steps from download to first chat; dashed = the user acts.
start:()=>`<section>
  ${head('rocket','teal','Get started in 4 steps','No terminal needed. Dev Hub installs and signs in Claude Code for you.')}
  <div class="grid g4">
    <div class="sc"><span class="num">1</span>${ic('download','blue')}<h3>Download</h3><ul><li><code>.vsix</code> from GitHub Releases</li></ul></div>
    <div class="sc"><span class="num">2</span>${ic('puzzle','violet')}<h3>Install</h3><ul><li>Extensions view → <b>…</b> → <b>Install from VSIX…</b></li></ul></div>
    <div class="sc you"><span class="num">3</span>${ic('shield','amber')}<h3>Click the top row</h3><ul><li>Install Claude Code</li><li>Log in</li><li>Add a project</li></ul></div>
    <div class="sc"><span class="num">4</span>${ic('chat','teal')}<h3>Chat</h3><ul><li><b>New chat…</b> and type what you want done</li></ul></div>
  </div>
  <svg class="ill" viewBox="0 0 910 150" role="img" style="margin-top:16px">
    <text class="t3" x="0" y="14">STEP 3 · THE SIDEBAR TELLS YOU WHAT IS NEXT</text>
    ${[['Install Claude Code…','amber','Pick an installer. The command is typed, you press Enter.'],['Log in to Claude Code…','amber','The browser opens. Sign in, come back.'],['Add your first project…','green','Pick any folder with code.']].map(([t,c,d],i)=>{
      const x=i*310;return `${box(x,28,290,112,'soft','line')}<rect x="${x+12}" y="42" width="266" height="30" rx="7" fill="var(--${c}-soft)"/>${use(i<2?'shield':'folder',x+20,48,18,c)}<text class="t1" x="${x+46}" y="62" style="font-size:13px">${t}</text>
      <text class="t2" x="${x+14}" y="96">${d.split('. ')[0]}${d.includes('. ')?'.':''}</text><text class="t2" x="${x+14}" y="116">${d.includes('. ')?d.split('. ').slice(1).join('. '):''}</text>${i<2?arrow(x+290,84,x+306,84):''}`;}).join('')}
  </svg>
  <div class="note" style="margin-top:8px">Each row disappears once its step works. Lost? Run <b>Dev Hub: Get Started</b> from the command palette.</div>
</section>`,

// What one prompt goes through.
flow:()=>`<section>
  ${head('send','blue','What happens when you send a prompt','Dev Hub only drives the claude CLI. Your setup applies exactly as in a terminal.')}
  <svg class="ill" viewBox="0 0 910 260" role="img">
    ${box(0,20,150,80,'soft','line')}${use('chat',14,34,26,'violet')}<text class="t1" x="48" y="52">You type</text><text class="t2" x="14" y="84">panel or phone</text>
    ${arrow(150,60,196,60)}
    ${box(200,20,200,80,'teal-soft','teal')}${use('window',214,34,26,'teal')}<text class="t1" x="248" y="52">Dev Hub</text><text class="t2" x="214" y="76">busy? the prompt queues</text><text class="t2" x="214" y="92">and runs next</text>
    ${arrow(400,60,446,60)}
    ${box(450,20,230,80,'blue-soft','blue')}${use('term',464,34,26,'blue')}<text class="t1" x="498" y="52">claude CLI</text><text class="t2" x="464" y="76">cwd = the project folder</text><text class="t2" x="464" y="92">CLAUDE.md, skills, memory</text>
    ${arrow(680,60,726,60)}
    ${box(730,20,180,80,'soft','line')}${use('image',744,34,26,'violet')}<text class="t1" x="778" y="52">Reply</text><text class="t2" x="744" y="76">streams in live</text><text class="t2" x="744" y="92">images + video inline</text>
    <path d="M565,100 L565,150" stroke="var(--arrow)" stroke-width="2" stroke-dasharray="4 4" marker-end="url(#arr)"/>
    <text class="t2" x="575" y="130">tool needs approval</text>
    ${box(380,156,530,96,'amber-soft','amber')}${use('shield',394,170,24,'amber')}<text class="t1" x="426" y="187">Allow / Deny card</text>
    <rect x="426" y="200" width="70" height="26" rx="7" fill="var(--green)"/><text x="461" y="218" text-anchor="middle" style="fill:#fff;font-size:12.5px;font-weight:700">Allow</text>
    <rect x="504" y="200" width="70" height="26" rx="7" fill="var(--card)" stroke="var(--line)"/><text class="t2" x="539" y="218" text-anchor="middle">Deny</text>
    <text class="t2" x="590" y="210">panel and phone</text>
    <text class="t2" x="394" y="244">Tab closed, turn ended or timeout → auto deny. The CLI never hangs.</text>
    ${box(0,156,340,96,'soft','line')}${use('gauge',14,170,24,'teal')}<text class="t1" x="46" y="187">Always in view</text>
    <text class="t2" x="14" y="214">context · 5-hour · 7-day rings</text><text class="t2" x="14" y="234">cache chip: next turn cheap or cold</text>
  </svg>
</section>`,

features:()=>{const f=[
  ['folder','teal','Every project, one sidebar',['Workspaces → projects → chats','<kbd>⌘⌥J</kbd> find a project, start a chat','<kbd>⌘⇧]</kbd> <kbd>⌘⇧[</kbd> jump between running chats']],
  ['image','violet','Shows what the agent made',['Images, GIF, video play inline','Paste screenshots into the prompt','Long tool output folds']],
  ['queue','blue','Nothing hangs or gets lost',['Prompts queue during a turn','Stop keeps the queue','Tabs survive Reload Window']],
  ['gauge','amber','Limits at a glance',['Context, 5-hour, 7-day rings','Prompt-cache countdown','Model + effort per chat']],
  ['phone','violet','On your phone',['Same chats, approvals, history','Add to Home Screen','LAN or your own tunnel']],
  ['plug','teal','Extras',['Ports panel: who owns each port','Terminal chats picked up from ~/.claude','Second Claude account per project']],
];return `<section>
  ${head('puzzle','teal','What you get','')}
  <div class="grid g3">${f.map(([i,c,t,rows])=>`<div class="sc">${ic(i,c)}<h3>${t}</h3><ul>${rows.map(r=>`<li>${r}</li>`).join('')}</ul></div>`).join('')}</div>
</section>`;},

phone:()=>`<section>
  ${head('phone','violet','Use it from your phone in 3 steps','Same Wi-Fi, no app store, no cloud relay.')}
  <div class="grid g3">
    <div class="sc"><span class="num">1</span>${ic('key','amber')}<h3>Set a passcode</h3><ul><li><code>devHub.mobile.passcode</code></li><li>4 digits, or 8–128 characters</li></ul></div>
    <div class="sc"><span class="num">2</span>${ic('window','teal')}<h3>Open the web app</h3><ul><li><b>Dev Hub: Open Mobile Web App</b></li><li>It shows a URL like <code>http://192.168.1.20:39642/</code></li></ul></div>
    <div class="sc you"><span class="num">3</span>${ic('phone','violet')}<h3>Open it on the phone</h3><ul><li>Enter the passcode</li><li>Optional: Add to Home Screen</li></ul></div>
  </div>
  <div class="warn"><svg style="width:20px;height:20px;flex:none;color:var(--amber)"><use href="#i-lock"/></svg><div>The passcode is the <b>only</b> guard: past it, anyone can drive an agent on your machine. On networks you don't control, set <code>devHub.mobile.lan: false</code> and use a tunnel you trust (for example Tailscale).</div></div>
</section>`,
};

function chrome(){
  for(const c of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/usr/bin/google-chrome','/usr/bin/chromium'])if(fs.existsSync(c))return c;
  throw new Error('Google Chrome or Edge is required');
}
const TRIM=`import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert("RGB");w,h=im.size;px=im.load();bg=px[w-2,h-2]
b=h
while b>1 and all(px[x,b-1]==bg for x in range(0,w,5)):b-=1
im.crop((0,0,w,min(h,b+16))).save(sys.argv[1],optimize=True)`;

const root=path.join(__dirname,'..','..');const out=path.join(root,'docs','images');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-cards-'));const exe=chrome();
for(const name of (process.argv.slice(2).length?process.argv.slice(2):Object.keys(CARDS)))for(const theme of ['light','dark']){
  const html=path.join(tmp,`${name}-${theme}.html`);
  fs.writeFileSync(html,`<!doctype html><html${theme==='dark'?' class="dark"':''}><head><meta charset="utf-8"><style>${CSS}</style></head><body>${DEFS}${CARDS[name]()}</body></html>`);
  const png=path.join(out,`card-${name}-${theme}.png`);
  execFileSync(exe,['--headless=new','--disable-gpu','--hide-scrollbars','--force-device-scale-factor=2','--window-size=976,1400','--screenshot='+png,'file://'+html],{stdio:'ignore',timeout:60000});
  execFileSync('python3',['-c',TRIM,png]);console.log(path.relative(root,png));
}
fs.rmSync(tmp,{recursive:true,force:true});
