export {};
const test=require('node:test');const assert=require('node:assert/strict');
const nodeFs=require('node:fs');const nodePath=require('node:path');
const mobileCss=()=>nodeFs.readFileSync(nodePath.join(process.cwd(),'media','mobile','mobile.css'),'utf8');
const bridgeJs=()=>nodeFs.readFileSync(nodePath.join(process.cwd(),'media','mobile','bridge.js'),'utf8');

test('PWA composer stays compact and rounded like a native phone chat input',()=>{
  const css=mobileCss();
  assert.match(css,/footer\{border-top:0;padding:4px 8px calc\(4px \+ env\(safe-area-inset-bottom\)\)/,
    'the mobile footer must drop the thick divider and keep only small padding + safe area');
  assert.match(css,/\.composer-box\{border-radius:20px;/,'the composer must be one rounded block');
  assert.match(css,/textarea\{min-height:34px;max-height:24vh;/,'an empty input must be short and only grow with content');
  assert.match(css,/button#send\{width:38px;height:38px;border-radius:50%/,'the send button must be a fixed round button');
  assert.match(css,/#thinking\{min-height:20px;gap:5px;padding:0 5px 3px;font-size:12\.5px/,
    'the Done/running line must be thin, not another big footer');
});

test('PWA Enter inserts a newline and never triggers the shared desktop Enter-to-send handler',()=>{
  const js=bridgeJs();
  assert.match(js,/e\.key==='Enter'&&e\.target&&e\.target\.id==='input'/,
    'the mobile bridge must catch the textarea Enter itself');
  assert.match(js,/e\.stopImmediatePropagation\(\)/,
    'must block chat.js\'s Enter-to-send handler without preventDefault, so the textarea inserts a newline');
  assert.match(js,/document\.addEventListener\('keydown',[\s\S]*?,true\);/,
    'the listener must run in capture before chat.js\'s bubble handler');
});

test('the standalone PWA never grows the body past the canvas, it trims the footer instead',()=>{
  const css=mobileCss();
  assert.doesNotMatch(css,/transform:translateY\(52px\)/,
    'the 52px probe measured wrong on device and its post-transform bounds still count toward scrollable overflow');
  // A body taller than the canvas is scrollable excess: iOS scrolls into it on focus and stays there —
  // the case C screenshot shows the whole page shifted up, bottom fine but the header stuck to the status bar.
  assert.doesNotMatch(css,/body\{height:calc\(100dvh/,
    'the body must not be taller than the canvas, not even by the safe-area');
  assert.match(css,/@media \(display-mode:standalone\)\{html,body\{overflow:hidden;overscroll-behavior:none\}\}/,
    'only the Home Screen PWA locks scrolling: a Safari tab still has the address bar, the desktop panel is unaffected');
  // `-webkit-fill-available` equals `100dvh` on iOS 26 standalone: keeping it is just a
  // dead declaration next to a comment claiming it fixes 12px.
  assert.doesNotMatch(css,/height:-webkit-fill-available/,'do not keep a rule measured to have no effect');
  assert.match(css,/@media \(display-mode:standalone\)\{footer\{padding-bottom:0\}\}/,
    'in the PWA the composer is the real screen bottom so it leaves no safe-area at all');
  assert.match(css,/body\[data-keyboard="open"\] footer\{padding-bottom:4px\}/,
    'with the keyboard open chat.js writes an inline height, the footer only drops the safe-area');
});

test('the ?vv=1 readout stays opt-in and never runs on a plain page load',()=>{
  const js=bridgeJs();
  assert.match(js,/if\(\/\[\?&\]vv=1\/\.test\(\(window\.location\|\|\{\}\)\.search\|\|''\)\)\{/,
    'the readout must sit behind the ?vv=1 flag — without it nothing is built, no setInterval');
  assert.match(js,/vvBox\.id='vvdebug'/,'the readout must carry the id mobile.css styles');
});
