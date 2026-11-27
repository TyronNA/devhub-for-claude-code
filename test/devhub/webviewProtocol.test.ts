const test=require('node:test');const assert=require('node:assert/strict');
import { parseWebviewMessage } from '../../src/devhub/views/webviewProtocol';

test('webview protocol accepts only bounded known message shapes',()=>{
  assert.deepEqual(parseWebviewMessage({type:'ready'}),{type:'ready'});
  assert.deepEqual(parseWebviewMessage({type:'sendPrompt',text:' hi '}),{type:'sendPrompt',text:' hi '});
  assert.equal(parseWebviewMessage({type:'sendPrompt',text:{bad:true}}),undefined);
  assert.equal(parseWebviewMessage({type:'openFile',path:'relative/file.ts'}),undefined);
  assert.equal(parseWebviewMessage({type:'future',x:1}),undefined);
  assert.deepEqual(parseWebviewMessage({type:'copySessionId'}),{type:'copySessionId'});
  // `back` đi cùng nút `‹` đã bỏ: nhận lại là mở lại một lối vào không còn UI nào gọi.
  assert.equal(parseWebviewMessage({type:'back'}),undefined);
  // `viewport` đã bị bỏ cùng với tính năng tự đóng sidebar — không được lặng lẽ nhận lại.
  assert.equal(parseWebviewMessage({type:'viewport',phone:true}),undefined);
});
