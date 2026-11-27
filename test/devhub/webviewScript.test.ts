export {};
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const vscodeMock={ViewColumn:{Beside:2},window:{},Uri:{file:(p:string)=>p}};

test('generated Dev Hub webview script remains valid JavaScript',()=>{
  const original=Module._load;Module._load=function(request:string){if(request==='vscode')return vscodeMock;return original.apply(this,arguments as any);};
  try{
    const {ChatPanelProvider}=require('../../src/devhub/views/chatPanelProvider');
    const manager={on:()=>()=>{}};
    const provider=new ChatPanelProvider(manager,{},async()=>({workspaces:[],projects:[]}),()=>{},()=>{},()=>{});
    const html=(provider as any).html({});
    const match=html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/);
    assert.ok(match?.[1]);
    assert.doesNotThrow(()=>new Function(match[1]));
    // Webview chạy bằng engine của trình duyệt/OS đang xem, không phải Node ở đây. WebKit
    // mới có lookbehind từ Safari 16.4, nên một literal chứa `(?<` là SyntaxError => cả script
    // không chạy và panel trắng trơn trên iPhone/iPad. Node của test thì parse được, nên phải
    // chặn bằng grep chứ không lỗi test nào bắt hộ.
    assert.equal(match[1].includes('(?<'),false,'không được dùng lookbehind trong script webview');
    provider.dispose();
  } finally {Module._load=original;}
});

test('nhãn model suy từ id CLI: alias opus hiện Opus 5.5, đuôi ngày không lọt vào số bản',()=>{
  const src=require('node:fs').readFileSync('media/webview/chat.js','utf8');
  const m=src.match(/function modelLabel\(id\)\{[\s\S]*?\n  return [^\n]*\}/);assert.ok(m,'phải có modelLabel');
  const modelLabel=new Function(m[0]+';return modelLabel')();
  assert.equal(modelLabel('claude-opus-5-5'),'Opus 5.5');
  assert.equal(modelLabel('claude-opus-5-5[1m]'),'Opus 5.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'),'Haiku 4.5');
  assert.equal(modelLabel('claude-fable-5-1'),'Fable 5.1');
  assert.equal(modelLabel('gpt-5.6-luna'),'','id không phải claude thì giữ nguyên chữ người dùng chọn');
  assert.equal(modelLabel(undefined),'');
});
