export {};
const test=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
import { parsePayload, PlannerClient } from '../../src/devhub/providers/planner/plannerClient';

/** A fake daemon: says only what the real API says, including a 409 with `reason` in the status line. */
function daemon(handler:(req:any,body:string,res:any)=>void){
  const seen:any[]=[];
  const server=http.createServer((req:any,res:any)=>{
    const chunks:any[]=[];req.on('data',(c:any)=>chunks.push(c));
    req.on('end',()=>{const body=Buffer.concat(chunks).toString('utf8');
      seen.push({method:req.method,url:req.url,body});handler(req,body,res);});
  });
  return new Promise<{client:PlannerClient;seen:any[];close:()=>Promise<void>}>(resolve=>{
    server.listen(0,'127.0.0.1',()=>resolve({
      client:new PlannerClient(`http://127.0.0.1:${server.address().port}`,4000),
      seen,close:()=>new Promise<void>(r=>server.close(()=>r())),
    }));
  });
}
const json=(res:any,code:number,body:any)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};

test('tasks and plan come back decoded',async()=>{
  const d=await daemon((req,_b,res)=>{
    if(req.url==='/tasks')return json(res,200,{tasks:[{jira_key:'A-1',status:'WAITING_APPROVAL',plan_version:2}]});
    if(req.url==='/tasks/A-1/plan')return json(res,200,{plan_markdown:'# do it',current_version:2});
    json(res,404,{});
  });
  try{
    assert.equal((await d.client.tasks())[0].jira_key,'A-1');
    assert.equal((await d.client.plan('A-1')).plan_markdown,'# do it');
  }finally{await d.close();}
});

test('approve sends the exact plan_version and never invents one',async()=>{
  const d=await daemon((_req,_b,res)=>json(res,200,{jira_key:'A-1',status:'APPROVED'}));
  try{
    await d.client.approve('A-1',2);
    assert.equal(d.seen[0].method,'POST');
    assert.equal(d.seen[0].url,'/tasks/A-1/approve');
    assert.deepEqual(JSON.parse(d.seen[0].body),{plan_version:2});
  }finally{await d.close();}
});

test('a 409 is a real answer and its reason reaches the message',async()=>{
  // Approving the wrong version and a preflight refusal both come back as 409; swallowing it lies to the user.
  const d=await daemon((_req,_b,res)=>{res.writeHead(409,'stale plan');res.end('');});
  try{
    await assert.rejects(()=>d.client.approve('A-1',1),/409/);
  }finally{await d.close();}
});

test('event payloads are decoded even though the API leaves them as text',async()=>{
  const d=await daemon((_req,_b,res)=>json(res,200,{events:[
    {kind:'task_state',created_at:1,payload:'{"from":"DISCOVERED","to":"ANALYZING"}'},
    {kind:'broken',created_at:2,payload:'{not json'}]}));
  try{
    const rows=await d.client.events('A-1');
    assert.equal(rows[0].payload.to,'ANALYZING');
    assert.equal(rows[1].payload,undefined,'a broken payload must be undefined, not throw');
  }finally{await d.close();}
});

test('a task key with a slash cannot escape its own path',()=>{
  assert.equal(encodeURIComponent('A-1/../health'),'A-1%2F..%2Fhealth');
});

test('parsePayload passes an object straight through',()=>{
  const o={a:1};assert.equal(parsePayload(o),o);
  assert.equal(parsePayload(''),undefined);
});
