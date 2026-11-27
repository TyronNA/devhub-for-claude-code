export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { parseBranchStatus, parseNumstat, readGitStatus, summarize } from '../../src/devhub/workspace/gitStatus';
import { GitStatusWatcher } from '../../src/devhub/workspace/gitStatusWatcher';

/** Đúng byte-for-byte những gì `git status --porcelain=v2 -b -z` in ra (đã dump bằng od -c). */
const STATUS=[
  '# branch.oid 889cacaedbcf1d6a167e6edb0390ab21d502680c',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +3 -2',
  '1 MM N... 100644 100644 100644 5626abf0 f9ebcb99 a.txt',
  '2 R. N... 100644 100644 100644 f0f23074 f0f23074 R100 tệp mới.txt',
  'b.txt',
  '? c.txt',
  ''].join('\0');

test('branch, ahead/behind và untracked đọc ra từ porcelain v2',()=>{
  const info=parseBranchStatus(STATUS);
  assert.equal(info.branch,'main');
  assert.equal(info.upstream,'origin/main');
  assert.equal(info.ahead,3);
  assert.equal(info.behind,2);
  assert.deepEqual(info.untracked,['c.txt'],'path cũ của rename KHÔNG được đọc thành bản ghi');
});

test('bản ghi rename nuốt token kế tiếp, nên một file tên "? x" vẫn không lọt vào untracked',()=>{
  const out=['# branch.head main','2 R. N... 100644 100644 100644 aa bb R100 new.txt','? old.txt','? real.txt',''].join('\0');
  assert.deepEqual(parseBranchStatus(out).untracked,['real.txt']);
});

test('không có upstream thì ahead/behind là 0, không phải undefined',()=>{
  const info=parseBranchStatus(['# branch.oid x','# branch.head main','? c.txt',''].join('\0'));
  assert.equal(info.upstream,undefined);
  assert.equal(info.ahead,0);assert.equal(info.behind,0);
});

test('numstat -z: path để trần, file nhị phân tính 0 dòng',()=>{
  const out=['3\t0\ta.txt','0\t3\tb.txt','3\t0\ttệp mới.txt','-\t-\tlogo.png',''].join('\0');
  assert.deepEqual(parseNumstat(out),[
    {path:'a.txt',added:3,removed:0},
    {path:'b.txt',added:0,removed:3},
    {path:'tệp mới.txt',added:3,removed:0},
    {path:'logo.png',added:0,removed:0},
  ]);
});

test('untracked đếm vào số file nhưng không vào số dòng',()=>{
  const st=summarize(parseBranchStatus(STATUS),parseNumstat(['3\t0\ta.txt','0\t3\tb.txt',''].join('\0')));
  assert.equal(st.added,3);assert.equal(st.removed,3);
  assert.equal(st.untracked,1);
  assert.equal(st.files,3,'2 file tracked + 1 untracked');
  assert.equal(st.changes[2].path,'c.txt');
  assert.equal(st.changes[2].untracked,true);
});

test('file đổi nhiều dòng nhất đứng đầu, untracked luôn xuống cuối',()=>{
  const st=summarize({ahead:0,behind:0,untracked:['z.txt']},
    [{path:'small.txt',added:1,removed:0},{path:'big.txt',added:50,removed:9}]);
  assert.deepEqual(st.changes.map((c:any)=>c.path),['big.txt','small.txt','z.txt']);
});

test('repo chưa có commit: `diff HEAD` lỗi nhưng branch và untracked vẫn ra',async()=>{
  const st=await readGitStatus('/x',async(args:string[])=>{
    if(args[0]==='status')return ['# branch.head main','? a.txt',''].join('\0');
    throw new Error("fatal: ambiguous argument 'HEAD'");
  });
  assert.equal(st?.branch,'main');
  assert.equal(st?.files,1);assert.equal(st?.added,0);
});

test('không phải repo git thì trả undefined — chip ẩn hẳn chứ không vẽ số 0',async()=>{
  const st=await readGitStatus('/x',async()=>{throw new Error('not a git repository');});
  assert.equal(st,undefined);
});

test('watcher: nhiều root cùng lúc chỉ chạy một lần mỗi root, và chỉ báo khi đổi',async()=>{
  let runs=0;let files=1;
  const w=new GitStatusWatcher(async()=>{runs++;return {ahead:0,behind:0,files,untracked:0,added:files,removed:0,changes:[]} as any;});
  const seen:any[]=[];
  w.on((root,st)=>seen.push([root,st?.files]));
  await Promise.all([w.refresh('/a'),w.refresh('/a'),w.refresh('/a')]);
  assert.equal(runs,1,'single-flight: ba người hỏi cùng lúc vẫn một lần chạy git');
  await w.refresh('/a');
  assert.equal(runs,2);
  assert.equal(seen.length,1,'kết quả y hệt thì không đánh thức ai vẽ lại');
  files=7;await w.refresh('/a');
  assert.deepEqual(seen[1],['/a',7]);
  w.dispose();
});

test('watcher: cache còn tươi hơn maxAge thì không chạy git',async()=>{
  let runs=0;
  const w=new GitStatusWatcher(async()=>{runs++;return {ahead:0,behind:0,files:0,untracked:0,added:0,removed:0,changes:[]} as any;});
  await w.refresh('/a');
  await w.refresh('/a',60_000);
  assert.equal(runs,1);
  await w.refresh('/a');
  assert.equal(runs,2,'maxAge=0 là ép chạy lại');
  w.dispose();
});

test('watcher: root không còn nguồn nào nhìn thì bị buông khỏi cache',async()=>{
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
