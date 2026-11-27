const fs = require('node:fs/promises');
const path = require('node:path');

export async function readJson<T>(file:string, fallback:T):Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (err:any) { if (err?.code === 'ENOENT') return fallback; throw err; }
}
export async function writeJsonAtomic(file:string, value:any):Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}
export async function normalizeProjectPath(input:string):Promise<{display:string; key:string}> {
  const pathMod = require('node:path');
  const fsPromises = require('node:fs/promises');
  const absolute = pathMod.resolve(input);
  let real = absolute;
  try { real = await fsPromises.realpath(absolute); } catch {}
  const root = pathMod.parse(real).root;
  const display = real === root ? real : real.replace(/[\\/]+$/, '');
  const key = (process.platform === 'darwin' || process.platform === 'win32') ? display.toLowerCase() : display;
  return {display, key};
}
