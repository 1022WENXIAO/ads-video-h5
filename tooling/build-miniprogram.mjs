import { readFile, readdir, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(repo, 'apps/miniprogram'), source = path.join(project, 'miniprogram');
const req = createRequire(path.join(project, 'package.json'));
const config = JSON.parse(await readFile(path.join(project, 'project.config.json'), 'utf8'));
const app = JSON.parse(await readFile(path.join(source, 'app.json'), 'utf8'));
const appid = process.env.QINGJIAN_MINI_APPID || config.appid;
if (appid !== 'touristappid' && !/^wx[a-f0-9]{16}$/.test(appid)) throw new Error('AppID 必须为 wx 开头的真实公开标识。');
if (!config.setting.urlCheck || config.compileType !== 'miniprogram') throw new Error('必须启用合法域名校验，使用原生小程序项目。');
const clientConfig = req('./miniprogram/config.js');
const version = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const releases = req('./miniprogram/utils/releases.js');
if (!releases.length || releases[0].version !== version) throw new Error('请先为当前版本补充 utils/releases.js 的功能介绍。');
await writeFile(path.join(source, 'utils/version.js'), '// Synchronized with apps/miniprogram/package.json by the local build.\nmodule.exports = ' + JSON.stringify(version) + ';\n');
if (!/^https:\/\/[^/]+\/.*api$/.test(clientConfig.apiBase) || clientConfig.allowLocal) throw new Error('发布包必须使用 HTTPS 正式接口。');
for (const page of app.pages) for (const extension of ['js', 'json', 'wxml', 'wxss']) await readFile(path.join(source, page + '.' + extension));
for (const tab of app.tabBar.list) for (const field of ['iconPath', 'selectedIconPath']) await readFile(path.join(source, tab[field]));
async function collect(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path.join(directory, entry.name), name)); else files.push(name);
  }
  return files.sort();
}
const files = await collect(source);
const digest = createHash('sha256');
let bytes = 0;
for (const file of files) {
  const content = await readFile(path.join(source, file)); bytes += content.length;
  digest.update(file + '\0').update(content).update('\0');
  if (file.endsWith('.js')) new Script(content.toString(), { filename: file });
  if (file.endsWith('.json')) JSON.parse(content.toString());
}
if (bytes > 2 * 1024 * 1024) throw new Error('主包超过 2 MB，请分包后再发布。');
const compiler = createRequire(req.resolve('miniprogram-simulate'))('miniprogram-compiler');
const wxml = compiler.wxmlToJs(source, { maxBuffer: 4 * 1024 * 1024 }); new Function(wxml);
const wxss = compiler.wxssToJs(source, { maxBuffer: 4 * 1024 * 1024 }); new Function(wxss);
if (!wxss.includes('app.wxss')) throw new Error('WXSS 编译没有生成全局样式。');
let revision = null;
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); } catch { /* Exported project. */ }
const destination = path.join(project, 'release/qingjian-wechat');
// Windows IDEs may keep a handle to the project directory. Replace its
// generated contents without removing the directory itself.
await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) {
  const target = path.resolve(destination, name);
  if (path.dirname(target) !== path.resolve(destination)) throw new Error('Unexpected release output path.');
  await rm(target, { recursive: true, force: true });
}
await cp(source, path.join(destination, 'miniprogram'), { recursive: true });
await writeFile(path.join(destination, 'project.config.json'), JSON.stringify({ ...config, appid }, null, 2) + '\n');
await cp(path.join(project, 'README.md'), path.join(destination, 'README.md'));
await cp(path.join(project, 'TESTING.md'), path.join(destination, 'TESTING.md'));
const localNotes = 'LOCAL-' + version + '.md';
await cp(path.join(project, localNotes), path.join(destination, localNotes));
const manifest = { version, sourceRevision: revision, sourceSha256: digest.digest('hex'), appid,
  binding: appid === 'touristappid' ? 'awaiting-appid' : 'bound', publication: 'not-uploaded', apiBase: clientConfig.apiBase, bytes, files: files.length,
  checks: { javascript: 'parsed', json: 'parsed', wxml: 'official-compiler', wxss: 'official-compiler' }, generatedAt: new Date().toISOString() };
await writeFile(path.join(destination, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const archive = path.join(project, 'release/qingjian-wechat-test.zip'); await rm(archive, { force: true });
if (process.platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', archive, 'qingjian-wechat'], { cwd: path.dirname(destination) });
else execFileSync('zip', ['-q', '-r', archive, 'qingjian-wechat'], { cwd: path.dirname(destination) });
console.log(JSON.stringify({ project: destination, archive, ...manifest }, null, 2));
if (appid === 'touristappid') console.log('未绑定 AppID：这是可导入的开发测试包，尚未上传或发布微信体验版。');
