export {};
const test=require('node:test');const assert=require('node:assert/strict');
const nodeFs=require('node:fs');const nodePath=require('node:path');
const mobileCss=()=>nodeFs.readFileSync(nodePath.join(process.cwd(),'media','mobile','mobile.css'),'utf8');
const bridgeJs=()=>nodeFs.readFileSync(nodePath.join(process.cwd(),'media','mobile','bridge.js'),'utf8');

test('PWA composer stays compact and rounded like a native phone chat input',()=>{
  const css=mobileCss();
  assert.match(css,/footer\{border-top:0;padding:4px 8px calc\(4px \+ env\(safe-area-inset-bottom\)\)/,
    'mobile footer phải bỏ thanh chia dày và chỉ giữ padding nhỏ + safe area');
  assert.match(css,/\.composer-box\{border-radius:20px;/,'composer phải là một khối bo tròn');
  assert.match(css,/textarea\{min-height:34px;max-height:24vh;/,'ô nhập rỗng phải thấp và chỉ nở khi có nội dung');
  assert.match(css,/button#send\{width:38px;height:38px;border-radius:50%/,'nút gửi phải là nút tròn cố định');
  assert.match(css,/#thinking\{min-height:20px;gap:5px;padding:0 5px 3px;font-size:12\.5px/,
    'dòng Done/running phải mảnh, không tạo thêm một footer lớn');
});

test('PWA Enter inserts a newline and never triggers the shared desktop Enter-to-send handler',()=>{
  const js=bridgeJs();
  assert.match(js,/e\.key==='Enter'&&e\.target&&e\.target\.id==='input'/,
    'bridge mobile phải bắt riêng Enter của textarea');
  assert.match(js,/e\.stopImmediatePropagation\(\)/,
    'phải chặn handler Enter-to-send của chat.js mà không preventDefault, để textarea tự xuống dòng');
  assert.match(js,/document\.addEventListener\('keydown',[\s\S]*?,true\);/,
    'listener phải chạy capture trước handler bubble của chat.js');
});

test('the standalone PWA never grows the body past the canvas, it trims the footer instead',()=>{
  const css=mobileCss();
  assert.doesNotMatch(css,/transform:translateY\(52px\)/,
    'probe 52px đo sai trên máy và bound sau transform còn tính vào scrollable overflow');
  // Body cao hơn canvas là phần dôi cuộn được: iOS cuộn vào đó khi focus rồi nằm lại luôn —
  // ảnh case C cho thấy cả trang lệch lên, đáy vừa đẹp mà header dính sát status bar.
  assert.doesNotMatch(css,/body\{height:calc\(100dvh/,
    'body không được cao hơn canvas, dù chỉ bằng safe-area');
  assert.match(css,/@media \(display-mode:standalone\)\{html,body\{overflow:hidden;overscroll-behavior:none\}\}/,
    'chỉ Home Screen PWA mới khoá scroll: Safari tab còn thanh địa chỉ, panel desktop không liên quan');
  // `-webkit-fill-available` ra đúng bằng `100dvh` trên iOS 26 standalone: giữ lại chỉ là một
  // declaration chết cạnh comment nói nó chữa được 12px.
  assert.doesNotMatch(css,/height:-webkit-fill-available/,'không giữ rule đã đo là vô tác dụng');
  assert.match(css,/@media \(display-mode:standalone\)\{footer\{padding-bottom:0\}\}/,
    'trong PWA composer là đáy màn hình thật nên không chừa safe-area chút nào');
  assert.match(css,/body\[data-keyboard="open"\] footer\{padding-bottom:4px\}/,
    'keyboard mở thì chat.js ghi height inline, footer chỉ cần bỏ safe-area');
});

test('the ?vv=1 readout stays opt-in and never runs on a plain page load',()=>{
  const js=bridgeJs();
  assert.match(js,/if\(\/\[\?&\]vv=1\/\.test\(\(window\.location\|\|\{\}\)\.search\|\|''\)\)\{/,
    'readout phải nằm sau cờ ?vv=1 — không có cờ thì không dựng gì, không setInterval');
  assert.match(js,/vvBox\.id='vvdebug'/,'readout phải mang id mà mobile.css tạo kiểu');
});
