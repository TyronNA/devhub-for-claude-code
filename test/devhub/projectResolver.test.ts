const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const util = require('node:util');
const execFile = util.promisify(cp.execFile);
import { ProjectResolver } from '../../src/devhub/workspace/projectResolver';

test('nested folder inside git repo resolves to git root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-git-'));
  await execFile('git', ['init'], { cwd: dir });
  const nested = path.join(dir, 'src', 'feature');
  await fs.mkdir(nested, { recursive: true });
  const result = await new ProjectResolver().resolve(nested);
  assert.equal(result.gitRoot, await fs.realpath(dir));
  assert.equal(result.rootPath, await fs.realpath(dir));
});

test('non git folder resolves to selected folder and missing folder is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devhub-folder-'));
  const result = await new ProjectResolver().resolve(dir);
  assert.equal(result.rootPath, await fs.realpath(dir));
  assert.equal(result.gitRoot, undefined);
  await assert.rejects(() => new ProjectResolver().resolve(path.join(dir, 'missing')), /does not exist/i);
});
