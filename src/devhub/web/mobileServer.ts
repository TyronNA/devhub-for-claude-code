const http=require('node:http');
const crypto=require('node:crypto');
const fsp=require('node:fs/promises');
const fsSync=require('node:fs');
const nodePath=require('node:path');
import { DevHubEvent, DevHubProject, DevHubSession, DevHubWorkspace, ProviderId } from '../types';
import { SessionManager } from '../sessions/sessionManager';
import { AgentProvider } from '../providers/provider';
import { coalesceSessionDeltas, EventBatcher } from '../ui/eventBatcher';
import { SessionEventCache } from '../sessions/sessionEventCache';
import { mergeTranscript, rereadsTranscript } from '../sessions/transcriptMerge';
import { recoverImages } from '../providers/claude/claudeProvider';
import { toolImageDir } from '../providers/claude/claudeEventParser';
import { chatBodyMarkup, webviewAssets, optionChoices, defaultTurnOptions, foreignAttachment } from '../views/chatPanelProvider';
import { GitStatusWatcher } from '../workspace/gitStatusWatcher';
import { parseMobileMessage } from './mobileProtocol';
import { localMediaRoots, MEDIA_MIME } from '../views/localMedia';
import { providerLabel } from '../ui/format';

/**
 * The third way in: a REAL web app, served over HTTP from the machine running the extension host and opened
 * directly on the LAN. Why it exists: VS Code
 * Web's webview lives in a `*.vscode-cdn.net` iframe with a service worker, and WebKit on iPhone can't
 * run that — the panel stays black. This page is not a webview, so none of that applies.
 *
 * It speaks EXACTLY `chat.js`'s protocol (host <-> webview), only the pipe changes: SSE down,
 * POST up. That way the same renderer is reused instead of maintaining two transcript renderers.
 * Gotcha: every protocol change in `chatPanelProvider` must be checked against this file — two hosts,
 * one client.
 */

const PERM_TIMEOUT_MS=5*60*1000;
const ASK_TIMEOUT_MS=60*60*1000;
const ATTACHMENT_TTL_MS=48*60*60*1000;
const PRUNE_EVERY_MS=6*60*60*1000;
// SSE dies silently when a proxy cuts it midway; pings keep the pipe open and tell the client we're alive.
const PING_MS=25*1000;
const MAX_BODY=16*1024*1024;
/** Opening a session (and every SSE reconnect after iOS hides the tab) sent the whole buffer: measured 0.8-1.5 MB
 *  of uncompressed JSON and 1,500 DOM rows redrawn from scratch. The phone only gets the tail; older ones load on tap. */
const MOBILE_PAGE=200;
// A provider may declare the real id before `manager.start()` returns. Keep a short-lived alias
// so mobile doesn't hold the pending id and reconnect into a "lost" session.
const REKEY_ALIAS_TTL_MS=5*60*1000;
// Opening a session accepts a git result up to 2s old — no need to rerun `git` on every pick.
const SCM_MAX_AGE_MS=2000;
/**
 * EXACTLY 4 digits, OR 8+ non-space characters. The keypad auto-submits at 4, so widening the digit branch without
 * changing the keypad sets a passcode that can never be typed — exported so tests lock the two
 * together. The long branch is for machines exposing this page beyond the LAN, and it requires a text
 * input: `keypad()` picks the page variant from the passcode in use, not from a separate setting.
 */
export const PASSCODE_RE=/^(?:\d{4}|\S{8,128})$/;
/** The keypad can only type the 4-digit branch; a long passcode needs an input + submit button. */
export const isPinPasscode=(v:string)=>/^\d{4}$/.test(v);
// 4 digits are 10,000 combinations and this door opens onto a shell: lockout IS the defence,
// not decoration. Past the threshold you wait, and the wait doubles each time.
const LOGIN_FREE_TRIES=5;
const LOGIN_BASE_LOCK_MS=30*1000;
const LOGIN_MAX_LOCK_MS=15*60*1000;
const TOKEN_FILE='mobile-token';
const EXT:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
const COOKIE='devhub_mobile';
/**
 * The webview panel runs under `default-src 'none'` + nonce; this HTTP page used to have NO
 * CSP at all, i.e. the second front-end lacked every defence of the first. Everything it loads
 * is same-origin (`/assets/*`, `/api/file`, EventSource `/api/stream`, fetch `/api/*`) so
 * `'self'` is enough — NO `'unsafe-inline'` needed: the markup has no `style=` and the css has no
 * `url()`. `data:` is only opened for images.
 */
const CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; "
  +"connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * This machine's LAN IPv4, to build the link for the phone. Private ranges ONLY (RFC1918) —
 * the old version fell back to "any non-link-local address", meaning a machine with a public IP
 * or on a VPN would hand out a public URL with a token. Returns empty if none;
 * the caller falls back to loopback.
 */
const PRIVATE_V4=/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
export function lanAddress():string{
  const nets=require('node:os').networkInterfaces();
  for(const name of Object.keys(nets))
    for(const ni of nets[name]||[]){
      if(ni.internal||ni.family!=='IPv4')continue;
      if(PRIVATE_V4.test(ni.address))return ni.address;
    }
  return '';
}

interface Draft {workspace:DevHubWorkspace;project:DevHubProject;provider:ProviderId;}
interface QueuedPrompt {text:string;images?:string[];}
/** One client = one browser tab. The equivalent of the panel's `Tab`, only the output differs. */
interface Client {
  id:string;res:any;session?:DevHubSession;draft?:Draft;workspace?:DevHubWorkspace;project?:DevHubProject;
  model?:string;effort?:string;queue:QueuedPrompt[];batcher:EventBatcher<any>;starting?:boolean;flushing?:boolean;
  /** Two POSTs are two requests; without chaining, their handlers interleave between awaits. */
  chain:Promise<any>;
  /** Number of trailing events shown for session `key`; switching session (rekey included) resets to MOBILE_PAGE. */
  shown?:{key:string;n:number};
}

export interface MobileServerDeps {
  manager:SessionManager;
  providers:Record<string,AgentProvider>;
  lookup:()=>Promise<{workspaces:DevHubWorkspace[];projects:DevHubProject[]}>;
  listSessions:()=>Promise<DevHubSession[]>;
  findSession:(provider:string,id:string)=>Promise<DevHubSession|undefined>;
  answerPermission:(provider:string,sessionId:string,requestId:string,allow:boolean,updatedInput?:any)=>void;
  onSelection?:(s:DevHubSession)=>void;
  /** The tree asks `isAwaitingPermission` while drawing, so it must be woken when a question appears
   *  and when it is answered — the mobile page can approve while the panel sees nothing. */
  onChanged?:()=>void;
  storageDir:string;
  /** Read at call time, not captured once: a user changing the setting without reloading the window must still take effect. */
  passcode:()=>string;
  log?:(line:string)=>void;
  /** Shares one git cache with the panel: the same repo means a single `git` run. */
  gitWatcher?:GitStatusWatcher;
  /** Claude account per project. `label` returning `undefined` = `altAccountFile` not set, feature hidden. */
  accounts?:{label:(root:string)=>string|undefined;toggle:(root:string,name:string)=>Promise<{level:'info'|'warn'|'error';message:string}>};
}

