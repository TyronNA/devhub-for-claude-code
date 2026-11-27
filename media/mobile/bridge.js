/**
 * Cầu nối cho web app mobile: giả lập API webview của VS Code để `chat.js` chạy nguyên xi.
 * Xuống dùng SSE, lên dùng POST. Phải nạp TRƯỚC `chat.js` — file đó gọi
 * `acquireVsCodeApi()` ngay dòng đầu.
 *
 * Ngoài transport, đây còn là chỗ duy nhất khác biệt về UI: mấy message `pick*` của webview
 * vốn mở QuickPick của workbench, trên điện thoại thì không có gì mở — nên chặn lại tại đây,
 * dựng sheet chọn, rồi gửi giá trị ĐÃ chọn cho server.
 */
(function(){
  var clientId=null, outbox=[], sse=null, retry=0, restoring=null, restorePhase='', restoreProjectId=null;
  var lastProjectId=null;
  /** Session đang mở, dạng `provider|id` — chỉ dùng để tô dòng đang xem trong drawer. */
  var curSid=null;
  /** Bản git mới nhất server đẩy xuống — sheet 'Changed files' đọc từ đây. */
  var lastScm=null;
  var LAST='devhub.mobile.lastSession';

  function inbound(payload){ window.postMessage(payload,'*'); }

  var msgSeq=0;
  function POST(msg){
    if(msg&&typeof msg==='object'&&!msg.__id)msg.__id=Date.now().toString(36)+'-'+(++msgSeq)+'-'+Math.random().toString(36).slice(2,8);
    if(!clientId){outbox.push(msg);return;}
    fetch('/api/msg?c='+encodeURIComponent(clientId),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg)})
      // 409 = server đã quên client này (restart/ngủ). Nối lại rồi gửi lại, đừng nuốt.
      .then(function(r){if(r.status===409){clientId=null;outbox.push(msg);connect();}})
      .catch(function(){clientId=null;outbox.push(msg);connect();});
  }
  function flush(){var q=outbox;outbox=[];for(var i=0;i<q.length;i++)POST(q[i]);}
  function doneRestoring(){if(restoring)clearTimeout(restoring);restoring=null;restorePhase='';restoreProjectId=null;flush();}
  function rememberSession(session,project){
    if(project&&project.id)lastProjectId=project.id;
    var item={provider:session.provider,id:session.nativeSessionId};
    if(lastProjectId)item.projectId=lastProjectId;
    try{localStorage.setItem(LAST,JSON.stringify(item));}catch(e){}
  }

  function connect(){
    if(sse){try{sse.close();}catch(e){}}
    sse=new EventSource('/api/stream');
    sse.onmessage=function(ev){
      var x; try{x=JSON.parse(ev.data);}catch(e){return;}
      if(x.type==='hello'){
        // Server đã lên bản khác mà trang vẫn chạy JS cũ (PWA chỉ nối lại SSE): nạp lại, một lần mỗi bản.
        var mine='';try{var meta=document.querySelector('meta[name="devhub-build"]');mine=meta?meta.getAttribute('content'):'';}catch(e){}
        if(x.build&&mine&&x.build!==mine){var tried='';try{tried=sessionStorage.getItem('devhub.reloadFor')||'';}catch(e){}
          if(tried!==x.build){try{sessionStorage.setItem('devhub.reloadFor',x.build);}catch(e){}location.reload();return;}}
        clientId=x.clientId; retry=0;
        // Client mới ở server là một tab trắng; gắn lại session cũ TRƯỚC khi xả outbox.
        var last=null; lastProjectId=null; try{last=JSON.parse(localStorage.getItem(LAST)||'null');}catch(e){}
        if(!(last&&last.provider&&last.id)){flush();return;}
        // Chờ server xác nhận rồi mới xả: flush ngay là đua với chính openSession vừa gửi.
        if(restoring)clearTimeout(restoring);
        lastProjectId=last.projectId||null; restoreProjectId=lastProjectId; restorePhase='session';
        restoring=setTimeout(doneRestoring,5000);
        POST({type:'openSession',provider:last.provider,id:last.id});
        return;
      }
      if(restoring&&x.type==='error'){
        if(restorePhase==='session'&&restoreProjectId&&x.message==='That session is gone.'){
          restorePhase='project'; POST({type:'openProject',projectId:restoreProjectId}); return;
        }
        // Hết đường gắn lại: vẫn phải xả outbox. Bỏ qua là tin xếp lúc mất mạng nằm lại
        // tới lần reconnect sau mới bắn ra — trễ và sai ngữ cảnh hơn là báo lỗi ngay.
        doneRestoring();
      }
      if(restoring&&(x.type==='sessionSelected'||x.type==='draftSelected'||x.type==='empty'))doneRestoring();
      if(x.type==='sessionSelected'&&x.session){
        rememberSession(x.session,x.project);
      }
      if(x.type==='sessionUpdated'&&x.session){
        rememberSession(x.session);
      }
      if((x.type==='sessionSelected'||x.type==='sessionUpdated')&&x.session)curSid=x.session.provider+'|'+x.session.nativeSessionId;
      if(x.type==='draftSelected')curSid=null;
      if(x.type==='scm')lastScm=x.status||null;
      if(x.type==='accountSwitched'){pickAccount('\u2713 '+(x.message||''));return;}
      inbound(x);
    };
    sse.onerror=function(){
      clientId=null;
      // EventSource tự nối lại, nhưng chỉ khi ống chưa đóng hẳn; đóng hẳn thì tự lo.
      if(sse&&sse.readyState===2){retry=Math.min(retry+1,6);setTimeout(connect,Math.pow(2,retry)*250);}
    };
  }

  // ---------- sheet chọn ----------
  var sheet=null;
  function closeSheet(){var s=document.getElementById('sheet');if(!s)return;s.hidden=true;s.textContent='';sheet=null;}
  /** Dưới ngưỡng này thì ô lọc chỉ chiếm chỗ; trên nó thì cuộn tay qua 40 repo mới là cái tốn. */
  var FILTER_MIN=8;
  /** `stacked`: dòng hai tầng, dành cho danh sách mà chú thích dài (session), chứ không cho
   *  project — ở đó chú thích chỉ là tên workspace và một tầng vừa gấp đôi số dòng thấy được. */
  /** `note`: một dòng chữ trên danh sách — chat.js không có toast, đây là chỗ báo kết quả vừa bấm. */
  function openSheet(title,items,onPick,stacked,note){
    var s=document.getElementById('sheet'); if(!s)return;
    s.textContent=''; s.hidden=false; sheet=s;
    var box=document.createElement('div'); box.className='sheet-box';
    var head=document.createElement('div'); head.className='sheet-head';
    head.appendChild(document.createTextNode(title));
    var x=document.createElement('button'); x.className='sheet-x'; x.textContent='✕';
    x.onclick=closeSheet; head.appendChild(x); box.appendChild(head);
    var list=document.createElement('div'); list.className='sheet-list';
    if(note){var n=document.createElement('div');n.className='sheet-empty';n.textContent=note;list.appendChild(n);}
    if(!items.length){var e=document.createElement('div');e.className='sheet-empty';e.textContent='Nothing here yet.';list.appendChild(e);}
    var rows=[];
    for(var i=0;i<items.length;i++)(function(it){
      var row=document.createElement('button'); row.className=stacked?'sheet-row stacked':'sheet-row';
      var main=document.createElement('span'); main.className='sheet-label'; main.textContent=it.label;
      row.appendChild(main);
      if(it.description){var d=document.createElement('span');d.className='sheet-desc';d.textContent=it.description;row.appendChild(d);}
      row.onclick=function(){closeSheet();onPick(it);};
      // Lọc cả description: repo hay được nhớ theo workspace ("acme") chứ không theo tên đầy đủ.
      rows.push({el:row,hay:(it.label+' '+(it.description||'')).toLowerCase()});
      list.appendChild(row);
    })(items[i]);
    if(items.length>=FILTER_MIN)box.appendChild(filterBar(rows,list));
    box.appendChild(list); s.appendChild(box);
    s.onclick=function(ev){if(ev.target===s)closeSheet();};
  }
  /**
   * Ô lọc của sheet. Mỗi từ khoá phải khớp ĐỘC LẬP (gõ "chat admin" ra order-chatbot-admin),
   * vì tên repo dài thì thứ người ta nhớ là hai mảnh rời chứ không phải một chuỗi liền.
   * WebKit 279904: trong PWA cài ra home screen, tap input KHÔNG bật bàn phím — nên đây là
   * tiện ích cho tab Safari, không phải đường duy nhất tới một dòng (cuộn vẫn còn).
   */
  function filterBar(rows,list){
    var wrap=document.createElement('div'); wrap.className='sheet-filter';
    var input=document.createElement('input'); input.type='text'; input.className='sheet-input';
    input.placeholder='Filter…'; input.setAttribute('autocapitalize','none');
    input.setAttribute('autocorrect','off'); input.setAttribute('spellcheck','false');
    var none=document.createElement('div'); none.className='sheet-empty'; none.textContent='No match.'; none.hidden=true;
    input.oninput=function(){
      var terms=input.value.toLowerCase().split(/\s+/).filter(Boolean), shown=0;
      for(var i=0;i<rows.length;i++){
        var ok=true;
        for(var t=0;t<terms.length;t++)if(rows[i].hay.indexOf(terms[t])<0){ok=false;break;}
        rows[i].el.hidden=!ok; if(ok)shown++;
      }
      none.hidden=shown>0; list.scrollTop=0;
    };
    var clear=document.createElement('button'); clear.className='sheet-clear'; clear.type='button'; clear.textContent='✕';
    clear.onclick=function(){input.value='';input.oninput();};
    wrap.appendChild(input); wrap.appendChild(clear); wrap.appendChild(none);
    return wrap;
  }
  function choices(kind){
    return fetch('/api/choices?kind='+encodeURIComponent(kind)+'&c='+encodeURIComponent(clientId||''))
      .then(function(r){return r.json();}).then(function(x){return x.items||[];}).catch(function(){return [];});
  }

  function pickOption(kind){
    choices(kind).then(function(items){
      var rows=[{label:'Default',value:''}].concat(items,[{label:'Custom…',value:'__custom__'}]);
      openSheet(kind,rows,function(it){
        var v=it.value;
        if(v==='__custom__'){v=window.prompt(kind+' value')||'';v=v.trim();if(!v)return;}
        POST({type:'setOption',kind:kind,value:v||undefined});
      });
    });
  }
  function pickProvider(){
    choices('provider').then(function(items){
      openSheet('Provider',items,function(it){POST({type:'setProvider',provider:it.value});});
    });
  }
  function pickSlash(){
    choices('slash').then(function(items){
      if(!items.length){inbound({type:'error',message:'Slash commands are read from the CLI on its first turn — send one message, then try again.'});return;}
      openSheet('Slash command',items,function(it){inbound({type:'insertText',text:it.value});});
    });
  }
  function state(){return fetch('/api/sessions').then(function(r){return r.json();});}
  function pickProject(){
    state().then(function(s){
      var byWs={}; for(var i=0;i<s.workspaces.length;i++)byWs[s.workspaces[i].id]=s.workspaces[i].name;
      var items=s.projects.map(function(p){return {label:p.name,description:byWs[p.workspaceId]||p.rootPath,value:p.id};});
      // `account` chỉ có khi host đặt altAccountFile; không có thì không hiện lối vào.
      var hasAcct=s.projects.some(function(p){return !!p.account;});
      if(hasAcct)items.unshift({label:'\u21C4 Claude account\u2026',value:'__account__'});
      openSheet('Project',items,function(it){
        if(it.value==='__account__'){pickAccount();return;}
        POST({type:'openProject',projectId:it.value});
      });
    });
  }
  /** Bản mobile của `Switch Claude Account`: chạm một project là đảo acc của nó, như lệnh desktop. */
  function pickAccount(note){
    state().then(function(s){
      var byWs={}; for(var i=0;i<s.workspaces.length;i++)byWs[s.workspaces[i].id]=s.workspaces[i].name;
      var items=s.projects.filter(function(p){return !!p.account;}).map(function(p){
        return {label:p.name,description:p.account+' \u00B7 '+(byWs[p.workspaceId]||p.rootPath),value:p.id};});
      openSheet('Claude account',items,function(it){POST({type:'switchAccount',projectId:it.value});},false,note);
    });
  }
  function ago(ms){var d=Date.now()-ms;var m=Math.round(d/60000);
    if(m<1)return 'just now'; if(m<60)return m+'m ago';
    var h=Math.round(m/60); if(h<24)return h+'h ago'; return Math.round(h/24)+'d ago';}
  function openPicked(it){
    var i=it.value.indexOf('|');
    POST({type:'openSession',provider:it.value.slice(0,i),id:it.value.slice(i+1)});
  }
  function sessionItems(list){
    return list.map(function(x){
      return {label:x.title,description:x.projectName+' · '+x.provider+' · '+x.status+' · '+ago(x.updatedAt),
              value:x.provider+'|'+x.nativeSessionId};
    });
  }
  // ---------- drawer lịch sử ----------
  /**
   * Lịch sử là ngăn kéo mép trái chứ không phải bottom sheet như mấy picker khác: đây là thứ
   * bấm nhiều nhất trên điện thoại, và vuốt tới được bằng ngón đang giữ máy — nút 🕓 thì nằm
   * tận đỉnh header. Dòng dùng lại đúng class `sheet-*` để không sinh bảng màu thứ hai.
   */
  var drawer=null,dScrim=null,dBox=null,dOpen=false,dHide=null;
  function dcls(open,drag){if(drawer)drawer.className=(open?'open':'')+(drag?' dragging':'');}
  function buildDrawer(){
    drawer=document.createElement('div'); drawer.id='drawer'; drawer.hidden=true;
    dScrim=document.createElement('div'); dScrim.className='scrim'; drawer.appendChild(dScrim);
    dBox=document.createElement('div'); dBox.className='drawer-box'; drawer.appendChild(dBox);
    drawer.onclick=function(ev){if(ev.target===dScrim)settle(false);};
    document.body.appendChild(drawer);
  }
  function showDrawer(){if(!drawer)buildDrawer();if(dHide){clearTimeout(dHide);dHide=null;}drawer.hidden=false;}
  /** Chỉ chốt trạng thái; không fetch lại — kéo tay gọi hàm này ở lúc nhả ngón. */
  function settle(open){
    if(!drawer)return;
    dcls(open,false); dBox.style.transform=''; drawer.style.removeProperty('--d-op'); dOpen=open;
    // Ẩn hẳn sau khi trượt xong: scrim trong suốt vẫn ăn tap nếu để nguyên trong DOM.
    if(!open)dHide=setTimeout(function(){dHide=null;if(!dOpen)drawer.hidden=true;},220);
  }
  function drawerHead(){
    var head=document.createElement('div'); head.className='sheet-head';
    head.appendChild(document.createTextNode('History'));
    var nu=document.createElement('button'); nu.className='sheet-x'; nu.textContent='+'; nu.title='New chat';
    nu.onclick=function(){settle(false);POST({type:'newTab'});};
    head.appendChild(nu); return head;
  }
  /**
   * MỌI session, không lọc theo project: trên điện thoại ngăn kéo này là cách duy nhất nhảy
   * ngang giữa các repo (không có cây bên trái), mà lọc theo project thì đúng cái đó bị chặn.
   * Danh sách đã sắp theo lần sửa gần nhất ở host, và mỗi dòng tự mang tên project.
   */
  function fillDrawer(){
    if(!drawer)buildDrawer();
    return state().then(function(s){
      var items=sessionItems(s.sessions),rows=[];
      var list=document.createElement('div'); list.className='sheet-list';
      if(!items.length){var e=document.createElement('div');e.className='sheet-empty';e.textContent='Nothing here yet.';list.appendChild(e);}
      for(var i=0;i<items.length;i++)(function(it){
        var row=document.createElement('button'); row.className='sheet-row stacked'+(it.value===curSid?' on':'');
        var main=document.createElement('span'); main.className='sheet-label'; main.textContent=it.label; row.appendChild(main);
        var d=document.createElement('span'); d.className='sheet-desc'; d.textContent=it.description; row.appendChild(d);
        row.onclick=function(){settle(false);openPicked(it);};
        rows.push({el:row,hay:(it.label+' '+(it.description||'')).toLowerCase()});
        list.appendChild(row);
      })(items[i]);
      dBox.textContent='';
      dBox.appendChild(drawerHead());
      if(items.length>=FILTER_MIN)dBox.appendChild(filterBar(rows,list));
      dBox.appendChild(list);
    }).catch(function(){});
  }
  function pickHistory(){showDrawer();fillDrawer();settle(true);}

  /**
   * Kéo từ mép trái để mở, kéo ngược để đóng. Chỉ nhận khi ngón đi ngang hơn dọc: trong khung
   * chat có khối code cuộn ngang được, và cuộn dọc thì tuyệt đối không được đụng.
   * Chú ý: trong tab Safari, gesture mép trái là "back" của trình duyệt và nó thắng — chỉ PWA
   * cài ra home screen mới ăn chắc, nên nút 🕓 vẫn là đường vào chính thức.
   */
  // Vuốt nhẹ (flick) ăn ngay theo hướng ngón, không cần kéo hết nửa khung; ngưỡng vị trí chỉ
  // dùng khi ngón dừng hẳn rồi mới nhả, và đo theo QUÃNG đã kéo nên đóng cũng nhẹ như mở.
  var EDGE=28,AXIS=8,FLICK=0.25,gid=null,gx0=0,gy0=0,gLock=0,gW=0,gDx=0,gVx=0,gPx=0,gPt=0;
  function boxW(){return (dBox&&dBox.offsetWidth)||Math.min(340,Math.round((window.innerWidth||360)*0.82));}
  function onStart(e){
    gid=null; if(sheet||!e.touches||e.touches.length!==1)return;
    var t=e.touches[0]; if(!dOpen&&t.clientX>EDGE)return;
    gid=t.identifier; gx0=t.clientX; gy0=t.clientY; gLock=0; gDx=0; gVx=0; gPx=t.clientX; gPt=e.timeStamp||Date.now();
  }
  function onMove(e){
    if(gid===null)return;
    var t=e.touches&&e.touches[0]; if(!t)return;
    var dx=t.clientX-gx0,dy=t.clientY-gy0;
    if(!gLock){
      if(Math.abs(dx)<AXIS&&Math.abs(dy)<AXIS)return;
      if(Math.abs(dx)<=Math.abs(dy)){gid=null;return;}
      gLock=1; if(!dOpen){showDrawer();fillDrawer();}
      gW=boxW(); dcls(dOpen,true);
    }
    if(e.cancelable)e.preventDefault();
    // Mẫu vận tốc cách nhau >8ms: hai điểm sát nhau chia ra số vô nghĩa, và ngón dừng lại
    // thì gVx cũng phải tụt về 0 chứ không giữ tốc độ cũ.
    var now=e.timeStamp||Date.now(),dt=now-gPt; if(dt>8){gVx=(t.clientX-gPx)/dt; gPx=t.clientX; gPt=now;}
    gDx=dOpen?Math.max(-gW,Math.min(0,dx)):Math.max(0,Math.min(gW,dx));
    var at=(dOpen?gW:0)+gDx;
    dBox.style.transform='translateX('+(at-gW)+'px)';
    drawer.style.setProperty('--d-op',String(at/gW));
  }
  function onEnd(){
    if(gid===null)return; var locked=gLock; gid=null; gLock=0;
    if(!locked)return;
    if(Math.abs(gVx)>FLICK){settle(gVx>0);return;}
    settle(dOpen?gDx>-gW*0.35:gDx>gW*0.35);
  }
  document.addEventListener('touchstart',onStart,{passive:true});
  document.addEventListener('touchmove',onMove,{passive:false});
  document.addEventListener('touchend',onEnd,{passive:true});
  document.addEventListener('touchcancel',onEnd,{passive:true});

  var IMG=/\.(png|jpe?g|gif|webp)$/i;
  function openPath(p){
    if(!IMG.test(p)){inbound({type:'error',message:'Opening files is a desktop thing — this is '+p});return;}
    window.open('/api/file?p='+encodeURIComponent(btoa(unescape(encodeURIComponent(p))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')),'_blank');
  }

  // Message do bridge tự xử; phần còn lại đi thẳng ra server.
  /**
   * Chip git bấm được trên desktop thì mở file; ở đây mở file là chuyện không có thật
   * (xem `openPath`), nên sheet này CHỈ để đọc — danh sách file kèm +/-, chạm thì đóng lại.
   */
  function pickChanged(){
    var cs=(lastScm&&lastScm.changes)||[];
    openSheet('Changed files',cs.map(function(c){
      return {label:c.path,description:c.untracked?'untracked':'+'+c.added+' \u2212'+c.removed};
    }),function(){});
  }
  /**
   * Clipboard phải là của MÁY ĐANG XEM. Đẩy qua host thì ID rơi vào clipboard của máy chạy
   * VS Code, còn cái điện thoại đang cầm thì không có gì.
   */
  function copySessionId(){
    var id=(curSid||'').split('|')[1]||'';
    if(!id){inbound({type:'error',message:'No session yet.'});return;}
    // Không có toast trong chat.js; đổi nhãn chính nút vừa bấm là phản hồi rẻ nhất mà thấy được.
    var btn=document.getElementById('copyid');
    var ok=function(){if(!btn)return;btn.textContent='\u2713';setTimeout(function(){btn.textContent='ID';},1200);};
    try{
      // navigator.clipboard chỉ có trên secure context; LAN thì là http trần, nên phải có đường lùi.
      if(navigator.clipboard&&navigator.clipboard.writeText)
        navigator.clipboard.writeText(id).then(ok,function(){prompt('Session ID',id);});
      else prompt('Session ID',id);
    }catch(e){prompt('Session ID',id);}
  }
  var LOCAL={pickProvider:pickProvider,pickProject:pickProject,pickHistory:pickHistory,pickModel:function(){pickOption('model');},
             pickEffort:function(){pickOption('effort');},pickSlash:pickSlash,pickChanged:pickChanged,copySessionId:copySessionId};

  window.acquireVsCodeApi=function(){
    return {
      postMessage:function(msg){
        if(!msg||typeof msg!=='object')return;
        if(LOCAL[msg.type]){LOCAL[msg.type]();return;}
        // href đến từ markdown do agent sinh ra: chỉ http(s), y như host lọc ở webviewProtocol.
        if(msg.type==='openLink'){
          if(/^https?:\/\//i.test(String(msg.href||'')))window.open(msg.href,'_blank','noopener');
          else inbound({type:'error',message:'Refused to open a non-http link: '+String(msg.href||'').slice(0,200)});
          return;
        }
        if(msg.type==='openFile'){openPath(msg.path);return;}
        POST(msg);
      },
      // `chat.js` dùng chỗ này để giữ nháp qua lần reload; localStorage là bản mobile của nó.
      getState:function(){try{return JSON.parse(localStorage.getItem('devhub.mobile.state')||'null');}catch(e){return null;}},
      setState:function(v){try{localStorage.setItem('devhub.mobile.state',JSON.stringify(v));}catch(e){}}
    };
  };
  // `?vv=1`: iPhone ở đây không cắm Web Inspector được, nên in số đo thẳng lên màn hình. Đây là
  // thứ duy nhất phân biệt được "hụt canvas" với "bị pan" — hai cái nhìn bằng mắt giống hệt nhau.
  // `window.location` chứ không phải `location` trần: bridge chạy trong test với đúng bộ global
  // được truyền vào (mobileServer.test.ts), ở đó không có biến toàn cục `location`.
  if(/[?&]vv=1/.test((window.location||{}).search||'')){
    var vvBox=document.createElement('div');vvBox.id='vvdebug';document.body.appendChild(vvBox);
    var vvDraw=function(){
      var v=window.visualViewport||{},f=document.querySelector('footer'),
          r=f&&f.getBoundingClientRect?f.getBoundingClientRect():null;
      vvBox.textContent='inner '+window.innerHeight+'  vv '+Math.round(v.height||0)
        +'  offTop '+Math.round(v.offsetTop||0)
        +'\nscrollY '+Math.round(window.scrollY||0)+'  kb '+(document.body.dataset.keyboard||'-')
        +'\nbody '+Math.round(document.body.getBoundingClientRect().height)
        +'  footer.bottom '+(r?Math.round(r.bottom):'?')
        +'\nđáy nhìn thấy '+Math.round((v.offsetTop||0)+(v.height||0));
    };
    if(window.visualViewport){window.visualViewport.addEventListener('resize',vvDraw);
      window.visualViewport.addEventListener('scroll',vvDraw);}
    document.addEventListener('focusin',function(){setTimeout(vvDraw,250);});
    document.addEventListener('focusout',function(){setTimeout(vvDraw,250);});
    setInterval(vvDraw,500);vvDraw();
  }
  // `chat.css` đẩy contrast của chữ đậm qua class theme mà workbench gắn lên body; ở đây
  // không có ai gắn, nên `--strong` sẽ kẹt ở giá trị mặc định.
  try{document.body.classList.add(window.matchMedia('(prefers-color-scheme: dark)').matches?'vscode-dark':'vscode-light');}catch(e){}
  // Trên điện thoại Enter là xuống dòng như ChatGPT. `chat.js` được nạp sau bridge và gắn
  // handler bubble Enter-to-send lên textarea; capture listener này chặn handler đó nhưng KHÔNG
  // preventDefault, nên WebKit vẫn tự chèn newline. Gửi chỉ còn nút ↑.
  document.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&e.target&&e.target.id==='input')e.stopImmediatePropagation();
  },true);
  document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;if(sheet)closeSheet();else if(dOpen)settle(false);});
  connect();
})();
