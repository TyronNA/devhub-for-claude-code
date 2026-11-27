export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { parseBranchStatus, parseNumstat, readGitStatus, summarize } from '../../src/devhub/workspace/gitStatus';
import { GitStatusWatcher } from '../../src/devhub/workspace/gitStatusWatcher';

/** Byte-for-byte what `git status --porcelain=v2 -b -z` prints (dumped with od -c). */
const STATUS=[
  '# branch.oid 889cacaedbcf1d6a167e6edb0390ab21d502680c',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +3 -2',
  '1 MM N... 100644 100644 100644 5626abf0 f9ebcb99 a.txt',
  '2 R. N... 100644 100644 100644 f0f23074 f0f23074 R100 über notes.txt',
  'b.txt',
  '? c.txt',
  ''].join('\0');

test('branch, ahead/behind and untracked are read from porcelain v2',()=>{
  const info=parseBranchStatus(STATUS);
  assert.equal(info.branch,'main');
  assert.equal(info.upstream,'origin/main');
  assert.equal(info.ahead,3);
  assert.equal(info.behind,2);
  assert.deepEqual(info.untracked,['c.txt'],'the old path of a rename must NOT be read as a record');
});

test('a rename record swallows the next token, so a file named "? x" still does not slip into untracked',()=>{
  const out=['# branch.head main','2 R. N... 100644 100644 100644 aa bb R100 new.txt','? old.txt','? real.txt',''].join('\0');
  assert.deepEqual(parseBranchStatus(out).untracked,['real.txt']);
});

test('no upstream means ahead/behind is 0, not undefined',()=>{
  const info=parseBranchStatus(['# branch.oid x','# branch.head main','? c.txt',''].join('\0'));
  assert.equal(info.upstream,undefined);
  assert.equal(info.ahead,0);assert.equal(info.behind,0);
});

test('numstat -z: raw paths, binary files count as 0 lines',()=>{
  const out=['3\t0\ta.txt','0\t3\tb.txt','3\t0\tüber notes.txt','-\t-\tlogo.png',''].join('\0');
  assert.deepEqual(parseNumstat(out),[
    {path:'a.txt',added:3,removed:0},
    {path:'b.txt',added:0,removed:3},
    {path:'über notes.txt',added:3,removed:0},
    {path:'logo.png',added:0,removed:0},
  ]);
});

test('untracked counts toward files but not lines',()=>{
  const st=summarize(parseBranchStatus(STATUS),parseNumstat(['3\t0\ta.txt','0\t3\tb.txt',''].join('\0')));
  assert.equal(st.added,3);assert.equal(st.removed,3);
  assert.equal(st.untracked,1);
  assert.equal(st.files,3,'2 file tracked + 1 untracked');
  assert.equal(st.changes[2].path,'c.txt');
  assert.equal(st.changes[2].untracked,true);
});

test('the file with most changed lines comes first, untracked always last',()=>{
  const st=summarize({ahead:0,behind:0,untracked:['z.txt']},
    [{path:'small.txt',added:1,removed:0},{path:'big.txt',added:50,removed:9}]);
  assert.deepEqual(st.changes.map((c:any)=>c.path),['big.txt','small.txt','z.txt']);
});

test('repo with no commits: `diff HEAD` fails but branch and untracked still come out',async()=>{
  const st=await readGitStatus('/x',async(args:string[])=>{
    if(args[0]==='status')return ['# branch.head main','? a.txt',''].join('\0');
    throw new Error("fatal: ambiguous argument 'HEAD'");
  });
  assert.equal(st?.branch,'main');
  assert.equal(st?.files,1);assert.equal(st?.added,0);
});

test('not a git repo returns undefined — the chip is hidden rather than drawing 0',async()=>{
  const st=await readGitStatus('/x',async()=>{throw new Error('not a git repository');});
  assert.equal(st,undefined);
});

test('watcher: several roots at once run once per root, and only notify on change',async()=>{
  let runs=0;let files=1;
  const w=new GitStatusWatcher(async()=>{runs++;return {ahead:0,behind:0,files,untracked:0,added:files,removed:0,changes:[]} as any;});
  const seen:any[]=[];
  w.on((root,st)=>seen.push([root,st?.files]));
  await Promise.all([w.refresh('/a'),w.refresh('/a'),w.refresh('/a')]);
  assert.equal(runs,1,'single-flight: three callers at once still run git once');
  await w.refresh('/a');
  assert.equal(runs,2);
  assert.equal(seen.length,1,'an identical result wakes nobody to redraw');
  files=7;await w.refresh('/a');
  assert.deepEqual(seen[1],['/a',7]);
  w.dispose();
});

test('watcher: a cache fresher than maxAge does not run git',async()=>{
  let runs=0;
  const w=new GitStatusWatcher(async()=>{runs++;return {ahead:0,behind:0,files:0,untracked:0,added:0,removed:0,changes:[]} as any;});
  await w.refresh('/a');
  await w.refresh('/a',60_000);
  assert.equal(runs,1);
  await w.refresh('/a');
  assert.equal(runs,2,'maxAge=0 forces a rerun');
  w.dispose();
});

test('watcher: a root no source looks at is dropped from the cache',async()=>{
  const w=new GitStatusWatcher(async()=>({ahead:0,behind:0,files:2,untracked:0,added:2,removed:0,changes:[]} as any));
  let watched=[{root:'/a',hot:false}];
  w.addSource(()=>watched);
  w.tick();
  await new Promise(r=>setTimeout(r,0));
  assert.equal(w.get('/a')?.files,2);
  watched=[];
  w.tick();
  assert.equal(w.get('/a'),undefined);
  w.dispose();
});
