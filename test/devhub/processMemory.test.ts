export {};
const test=require('node:test');
const assert=require('node:assert/strict');
import { cliMemoryMB, parsePsRows, sumRssKb } from '../../src/devhub/providers/processMemory';

const PS=[
  ' 1     0   9000',
  ' 100   1   180000',   // claude A
  ' 101   100 60000',    // A's mcp child
  ' 102   101 20000',    // grandchild
  ' 200   1   200000',   // claude B
  ' 300   1   500000',   // someone else's process
  'ps: bad line',
].join('\n');

test('ps output is parsed into rows and garbage lines are skipped',()=>{
  const rows=parsePsRows(PS);
  assert.equal(rows.length,6);
  assert.deepEqual(rows[1],{pid:100,ppid:1,rssKb:180000});
});

test('a CLI counts its whole process tree, because the MCP servers are the fat part',()=>{
  assert.equal(sumRssKb(parsePsRows(PS),[100]),180000+60000+20000);
  assert.equal(sumRssKb(parsePsRows(PS),[100,200]),260000+200000,'only sums its own tree, not pid 300');
});

test('a pid listed twice, or already inside another tree, is counted once',()=>{
  assert.equal(sumRssKb(parsePsRows(PS),[100,100,101]),260000);
});

test('a pid that has already died contributes nothing instead of throwing',()=>{
  assert.equal(sumRssKb(parsePsRows(PS),[999]),0);
});

test('no live CLI means no ps at all',async()=>{
  let spawned=0;
  const mb=await cliMemoryMB([],async()=>{spawned++;return PS;});
  assert.equal(mb,0);assert.equal(spawned,0,'no processes means do not spawn ps');
});

test('the total is reported in MB',async()=>{
  assert.equal(await cliMemoryMB([100],async()=>PS),Math.round(260000/1024));
});
