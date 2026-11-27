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
    // The webview runs on the viewing browser/OS engine, not Node here. WebKit
    // only has lookbehind since Safari 16.4, so a literal containing `(?<` is a SyntaxError => the whole script
    // doesn't run and the panel is blank on iPhone/iPad. The test's Node parses it fine, so it must
    // be blocked by grep; no test failure would catch it.
    assert.equal(match[1].includes('(?<'),false,'no lookbehind in the webview script');
    provider.dispose();
  } finally {Module._load=original;}
});

test('the model label is derived from the CLI id: alias opus shows Opus 5.5, the date suffix does not leak into the version',()=>{
  const src=require('node:fs').readFileSync('media/webview/chat.js','utf8');
  const m=src.match(/function modelLabel\(id\)\{[\s\S]*?\n  return [^\n]*\}/);assert.ok(m,'must have modelLabel');
  const modelLabel=new Function(m[0]+';return modelLabel')();
  assert.equal(modelLabel('claude-opus-5-5'),'Opus 5.5');
  assert.equal(modelLabel('claude-opus-5-5[1m]'),'Opus 5.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'),'Haiku 4.5');
  assert.equal(modelLabel('claude-fable-5-1'),'Fable 5.1');
  assert.equal(modelLabel('gpt-5.6-luna'),'','a non-claude id keeps the text the user chose');
  assert.equal(modelLabel(undefined),'');
});
