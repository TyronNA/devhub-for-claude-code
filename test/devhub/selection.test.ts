const test=require('node:test');const assert=require('node:assert/strict');
import { findRestorableSession } from '../../src/devhub/sessions/selection';

test('last selected session restores by provider and native id when still present',()=>{
  const sessions:any[]=[{provider:'claude',nativeSessionId:'a'},{provider:'codex',nativeSessionId:'b'}];
  assert.equal(findRestorableSession(sessions,{provider:'codex',nativeSessionId:'b'})?.nativeSessionId,'b');
  assert.equal(findRestorableSession(sessions,{provider:'codex',nativeSessionId:'missing'}),undefined);
});

test('a fresh client without a saved selection opens the latest available session',()=>{
  const sessions:any[]=[{provider:'claude',nativeSessionId:'old',updatedAt:1,status:'done'},
    {provider:'codex',nativeSessionId:'new',updatedAt:3,status:'imported'},
    {provider:'codex',nativeSessionId:'missing',updatedAt:4,status:'unavailable'}];
  assert.equal(findRestorableSession(sessions,undefined)?.nativeSessionId,'new');
  assert.equal(findRestorableSession([],undefined),undefined);
});