export class MobileServer {
  private server:any;
  private clients=new Map<string,Client>();
  private buffers=new SessionEventCache<DevHubEvent>(12,1500);
  /** key -> number of events at the start of the buffer that came from `loadTranscript`; see `mergeTranscript`. */
  private historyLen=new Map<string,number>();
  private disposers:Array<()=>void>=[];
  private pendingPerms=new Map<string,{provider:string;sessionId:string;timer:any;input?:any;req:any}>();
  private token='';
  private port=0;
  private attempts=new Map<string,{n:number;until:number}>();
  private seenMsgIds=new Set<string>();
  private recentRekeys=new Map<string,{session:DevHubSession;expiresAt:number}>();

  constructor(private deps:MobileServerDeps){}

  address(){return this.port?{port:this.port,token:this.token}:undefined;}

  async start(port:number,bindLan=false):Promise<{port:number;token:string}>{
    if(this.port)return {port:this.port,token:this.token};
    // No passcode means no door at all: `?t=` is gone, so opening the port would open a shell to the whole LAN.
    if(!PASSCODE_RE.test(String(this.deps.passcode()||'')))
      throw new Error('set devHub.mobile.passcode (exactly 4 digits, or 8+ non-space characters) before serving the page');
    this.token=this.loadToken();
    this.server=http.createServer((req:any,res:any)=>{this.route(req,res).catch((e:any)=>this.fail(res,500,e?.message||String(e)));});
    await new Promise<void>((resolve,reject)=>{
      this.server.once('error',reject);
      // `bindLan` is what opens it beyond loopback (a phone on the same Wi-Fi must reach it). The whole LAN
      // can reach an endpoint that runs a CLI, and the token travels over plain HTTP so anyone sniffing packets
      // gets it — `devHub.mobile.lan` is the off switch; don't turn it on on unknown Wi-Fi.
      this.server.listen(port,bindLan?'0.0.0.0':'127.0.0.1',()=>{this.server.off('error',reject);resolve();});
    });
    this.port=this.server.address().port;
    this.disposers.push(
      this.deps.manager.on('event',(x:any)=>this.onEvent(x)),
      this.deps.manager.on('sessionUpdated',(s:any)=>this.onSessionUpdated(s)),
      this.deps.manager.on('sessionRekeyed',(x:any)=>this.onRekey(x)),
    );
    const git=this.deps.gitWatcher;
    if(git)this.disposers.push(
      // A connected SSE client = someone is looking at that repo; if the network drops the client disappears and git rests.
      git.addSource(()=>[...this.clients.values()].filter(c=>c.project?.gitRoot)
        .map(c=>({root:c.project!.gitRoot!,hot:c.session?.status==='running'}))),
      git.on((root,status)=>{for(const c of this.clients.values())if(c.project?.gitRoot===root)this.post(c,{type:'scm',status});}),
    );
    void this.pruneAttachments();
    // Sweeping only once at start means the 48h TTL is never enforced on a long-running host.
    this.pruneTimer=setInterval(()=>void this.pruneAttachments(),PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
    return {port:this.port,token:this.token};
  }

  private pruneTimer:any;
  dispose(){
    clearInterval(this.pruneTimer);this.pruneTimer=undefined;
    for(const id of [...this.pendingPerms.keys()])this.settlePerm(id,false);
    for(const d of this.disposers)d();this.disposers=[];
    for(const c of this.clients.values()){c.batcher.dispose();try{c.res.end();}catch{}}
    this.clients.clear();
    this.recentRekeys.clear();
    try{this.server?.close();}catch{}
    this.server=undefined;this.port=0;this.token='';
  }

  /**
   * The token is the cookie's value, and it must SURVIVE restarts: minting a new one on every activate means
   * every signed-in PWA/bookmark gets kicked out after each Reload Window. 0600 because it is a secret.
   */
  private tokenPath(){return nodePath.join(this.deps.storageDir,TOKEN_FILE);}
  private loadToken():string{
    try{
      const saved=fsSync.readFileSync(this.tokenPath(),'utf8').trim();
      if(/^[A-Za-z0-9_-]{24,}$/.test(saved))return saved;
    }catch{}
    return this.writeToken();
  }
  private writeToken():string{
    const token=crypto.randomBytes(24).toString('base64url');
    try{fsSync.mkdirSync(this.deps.storageDir,{recursive:true});
        fsSync.writeFileSync(this.tokenPath(),token,{mode:0o600});}catch{}
    return token;
  }
  /** Revokes every signed-in device: old cookies point at the old token and match nothing. */
  rotateToken(){const t=this.writeToken();if(this.port)this.token=t;return t;}

  // ---------- HTTP ----------
  private fail(res:any,code:number,message:string){
    try{res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});res.end(message);}catch{}
  }
  /** Cookie only: the token never travels in a URL any more (see `login`). */
  private authed(req:any){
    if(!this.token)return false;
    const cookie=String(req.headers?.cookie||'').split(';').map((s:string)=>s.trim())
      .find((s:string)=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    const mine=Buffer.from(this.token);
    for(const candidate of [cookie]){
      if(typeof candidate!=='string')continue;
      // Compare by BYTE: multi-byte strings with the same character length still differ in buffer length, and
      // timingSafeEqual throws RangeError instead of returning false.
      const buf=Buffer.from(candidate);
      if(buf.length===mine.length&&crypto.timingSafeEqual(buf,mine))return true;
    }
    return false;
  }
  /**
   * DNS rebinding + CSRF. The token and cookie already block this path (the cookie is bound to an origin that is
   * an IP, a foreign page can't read it), but checking Origin closes it structurally and cheaply.
   * ONLY compared when the browser sends an Origin — non-browser clients don't.
   * No Host allowlist: through a tunnel the Host is the tunnel's name, and blocking it would
   * block the very usage docs/DESIGN.md promises. `x-forwarded-host` still passes for proxies that rewrite Host.
   */
  private sameOrigin(req:any):boolean{
    const origin=String(req.headers?.origin||'');
    if(!origin||origin==='null')return true;
    const hosts=[String(req.headers?.host||''),String(req.headers?.['x-forwarded-host']||'')].filter(Boolean);
    try{return hosts.includes(new URL(origin).host);}catch{return false;}
  }
  private async route(req:any,res:any){
    const parsed=new URL(req.url,'http://127.0.0.1');
    const path=parsed.pathname;
    if(!this.sameOrigin(req))return this.fail(res,403,'Dev Hub: cross-origin request refused.');
    // The only door, and it must stand BEFORE the auth fence — it is only needed when there is no cookie yet.
    if(path==='/api/login'&&req.method==='POST')return this.login(req,res);
    if(!this.authed(req)){
      // Only the root page may show the keypad; everything else stays a bare 401, revealing no UI.
      if(path==='/'||path==='/index.html')return this.keypad(res);
      return this.fail(res,401,'Dev Hub: bad or missing token.');
    }

    if(path==='/'||path==='/index.html'){
      const headers:any={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
        'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
      res.writeHead(200,headers);res.end(this.html());return;
    }
    if(path==='/manifest.webmanifest')return this.manifest(res);
    if(path.startsWith('/assets/'))return this.serveAsset(res,path.slice('/assets/'.length));
    if(path==='/api/stream')return this.openStream(req,res);
    if(path==='/api/file')return this.serveFile(req,res,parsed.searchParams);
    if(path==='/api/sessions')return this.json(res,await this.sessionList());
    if(path==='/api/choices')return this.json(res,await this.choices(parsed));
    if(path==='/api/msg'&&req.method==='POST'){
      const client=this.clients.get(parsed.searchParams.get('c')||'');
      if(!client)return this.fail(res,409,'stale client — reload');
      const body=await this.readBody(req);
      this.json(res,{ok:true});
      if(this.duplicate(body))return;
      // Chained per client: openSession has several awaits, and a sendPrompt arriving midway would find
      // the client still blank and be dropped with "Pick a session first".
      client.chain=client.chain.then(()=>this.handleMessage(client,body),()=>this.handleMessage(client,body));
      await client.chain;
      return;
    }
    return this.fail(res,404,'not found');
  }
  /** `__id` is attached by the bridge; only used as a dedupe key, not part of content validation. */
  private duplicate(body:any):boolean{
    const id=typeof body?.__id==='string'&&body.__id.length<=64?body.__id:'';
    if(!id)return false;
    if(this.seenMsgIds.has(id))return true;
    this.seenMsgIds.add(id);
    if(this.seenMsgIds.size>500)this.seenMsgIds.delete(this.seenMsgIds.values().next().value as string);
    return false;
  }
  private json(res:any,value:any){
    const text=JSON.stringify(value);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(text);
  }
  private readBody(req:any):Promise<any>{
    return new Promise((resolve,reject)=>{
      let size=0;const chunks:any[]=[];
      req.on('data',(c:any)=>{size+=c.length;if(size>MAX_BODY){reject(new Error('body too large'));req.destroy();return;}chunks.push(c);});
      req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{resolve({});}});
      req.on('error',reject);
    });
  }
  /**
   * iOS 17.4+ runs home-screen web apps from the manifest; `apple-mobile-web-app-capable` alone
   * is the legacy path. NO `icons` declared: there is no image file to point at, and a dead entry
   * is worse than letting iOS take a screenshot. `background_color` only paints the splash and a manifest can't
   * media-query — dark is chosen because that is a dev tool's background.
   */
  private manifest(res:any){
    return this.text(res,JSON.stringify({name:'Dev Hub',short_name:'Dev Hub',start_url:'/',scope:'/',
      display:'standalone',orientation:'portrait',background_color:'#181818',theme_color:'#181818'}),'application/manifest+json');
  }
  private assetDir(){return nodePath.join(__dirname,'..','..','..','..','media','mobile');}
  /**
   * A PWA on iPhone doesn't reload the page when the server restarts — only SSE reconnects, and old JS keeps running against
   * the new server. `hello` carries this id; when the bridge sees it differs from the id embedded in the page it reloads itself.
   */
  private buildId(){return this.build??=crypto.createHash('sha1').update(webviewAssets().script).update(webviewAssets().css)
    .update(['bridge.js','mobile.css'].map(n=>{try{return fsSync.readFileSync(nodePath.join(this.assetDir(),n),'utf8');}catch{return '';}}).join('\0')).digest('hex').slice(0,12);}
  private build?:string;
  private serveAsset(res:any,name:string){
    const assets=webviewAssets();
    if(name==='chat.js')return this.text(res,assets.script,'application/javascript');
    if(name==='chat.css')return this.text(res,assets.css,'text/css');
    if(name==='bridge.js'||name==='mobile.css'){
      const file=nodePath.join(this.assetDir(),name);
      const body=fsSync.readFileSync(file,'utf8');
      return this.text(res,body,name.endsWith('.css')?'text/css':'application/javascript');
    }
    return this.fail(res,404,'no such asset');
  }
  private text(res:any,body:string,type:string){
    res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-store'});res.end(body);
  }
  /** Images the user attached and media the agent mentions (`localMediaRoots`). */
  private imageRoots(){return [this.attachmentDir(),...localMediaRoots()].flatMap(r=>{const raw=nodePath.resolve(r);try{return [raw,fsSync.realpathSync(r)];}catch{return [raw];}});}
  /** `p` = base64url (bridge, attached images); `f` = a raw path (media in replies, joined by chat.js). */
  private serveFile(req:any,res:any,q:any){
    let p=q.get('f')||'';
    if(!p)try{p=Buffer.from(q.get('p')||'','base64url').toString('utf8');}catch{return this.fail(res,400,'bad path');}
    // A bare `startsWith` lets `/root-evil` through because it shares the prefix; anchor on the separator.
    const roots=this.imageRoots();
    const allowed=(f:string)=>!!MEDIA_MIME[nodePath.extname(f).toLowerCase()]&&roots.some(root=>f===root||f.startsWith(root+nodePath.sep));
    // Checked twice: before realpath so a path outside the roots doesn't reveal whether it exists (403, not 404);
    // after realpath because the roots now include `~` — an `x.png` symlinked to `~/.ssh/id_rsa` must die here.
    if(!allowed(nodePath.resolve(p)))return this.fail(res,403,'not a media file inside the media roots');
    let resolved='';
    try{resolved=fsSync.realpathSync(nodePath.resolve(p));}catch{return this.fail(res,404,'gone');}
    if(!allowed(resolved))return this.fail(res,403,'not a media file inside the media roots');
    const type=MEDIA_MIME[nodePath.extname(resolved).toLowerCase()];
    let size=0;
    try{const st=fsSync.statSync(resolved);if(!st.isFile())return this.fail(res,404,'gone');size=st.size;}catch{return this.fail(res,404,'gone');}
    // Safari won't play <video> unless the server answers Range with 206 — even for small files.
    // Tool images are named by content sha1 ⇒ they never change, cache them for good; other files may be overwritten by the agent under the same name.
    const hashed=[toolImageDir(),...(()=>{try{return [fsSync.realpathSync(toolImageDir())];}catch{return [];}})()].some(d=>resolved.startsWith(d+nodePath.sep));
    const head:any={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':hashed?'private, max-age=31536000, immutable':'private, max-age=600'};
    const m=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range||''));
    let start=0,end=size-1;
    if(m&&(m[1]||m[2])){
      if(m[1]){start=Number(m[1]);if(m[2])end=Math.min(Number(m[2]),size-1);}else start=Math.max(0,size-Number(m[2]));
      if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
      res.writeHead(206,{...head,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1)});
    } else res.writeHead(200,{...head,'Content-Length':String(size)});
    if(!size)return res.end();
    const rs=fsSync.createReadStream(resolved,{start,end});rs.on('error',()=>res.destroy());rs.pipe(res);
  }
  private html(){
    return `<!doctype html><html><head><meta charset="UTF-8"><title>Dev Hub</title><meta name="devhub-build" content="${this.buildId()}">`
      +`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">`
      +`<meta name="referrer" content="no-referrer">`
      +`<meta name="apple-mobile-web-app-capable" content="yes">`
      // `default`, NOT `black-translucent`: iOS 26+ lays a system blur over the status bar of a translucent
      // web app and the page can't turn it off. `default` makes the canvas start below the status bar; the bar
      // colour comes from `.ios-top-edge` (mobile.css). iOS only reads this meta at Add to Home ⇒ the old icon
      // must be removed and added again.
      +`<meta name="apple-mobile-web-app-status-bar-style" content="default">`
      // Must match `--vscode-sideBar-background` in mobile.css: this is the colour Chrome/Android paints
      // around the page, and a manifest can't media-query so these two lines carry both light and dark.
      +`<meta name="theme-color" content="#f6f6f6" media="(prefers-color-scheme: light)">`
      +`<meta name="theme-color" content="#181818" media="(prefers-color-scheme: dark)">`
      // `use-credentials` is REQUIRED: the manifest is fetched with credentials "omit" by default, and
      // this page only opens for holders of the token cookie → without it it's a 401 and iOS quietly drops the manifest.
      +`<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">`
      +`<link rel="stylesheet" href="/assets/chat.css"><link rel="stylesheet" href="/assets/mobile.css">`
      +`</head><body><div class="ios-top-edge" aria-hidden="true"></div>${chatBodyMarkup()}<div id="sheet" hidden></div>`
      // the bridge MUST run first: `chat.js` calls acquireVsCodeApi() on line 1.
      +`<script src="/assets/bridge.js"></script><script src="/assets/chat.js"></script></body></html>`;
  }

  /**
   * Sign in with a passcode instead of a token in the URL. Why it changed: the token was minted on every activate
   * so saved links died after each Reload Window, and Add to Home Screen on iOS drops the query
   * string — a PWA could never get the token. A PWA does keep cookies, so all that's needed is one door
   * to get the cookie.
   */
  private async login(req:any,res:any){
    const who=String(req.socket?.remoteAddress||'?');
    const wait=this.lockedFor(who);
    if(wait>0){res.writeHead(429,{'Content-Type':'application/json','Retry-After':String(Math.ceil(wait/1000)),'Cache-Control':'no-store'});
      return res.end(JSON.stringify({error:'locked',retryAfter:Math.ceil(wait/1000)}));}
    let code='';
    try{code=String((await this.readBody(req))?.code??'');}catch{}
    const want=String(this.deps.passcode()||'');
    const a=Buffer.from(code),b=Buffer.from(want);
    // Different lengths make timingSafeEqual THROW rather than return false; check the length first.
    const ok=PASSCODE_RE.test(want)&&a.length===b.length&&crypto.timingSafeEqual(a,b);
    if(!ok){
      const st=this.attempts.get(who)||{n:0,until:0};st.n++;
      if(st.n>LOGIN_FREE_TRIES)
        st.until=Date.now()+Math.min(LOGIN_BASE_LOCK_MS*Math.pow(2,st.n-LOGIN_FREE_TRIES-1),LOGIN_MAX_LOCK_MS);
      this.attempts.set(who,st);
      this.deps.log?.(`mobile login refused from ${who} (attempt ${st.n})`);
      const left=this.lockedFor(who);
      res.writeHead(left>0?429:401,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify(left>0?{error:'locked',retryAfter:Math.ceil(left/1000)}:{error:'bad code'}));
    }
    this.attempts.delete(who);
    const cookie=`${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      +(String(req.headers['x-forwarded-proto']||'').includes('https')?'; Secure':'');
    res.writeHead(204,{'Set-Cookie':cookie,'Cache-Control':'no-store'});res.end();
  }
  private lockedFor(who:string){const st=this.attempts.get(who);return st?Math.max(0,st.until-Date.now()):0;}

  /**
   * Two page variants, chosen by the passcode in use — there's no separate setting for the variant.
   * The 4-digit branch: a keypad drawn with `<button>`s, with NO `<input>` — on purpose, because in a web app installed
   * to the iOS home screen tapping a text field doesn't focus it or open the keyboard (WebKit).
   * The long passcode branch must have an input, so it relies on `autofocus` at HTML parse time plus
   * one `focus()` RIGHT INSIDE the Unlock button's tap handler — the only way WebKit agrees to open the
   * keyboard. NOT verified on a real iPhone: if it breaks, drop the passcode back to 4 digits and the keypad returns at once,
   * no extension reinstall needed.
   * Inline script/style use a nonce because the page's CSP doesn't allow `'unsafe-inline'`, and assets under
   * `/assets/*` are still behind the auth fence so this page can't reach them.
   */
  private keypad(res:any){
    const pin=isPinPasscode(String(this.deps.passcode()||''));
    const nonce=crypto.randomBytes(16).toString('base64');
    const csp=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; `
      +"base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    const html=`<!doctype html><html><head><meta charset="UTF-8"><title>Dev Hub</title>`
      +`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
      +`<meta name="referrer" content="no-referrer">`
      +`<meta name="apple-mobile-web-app-capable" content="yes">`
      // Same reason as `html()`: `default` + `.ios-top-edge` instead of translucent's blur.
      +`<meta name="apple-mobile-web-app-status-bar-style" content="default">`
      +`<meta name="theme-color" content="#f6f6f6" media="(prefers-color-scheme: light)">`
      +`<meta name="theme-color" content="#181818" media="(prefers-color-scheme: dark)">`
      +`<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">`
      +`<style nonce="${nonce}">`
      +`.ios-top-edge{display:none}`
      +`@supports (-webkit-touch-callout:none){@media (display-mode:standalone){.ios-top-edge{display:block;`
      +`position:fixed;top:0;left:0;right:0;height:12px;z-index:2147483647;pointer-events:none;`
      +`background-color:var(--bg);background-clip:text;-webkit-background-clip:text}}}`
      +`:root{color-scheme:light dark;--bg:#f6f6f6;--fg:#1f1f1f;--key:#ffffff;--line:#cecece;--dim:#6a6a6a}`
      +`@media (prefers-color-scheme:dark){:root{--bg:#181818;--fg:#d4d4d4;--key:#313131;--line:#3c3c3c;--dim:#9d9d9d}}`
      +`html,body{background:var(--bg);margin:0;height:100%}`
      +`body{color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;`
      +`display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;`
      +`padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}`
      +`h1{font-size:17px;font-weight:600;margin:0}`
      +`#dots{display:flex;gap:14px;height:14px}`
      +`.dot{width:13px;height:13px;border-radius:50%;border:1px solid var(--line)}`
      +`.dot.on{background:var(--fg);border-color:var(--fg)}`
      +`#msg{color:var(--dim);font-size:14px;min-height:20px;text-align:center;padding:0 24px}`
      +`#pad{display:grid;grid-template-columns:repeat(3,74px);gap:14px}`
      +`button{font:inherit;font-size:24px;height:74px;border-radius:50%;border:1px solid var(--line);`
      +`background:var(--key);color:var(--fg);-webkit-tap-highlight-color:transparent}`
      +`button:active{background:var(--line)}`
      +`button.flat{border-color:transparent;background:transparent;font-size:15px}`
      +`#pw{font:inherit;font-size:17px;width:258px;height:52px;box-sizing:border-box;padding:0 14px;`
      +`border-radius:12px;border:1px solid var(--line);background:var(--key);color:var(--fg)}`
      +`button.wide{width:258px;height:52px;border-radius:12px;font-size:17px}`
      +`</style></head><body><div class="ios-top-edge" aria-hidden="true"></div>`
      +`<h1>Dev Hub</h1><div id="dots"></div><div id="msg"></div>`
      // `autofocus` must be in the HTML at parse time: set on an element created with
      // createElement, WebKit ignores it and the input will never open the keyboard by itself.
      +(pin?``:`<input id="pw" type="password" autocapitalize="off" autocorrect="off" spellcheck="false"`
        +` enterkeyhint="go" autofocus placeholder="Passcode">`
        +`<button id="go" class="wide">Unlock</button>`)
      +`<div id="pad"></div>`
      +`<script nonce="${nonce}">`
      +`(function(){var code='',busy=false,pin=${pin?'true':'false'};`
      +`var dots=document.getElementById('dots'),msg=document.getElementById('msg'),pad=document.getElementById('pad');`
      +`function draw(){if(!pin)return;dots.textContent='';for(var i=0;i<code.length;i++){var d=document.createElement('span');d.className='dot on';dots.appendChild(d);}`
      +`for(var j=code.length;j<4;j++){var e=document.createElement('span');e.className='dot';dots.appendChild(e);}}`
      +`function send(){busy=true;msg.textContent='Checking…';`
      +`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})})`
      +`.then(function(r){if(r.status===204){location.replace('/');return;}`
      +`return r.json().catch(function(){return {};}).then(function(x){`
      +`msg.textContent=x.retryAfter?('Too many tries \u2014 wait '+x.retryAfter+'s'):'Wrong code';`
      +`code='';busy=false;clear();});})`
      +`.catch(function(){msg.textContent='No answer from the server';code='';busy=false;clear();});}`
      // After a wrong entry, clear the input and refocus: otherwise the next attempt appends to the old string and
      // burns another rate-limit attempt without the user understanding why.
      +`function clear(){draw();if(pin)return;var i=document.getElementById('pw');if(!i)return;i.value='';i.focus();}`
      +`function push(n){if(busy||code.length>=4)return;msg.textContent='';code+=n;draw();if(code.length>=4)send();}`
      +`if(pin){for(var k=1;k<=9;k++)(function(n){var b=document.createElement('button');b.textContent=String(n);`
      +`b.onclick=function(){push(String(n));};pad.appendChild(b);})(k);`
      +`var del=document.createElement('button');del.className='flat';del.textContent='\u232B';`
      +`del.onclick=function(){if(busy)return;code=code.slice(0,-1);draw();};pad.appendChild(del);`
      +`var zero=document.createElement('button');zero.textContent='0';zero.onclick=function(){push('0');};pad.appendChild(zero);`
      +`var pad3=document.createElement('span');pad.appendChild(pad3);draw();}`
      // With a long passcode the server can't know the length to auto-submit ⇒ a submit button is needed. Tapping
      // Unlock with an empty input only focuses: that's the one focus that happens inside a real iOS tap handler.
      +`else{var inp=document.getElementById('pw'),go=document.getElementById('go');`
      +`go.onclick=function(){if(busy)return;var v=inp.value||'';if(!v){inp.focus();return;}`
      +`msg.textContent='';code=v;send();};`
      +`inp.onkeydown=function(e){if(e&&e.key==='Enter')go.onclick();};}`
      +`})();`
      +`</script></body></html>`;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(html);
  }

  // ---------- SSE ----------
  private openStream(req:any,res:any){
    const id=crypto.randomUUID();
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const client:Client={id,res,queue:[],batcher:undefined as any,chain:Promise.resolve()};
    client.batcher=new EventBatcher<any>(items=>this.post(client,{type:'eventBatch',items:coalesceSessionDeltas(items)}),40);
    this.clients.set(id,client);
    this.send(client,{type:'hello',clientId:id,build:this.buildId()});
    // Here and not only on `ready`: an SSE reconnect doesn't send `ready`, but a new client always passes through here.
    this.send(client,{type:'mediaBase',base:'/api/file?f='});
    const ping:any=setInterval(()=>{try{res.write(': ping\n\n');}catch{}},PING_MS);
    ping.unref?.();
    const close=()=>{
      clearInterval(ping);
      if(this.clients.get(id)!==client)return;
      this.clients.delete(id);
      client.batcher.dispose();
      // The CLI blocks until a control_response: a tab closing without a deny leaves the turn hanging forever.
      if(client.session)this.denyPermsFor(client.session.provider,client.session.nativeSessionId);
    };
    req.on('close',close);req.on('error',close);
  }
  private send(client:Client,payload:any){
    try{client.res.write(`data: ${JSON.stringify(payload)}\n\n`);}catch{}
  }
  /** Same signature as the panel's `post` so the two hosts read alike. */
  private post(client:Client,message:any){this.send(client,message);}

  // ---------- state ----------
  private providerOf(client:Client):ProviderId{return (client.draft?.provider??client.session?.provider??'claude') as ProviderId;}
  private clientsFor(provider:string,sessionId:string){
    return [...this.clients.values()].filter(c=>c.session?.provider===provider&&c.session?.nativeSessionId===sessionId);
  }
  private async sessionList(){
    const snap=await this.deps.lookup();
    const sessions=(await this.deps.listSessions()).slice().sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,200);
    const acct=this.deps.accounts;
    return {workspaces:snap.workspaces,projects:acct?snap.projects.map(p=>({...p,account:acct.label(p.rootPath)})):snap.projects,
      sessions:sessions.map(s=>({...s,projectName:snap.projects.find(p=>p.id===s.projectId)?.name||s.cwd}))};
  }
  private async choices(parsed:any){
    const client=this.clients.get(parsed.searchParams.get('c')||'');
    const kind=String(parsed.searchParams.get('kind')||'');
    const provider=client?this.providerOf(client):'claude';
    if(kind==='model'||kind==='effort')
      return {items:optionChoices(provider,kind,client?.model)};
    if(kind==='slash'){
      const adapter:any=this.deps.providers[provider];
      const list:string[]=adapter?.slashCommands?.(client?.session?.nativeSessionId)||[];
      return {items:list.map(c=>({label:'/'+c,value:'/'+c+' '}))};
    }
    if(kind==='provider')return {items:[{label:'Claude',value:'claude'}]};
    return {items:[]};
  }

  /** Like the panel: an event outside any turn, and it must not create a buffer out of nothing. */
  injectEvent(provider:string,nativeSessionId:string,event:DevHubEvent){
    const key=this.sessionKey(provider,nativeSessionId);
    if(this.buffers.get(key)?.length)this.buffers.append(key,event);
    for(const c of this.clientsFor(provider,nativeSessionId))
      this.post(c,{type:'event',sessionId:nativeSessionId,event:this.forWeb(event)});
  }

  private async pushSession(client:Client,keepScroll=false){
    const session=client.session; if(!session)return;
    const key=this.sessionKey(session.provider,session.nativeSessionId);
    let events=this.buffers.get(key);
    // Like the panel: planner task rows re-read the daemon on every open, see `rereadsTranscript`.
    const reread=!!events?.length&&rereadsTranscript(session)&&!this.deps.manager.isBusy(session.provider,session.nativeSessionId);
    if(!events?.length||reread){
      try{
        // Claude images sit in the prompt as paths (`withImages`); without splitting them out
        // the phone page only sees a few bare path lines, the exact bug the panel already fixed.
        const loaded=(await this.deps.providers[session.provider].loadTranscript(session))
          .map((e:any)=>recoverImages(e,this.attachmentDir()+nodePath.sep));
        const merged=mergeTranscript(loaded,this.buffers.get(key)||[],reread?this.historyLen.get(key)||0:0,session.provider!=='planner');
        events=this.buffers.set(key,merged.events);
        this.historyLen.set(key,Math.max(0,merged.historyLen-(merged.events.length-events.length)));
      }catch(e:any){
        events=reread?this.buffers.get(key)??[]:[];
        this.post(client,{type:'error',message:`Transcript unavailable: ${e?.message||e}`});
      }
    }
    if(client.shown?.key!==key)client.shown={key,n:MOBILE_PAGE};
    const all=events||[],tail=all.slice(-client.shown.n);
    this.post(client,{type:'sessionSelected',session:client.session,events:tail.map(e=>this.forWeb(e)),
      workspace:client.workspace,project:client.project,older:all.length-tail.length,keepScroll:keepScroll||undefined});
    this.postOptions(client);
    this.postQueue(client);
    this.refreshScm(client);
    this.replayPerms(client);
  }
  /** Send the cached result right away, then re-read; a missing `status` = hide the chip (the project isn't a repo). */
  private refreshScm(client:Client){
    const root=client.project?.gitRoot;
    this.post(client,{type:'scm',status:root?this.deps.gitWatcher?.get(root):undefined});
    if(root)void this.deps.gitWatcher?.refresh(root,SCM_MAX_AGE_MS);
  }
  private postOptions(client:Client){
    const provider=this.providerOf(client);
    const adapter:any=this.deps.providers[provider];
    const slash=(adapter?.slashCommands?.(client.session?.nativeSessionId)||[]).length>0;
    this.post(client,{type:'optionsChanged',model:client.model,effort:client.effort,provider,slash});
  }
  /**
   * The queue belongs to the SESSION, not to the SSE tab. A phone dropping off the network is common
   * and `close` deletes the client — previously every typed-but-unsent prompt vanished silently, even though
   * `/api/msg` had returned 200 for it. The same array is attached to the client, so every existing push/splice
   * still works unchanged and the reconnect receives that exact array.
   */
  private sessionQueues=new Map<string,QueuedPrompt[]>();
  private queueFor(session:DevHubSession):QueuedPrompt[]{
    const k=this.sessionKey(session.provider,session.nativeSessionId);
    let q=this.sessionQueues.get(k);
    if(!q){q=[];this.sessionQueues.set(k,q);}
    return q;
  }
  private postQueue(client:Client){this.post(client,{type:'queue',items:client.queue.map(q=>({text:q.text,images:q.images?.length??0}))});}

  /** Images travel in events as PATHS; only when sending are they turned into this server's URLs. */
  private forWeb(event:any){
    // A data URI has no file for `/api/file` to point at.
    const uri=(p:string)=>String(p).startsWith('data:')?String(p):`/api/file?p=${Buffer.from(String(p),'utf8').toString('base64url')}`;
    if(event?.type==='assistant_image'&&event.path)return {...event,src:uri(event.path)};
    if(event?.type==='user_message'&&event.images?.length)return {...event,imageSrcs:event.images.map(uri)};
    return event;
  }

  // ---------- messages from the client ----------
  private async handleMessage(client:Client,raw:any){
    try{
      const m:any=parseMobileMessage(raw);
      if(!m){
        if(raw?.type==='pasteImage')this.post(client,{type:'attachmentError',requestId:raw.requestId,message:'Invalid image or over the 9 MiB limit.'});
        return;
      }
      if(m.type==='ready'){
        if(client.session)await this.pushSession(client);
        else this.post(client,{type:'empty'});
        this.postOptions(client);this.postQueue(client);return;
      }
      if(m.type==='openSession'){
        const session=this.rekeyedSession(m.provider,m.id)??await this.deps.findSession(m.provider,m.id);
        if(!session){this.post(client,{type:'error',message:'That session is gone.'});return;}
        const snap=await this.deps.lookup();
        const d=defaultTurnOptions(session.provider);
        // Options only carry over within one provider: one provider's models aren't another's.
        const sameProvider=(client.draft?.provider??client.session?.provider)===session.provider;
        // Re-selecting the session already open (the bridge does this on every reconnect) must not clear the queue
        // — and ANOTHER session's queue also stays where it is.
        Object.assign(client,{session,draft:undefined,queue:this.queueFor(session),
          workspace:snap.workspaces.find(w=>w.id===session.workspaceId),
          project:snap.projects.find(p=>p.id===session.projectId),
          model:session.model??(sameProvider?(client.model??d.model):d.model),
          effort:session.effort??(sameProvider?(client.effort??d.effort):d.effort)});
        this.deps.onSelection?.(session);
        await this.pushSession(client);return;
      }
      if(m.type==='loadOlder'){
        if(!client.session)return;
        if(client.shown)client.shown.n+=MOBILE_PAGE;
        await this.pushSession(client,true);return;
      }
      if(m.type==='openProject'){
        const snap=await this.deps.lookup();
        const project=snap.projects.find(p=>p.id===m.projectId);
        const workspace=project&&snap.workspaces.find(w=>w.id===project.workspaceId);
        if(!project||!workspace){this.post(client,{type:'error',message:'That project is gone.'});return;}
        return this.newDraft(client,workspace,project,this.providerOf(client));
      }
      if(m.type==='switchAccount'){
        const project=(await this.deps.lookup()).projects.find(p=>p.id===m.projectId);
        if(!project){this.post(client,{type:'error',message:'That project is gone.'});return;}
        if(!this.deps.accounts?.label(project.rootPath)){this.post(client,{type:'error',message:'Set devHub.claude.altAccountFile on the host first.'});return;}
        const r=await this.deps.accounts.toggle(project.rootPath,project.name);
        // `error` is chat.js's only text channel; on a successful switch the bridge reopens the sheet as confirmation.
        if(r.level!=='info'){this.post(client,{type:'error',message:r.message});return;}
        this.post(client,{type:'accountSwitched',projectId:project.id,message:r.message});return;
      }
      if(m.type==='newTab'){
        if(client.workspace&&client.project)return this.newDraft(client,client.workspace,client.project,this.providerOf(client));
        this.post(client,{type:'error',message:'Pick a project first.'});return;
      }
      if(m.type==='setProvider'){
        if(client.workspace&&client.project)return this.newDraft(client,client.workspace,client.project,m.provider);
        this.post(client,{type:'error',message:'Pick a project first.'});return;
      }
      if(m.type==='setOption'){
        if(m.kind==='model')client.model=m.value;else client.effort=m.value;
        // Like the panel: the choice is tied to the session, so it shows wherever it is reopened, even before any turn.
        if(client.session)client.session=await this.deps.manager.setTurnOptions(client.session,{model:client.model,effort:client.effort});
        this.postOptions(client);return;
      }
      if(m.type==='dequeue'){
        const i=Number(m.index);
        if(Number.isInteger(i)&&i>=0&&i<client.queue.length){client.queue.splice(i,1);this.postQueue(client);}
        return;
      }
      if(m.type==='permissionResponse'){this.settlePerm(m.requestId,m.allow,m.answers,false,client);return;}
      if(m.type==='pasteImage'){
        try{await this.saveAttachment(client,m.mime,m.data,m.requestId);}
        catch{this.post(client,{type:'attachmentError',requestId:m.requestId,message:'Could not save the image. Please pick it again.'});}
        return;
      }
      if(m.type==='cancel'){
        if(!client.session)return;
        await this.deps.manager.cancel(client.session.provider,client.session.nativeSessionId);
        return;
      }
      if(m.type==='compact')return await this.compact(client);
      if(m.type==='sendPrompt')return await this.sendPrompt(client,m);
      // `openFile`/`openLink`/`back`/`pick*` are handled by the bridge in the browser.
    }catch(e:any){this.post(client,{type:'error',message:e?.message||String(e)});}
  }

  private newDraft(client:Client,workspace:DevHubWorkspace,project:DevHubProject,provider:ProviderId){
    const draft:Draft={workspace,project,provider};
    const d=defaultTurnOptions(provider);
    Object.assign(client,{draft,session:undefined,workspace,project,model:d.model,effort:d.effort,queue:[]});
    this.post(client,{type:'draftSelected',draft,events:[]});
    this.postOptions(client);this.postQueue(client);this.refreshScm(client);
  }

  private async sendPrompt(client:Client,m:any){
    const text=String(m.text||'').trim();
    const images=m.attachments;
    const foreign=foreignAttachment(images,this.attachmentDir());
    if(foreign){this.post(client,{type:'error',message:`Refused an attachment outside the Dev Hub attachment folder: ${foreign}`});return;}
    if(!text&&!images?.length)return;
    if(client.session){
      const session=client.session;
      if(session.status==='running'||this.deps.manager.isBusy(session.provider,session.nativeSessionId)){
        client.queue.push({text,images});this.postQueue(client);return;
      }
      // Like the panel: `queue.length` must not be a reason to keep queuing, or one failed resume
      // locks the queue forever (there's no sessionUpdated for scheduleFlush to hook onto).
      let head:QueuedPrompt={text,images};
      if(client.queue.length){client.queue.push(head);head=client.queue.shift()!;this.postQueue(client);}
      // The page cleared the input on send; a failed send that doesn't put the message back in the queue loses the text.
      try{
        client.session=await this.deps.manager.resume(session,head.text,{model:client.model,effort:client.effort,images:head.images});
      }catch(e){client.queue.unshift(head);this.postQueue(client);throw e;}
      this.deps.onSelection?.(client.session);
      await this.pushSession(client);
      return;
    }
    if(!client.draft){this.post(client,{type:'error',message:'Pick a session or a project first.'});return;}
    // Pressing Enter twice before the session exists would create two sessions.
    if(client.starting){client.queue.push({text,images});this.postQueue(client);return;}
    // If the previous start failed, the queue still holds the old message and there is no session to flush into yet.
    // Sending the new message directly would reorder them — queue it at the end, then run the head of the queue.
    let head:QueuedPrompt={text,images};
    if(client.queue.length){client.queue.push(head);head=client.queue.shift()!;this.postQueue(client);}
    client.starting=true;
    try{
      const d=client.draft;
      const s=await this.deps.manager.start({provider:d.provider,workspaceId:d.workspace.id,projectId:d.project.id,
        cwd:d.project.rootPath,prompt:head.text,model:client.model,effort:client.effort,images:head.images});
      const session=this.rekeyedSession(s.provider,s.nativeSessionId)??s;
      this.sessionQueues.set(this.sessionKey(session.provider,session.nativeSessionId),client.queue);
      client.session=session;client.workspace=d.workspace;client.project=d.project;client.draft=undefined;
      this.deps.onSelection?.(session);
      this.post(client,{type:'sessionSelected',session,
        events:(this.buffers.get(this.sessionKey(session.provider,session.nativeSessionId))??[]).map(e=>this.forWeb(e)),
        workspace:client.workspace,project:client.project});
    }catch(e){client.queue.unshift(head);this.postQueue(client);throw e;}
    finally { client.starting=false; }
  }

  /** Claude compacts with a real slash command; the planner has no compaction. */
  private async compact(client:Client){
    const session=client.session;
    if(!session){this.post(client,{type:'error',message:'Nothing to compact yet — send a message first.'});return;}
    if(session.status==='running'){this.post(client,{type:'error',message:'Wait for the current turn to finish before compacting.'});return;}
    if(session.provider==='claude'){
      client.session=await this.deps.manager.resume(session,'/compact',{model:client.model,effort:client.effort});
      this.deps.onSelection?.(client.session);
      return;
    }
    this.post(client,{type:'error',message:`${providerLabel(session.provider)} sessions have no compaction.`});
  }

  // ---------- attached images ----------
  private attachmentDir(){return nodePath.join(this.deps.storageDir||require('node:os').tmpdir(),'devhub','attachments');}
  private async saveAttachment(client:Client,mime:string,b64:string,requestId?:string){
    const dir=this.attachmentDir();
    await fsp.mkdir(dir,{recursive:true});
    const file=nodePath.join(dir,`${Date.now()}-${crypto.randomUUID().slice(0,8)}.${EXT[mime]||'png'}`);
    await fsp.writeFile(file,Buffer.from(b64,'base64'));
    this.post(client,{type:'attachment',path:file,...(requestId?{requestId}:{})});
  }
  private async pruneAttachments(){
    try{
      const dir=this.attachmentDir();const now=Date.now();
      for(const name of await fsp.readdir(dir)){
        const f=nodePath.join(dir,name);
        try{const st=await fsp.stat(f);if(now-st.mtimeMs>ATTACHMENT_TTL_MS)await fsp.rm(f,{force:true});}catch{}
      }
    }catch{}
  }

  // ---------- events from the manager ----------
  private sessionKey(p:string,id:string){return `sess:${p}:${id}`;}
  private rekeyedSession(provider:string,id:string):DevHubSession|undefined{
    const key=this.sessionKey(provider,id),hit=this.recentRekeys.get(key);
    if(!hit)return undefined;
    if(hit.expiresAt<=Date.now()){this.recentRekeys.delete(key);return undefined;}
    return hit.session;
  }
  private onEvent(x:any){
    const key=this.sessionKey(x.provider,x.sessionId);
    if(x.event.type==='thinking'){
      for(const c of this.clientsFor(x.provider,x.sessionId))this.post(c,{type:'event',sessionId:x.sessionId,event:x.event});
      return;
    }
    this.buffers.append(key,x.event,(previous,next)=>previous?.type==='assistant_delta'&&next?.type==='assistant_delta'?{...next,text:previous.text+next.text}
      // A later view frame CONTAINS the previous one; keeping both duplicates one answer 30 times in the cache.
      :previous?.type==='assistant_view'&&next?.type==='assistant_view'?next:undefined);
    for(const c of this.clientsFor(x.provider,x.sessionId)){
      if(x.event.type==='assistant_delta')c.batcher.push({sessionId:x.sessionId,event:x.event});
      else{c.batcher.flush();this.post(c,{type:'event',sessionId:x.sessionId,event:this.forWeb(x.event)});}
    }
  }
  // Stop only kills the running turn: the session's queue lives on and `sessionUpdated`
  // ('cancelled') flushes it — exactly like the panel; both front-ends share one queue.
  private onSessionUpdated(s:DevHubSession){
    if(s.status!=='running')this.closePerms(s.provider,s.nativeSessionId,'the turn ended');
    for(const c of this.clientsFor(s.provider,s.nativeSessionId)){
      c.session=s;this.post(c,{type:'sessionUpdated',session:s});
      if(s.status!=='running')this.scheduleFlush(c);
    }
  }
  private onRekey(x:any){
    if(x?.provider&&x?.oldId&&x?.session){
      // An alias is only removed when someone looks up that exact key; sweep on insert so the map doesn't grow with
      // the number of rekeys on a long-running server.
      const now=Date.now();
      for(const [k,v] of this.recentRekeys)if(v.expiresAt<=now)this.recentRekeys.delete(k);
      this.recentRekeys.set(this.sessionKey(x.provider,x.oldId),{session:x.session,expiresAt:now+REKEY_ALIAS_TTL_MS});
    }
    this.buffers.move(this.sessionKey(x.provider,x.oldId),this.sessionKey(x.provider,x.newId));
    const q=this.sessionQueues.get(this.sessionKey(x.provider,x.oldId));
    if(q){this.sessionQueues.delete(this.sessionKey(x.provider,x.oldId));this.sessionQueues.set(this.sessionKey(x.provider,x.newId),q);}
    for(const c of this.clientsFor(x.provider,x.oldId)){c.session=x.session;this.post(c,{type:'sessionUpdated',session:x.session});}
  }
  /**
   * `SessionManager.consume` removes the session from `active` in its `finally`, i.e. AFTER emitting
   * `sessionUpdated`. Sending right inside the handler hits `claim()` and gets refused, so it must be deferred.
   */
  private scheduleFlush(client:Client){
    if(!client.queue.length||client.flushing)return;
    client.flushing=true;
    const t:any=setTimeout(()=>{void this.flushQueue(client).finally(()=>{client.flushing=false;});},0);
    t.unref?.();
  }
  private async flushQueue(client:Client){
    const session=client.session;
    if(!session||session.status==='running'||!client.queue.length)return;
    if(!this.clients.has(client.id))return;
    if(this.deps.manager.isBusy(session.provider,session.nativeSessionId))return;
    const next=client.queue.shift()!;
    this.postQueue(client);
    try{
      client.session=await this.deps.manager.resume(session,next.text,{model:client.model,effort:client.effort,images:next.images});
      this.deps.onSelection?.(client.session);
    }catch(e:any){
      client.queue.unshift(next);this.postQueue(client);
      this.post(client,{type:'error',message:e?.message||String(e)});
    }
  }

  // ---------- permission approval ----------
  /** `false` = no client holds this session; the caller moves on to the panel. */
  showPermission(provider:string,sessionId:string,req:any):boolean{
    const targets=this.clientsFor(provider,sessionId);
    if(!targets.length)return false;
    const id=String(req?.requestId||'');
    // Without a requestId it can't be answered; accepting it would leave the CLI waiting forever.
    if(!id)return false;
    const ms=req.requiresUserInteraction||req.toolName==='AskUserQuestion'?ASK_TIMEOUT_MS:PERM_TIMEOUT_MS;
    const timer:any=setTimeout(()=>{const p=this.pendingPerms.get(id);if(p)this.closeCard(p,id,'expired');this.settlePerm(id,false,undefined,true);},ms);
    timer.unref?.();
    this.pendingPerms.set(id,{provider,sessionId,timer,input:req.input,req});
    this.deps.onChanged?.();
    for(const c of targets)this.post(c,{type:'permission',request:req});
    return true;
  }
  private settlePerm(requestId:string,allow:boolean,answers?:Record<string,string>,expired?:boolean,from?:Client){
    const p=this.pendingPerms.get(requestId); if(!p)return;
    clearTimeout(p.timer);this.pendingPerms.delete(requestId);
    // The same session may be open on several devices. Whoever taps first, the cards on the other
    // devices must die with it — left open they keep asking a question that already has an answer, and tapping
    // again only reaches an empty `settlePerm`, silently.
    if(!expired)for(const c of this.clientsFor(p.provider,p.sessionId))
      if(c!==from)this.post(c,{type:'permissionClosed',requestId,note:allow?'allowed on another device':'denied on another device'});
    if(expired)this.noteDenied(p.provider,p.sessionId,`${p.req?.displayName||p.req?.toolName||'A tool'} request expired without an answer and was denied.`);
    const updatedInput=answers?{...(p.input||{}),answers}:undefined;
    this.deps.answerPermission(p.provider,p.sessionId,requestId,allow,updatedInput);
    this.deps.onChanged?.();
  }
  /** See `ChatPanelProvider.isAwaitingPermission` — the same question, two hosts. */
  isAwaitingPermission(provider:string,sessionId:string){
    for(const [,p] of this.pendingPerms)if(p.provider===provider&&p.sessionId===sessionId)return true;
    return false;
  }
  private replayPerms(client:Client){
    const id=client.session?.nativeSessionId; if(!id)return;
    const provider=this.providerOf(client);
    for(const [,p] of this.pendingPerms)
      if(p.provider===provider&&p.sessionId===id&&p.req)this.post(client,{type:'permission',request:p.req});
  }
  private closeCard(p:{provider:string;sessionId:string},requestId:string,note:string){
    for(const c of this.clientsFor(p.provider,p.sessionId))this.post(c,{type:'permissionClosed',requestId,note});
  }
  private closePerms(provider:string,sessionId:string,note:string){
    for(const [id,p] of [...this.pendingPerms]){
      if(p.provider!==provider||p.sessionId!==sessionId)continue;
      this.closeCard(p,id,note);this.settlePerm(id,false);
    }
  }
  private noteDenied(provider:string,sessionId:string,message:string){
    const event={type:'warning',message,timestamp:Date.now()} as DevHubEvent;
    this.buffers.append(this.sessionKey(provider,sessionId),event);
    for(const c of this.clientsFor(provider,sessionId))this.post(c,{type:'event',sessionId,event});
  }
  private denyPermsFor(provider:string,sessionId?:string){
    for(const [id,p] of [...this.pendingPerms])
      if(p.provider===provider&&(!sessionId||p.sessionId===sessionId)){
        // Another client still holds this session, so don't deny on its behalf.
        if(this.clientsFor(p.provider,p.sessionId).length)continue;
        this.settlePerm(id,false);
      }
  }
}
