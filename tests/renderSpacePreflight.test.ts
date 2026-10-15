import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {MIN_RENDER_AVAILABLE_BYTES,inspectRenderSpace} from '../ops/render-space-preflight.mjs';

const helper=new URL('../ops/render-space-preflight.mjs',import.meta.url);
const high=()=>({bsize:1n,bavail:MIN_RENDER_AVAILABLE_BYTES});
async function temporary(t:any){const dir=await mkdtemp(path.join(tmpdir(),'qingjian-space-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('the fixed 2 GiB preflight accepts its exact boundary and rejects even one byte less',async t=>{
  const dir=await temporary(t);assert.equal(MIN_RENDER_AVAILABLE_BYTES,2147483648n);assert.equal(inspectRenderSpace([dir],high)[0].availableBytes,2147483648n);
  assert.throws(()=>inspectRenderSpace([dir],()=>({bsize:1n,bavail:2147483647n})),(error:any)=>error.code==='RENDER_STORAGE_INSUFFICIENT'&&/2 GiB/.test(error.message)&&/2147483647/.test(error.message));
});
test('actual native filesystem availability uses bavail, while an absent future project is measured without creating it',async t=>{
  const dir=await temporary(t),future=path.join(dir,'future','chapter');let actual:any,measured:string|undefined;
  // Compare one native snapshot with its own calculation. Other test workers
  // may create or delete files between distinct statfs calls.
  try{
    const rows=inspectRenderSpace([future],p=>{measured=p;actual=fs.statfsSync(p,{bigint:true});return actual;});
    assert.equal(rows[0].resolvedDirectory,fs.realpathSync(dir));assert.equal(rows[0].availableBytes,actual.bavail*actual.bsize);
  }catch(error:any){assert.equal(error.code,'RENDER_STORAGE_INSUFFICIENT');assert.ok(actual.bavail*actual.bsize<MIN_RENDER_AVAILABLE_BYTES);}
  assert.equal(measured,fs.realpathSync(dir));assert.equal(fs.existsSync(path.join(dir,'future')),false);
  // Also exercise the default native reader without assuming time stands still.
  try{assert.ok(inspectRenderSpace([dir])[0].availableBytes>=MIN_RENDER_AVAILABLE_BYTES);}
  catch(error:any){assert.equal(error.code,'RENDER_STORAGE_INSUFFICIENT');}
  assert.equal(inspectRenderSpace([dir],()=>({bsize:4096n,bavail:524288n,bfree:9999999n}))[0].availableBytes,MIN_RENDER_AVAILABLE_BYTES);
});
test('project symlinks are measured on the real destination rather than an unrelated spacious parent',async t=>{
  const dir=await temporary(t),volume=path.join(dir,'separate-volume'),data=path.join(dir,'data');await mkdir(volume);await mkdir(data);await symlink(volume,path.join(data,'lesson-workflows'));
  const checked:string[]=[];assert.throws(()=>inspectRenderSpace([data,path.join(data,'lesson-workflows','future-chapter')],p=>{checked.push(p);return{bsize:1n,bavail:p===fs.realpathSync(volume)?MIN_RENDER_AVAILABLE_BYTES-1n:MIN_RENDER_AVAILABLE_BYTES};}),(error:any)=>error.code==='RENDER_STORAGE_INSUFFICIENT');
  assert.deepEqual(checked,[fs.realpathSync(data),fs.realpathSync(volume)]);
});
test('broken symlinks, regular files and filesystem permission errors fail closed with their actual cause',async t=>{
  const dir=await temporary(t),broken=path.join(dir,'broken');await symlink(path.join(dir,'missing-target'),broken);await writeFile(path.join(dir,'file'),'not a project');
  assert.throws(()=>inspectRenderSpace([path.join(broken,'future')],high),/Broken render storage symlink/);assert.throws(()=>inspectRenderSpace([path.join(dir,'file')],high),/not a directory/);
  const denied=Object.assign(new Error('controlled filesystem permission denied'),{code:'EACCES'});assert.throws(()=>inspectRenderSpace([dir],()=>{throw denied;}),(error:any)=>error.cause===denied&&/Cannot inspect/.test(error.message));
  assert.throws(()=>inspectRenderSpace(['relative'],high),/absolute/);
});

async function deploymentFixture(t:any,kind:'cn'|'foreign',low:string){
  const dir=await temporary(t),bin=path.join(dir,'bin'),data=path.join(dir,'data'),temp=path.join(dir,'tmp'),volume=path.join(dir,'project-volume');
  await Promise.all([mkdir(bin),mkdir(data),mkdir(temp),mkdir(volume)]);await symlink(volume,path.join(data,'lesson-workflows'));
  for(const name of ['narrative-scenes','media','exports','uploads'])await mkdir(path.join(data,name));
  const services=path.join(dir,'services.log'),provider=path.join(dir,'provider.log'),probes=path.join(dir,'probes.jsonl'),gitlog=path.join(dir,'git.log');
  const preload=path.join(dir,'controlled-statfs.mjs');
  await writeFile(preload,`import fs from 'node:fs';import path from 'node:path';const min=2147483648n;fs.statfsSync=(p)=>{p=String(p);fs.appendFileSync(process.env.PROBES,JSON.stringify({path:p})+'\\n');const low=process.env.LOW_KIND;const match=low==='data'&&p===fs.realpathSync(process.env.DATA)||low==='project'&&p===fs.realpathSync(process.env.PROJECT_VOLUME)||low==='temp'&&p===fs.realpathSync(process.env.TMPDIR)||low==='candidate'&&(p===process.env.CANDIDATE||p.includes('/cache/build.'));return{bsize:1n,bavail:match?min-1n:min};};globalThis.fetch=()=>{fs.appendFileSync(process.env.PROVIDER,'unexpected fetch\\n');throw new Error('No provider or HTTP calls permitted by this deployment test');};`);
  const program=async(name:string,body:string)=>writeFile(path.join(bin,name),'#!/bin/bash\nset -Eeuo pipefail\n'+body+'\n',{mode:0o755});
  await symlink(process.execPath,path.join(bin,'node'));
  // macOS has no flock; locking is outside this isolated storage-gate test.
  await program('flock','exit 0');
  await program('mv','if [[ "${1:-}" == -Tf ]];then shift;exec node -e \'require("fs").renameSync(process.argv[1],process.argv[2])\' "$@";fi\nexec /bin/mv "$@"');
  await program('systemctl','printf "%s\\n" "$*" >> "$SERVICES"\nif [[ "${STOP_AFTER_GUARD:-}" == 1 && "${1:-}" == restart ]]; then exit 47; fi\nexit 0');
  await program('chown','exit 0');
  await program('install','while (( $# )); do case "$1" in -o|-g|-m) shift 2;; -d) shift;; *) mkdir -p "$1";shift;; esac;done');
  await program('runuser',`[[ "$1" == -u ]];shift 2;[[ "$1" == -- ]];shift\nif [[ "$1" == env && "$*" == *'pnpm install --frozen-lockfile'* ]];then d="\${@: -1}";mkdir -p "$d/node_modules" "$d/dist/admin";printf built > "$d/dist/index.html";printf built > "$d/dist/admin/index.html";exit 0;fi\nexec "$@"`);
  await program('browser','exit 0');
  const rev='b'.repeat(40),old='a'.repeat(40);let script:string,candidate:string,current:string;
  if(kind==='cn'){
    const root=path.join(dir,'cn');candidate=path.join(root,'releases',rev);const prior=path.join(root,'releases',old);await mkdir(path.join(candidate,'dist/admin'),{recursive:true});await mkdir(path.join(candidate,'node_modules'));await mkdir(path.join(candidate,'ops'));await copyFile(helper,path.join(candidate,'ops/render-space-preflight.mjs'));await mkdir(prior);await mkdir(path.join(root,'node/bin'),{recursive:true});await symlink(process.execPath,path.join(root,'node/bin/node'));current=path.join(root,'current');await symlink(prior,current);
    await writeFile(path.join(candidate,'dist/index.html'),'candidate');await writeFile(path.join(candidate,'dist/admin/index.html'),'candidate');await writeFile(path.join(candidate,'dist/release.json'),JSON.stringify({revision:rev}));for(const name of ['auth.json','credits.json','app-state.json'])await writeFile(path.join(data,name),'{}');
    script=(await readFile(new URL('../ops/cn/activate-release',import.meta.url),'utf8')).replaceAll('/opt/qingjian-cn',root).replaceAll('/data/qingjian',data).replaceAll('/run/lock/qingjian-cn-deploy.lock',path.join(dir,'lock'));
  }else{
    const repo=path.join(dir,'live'),cache=path.join(dir,'cache'),archive=path.join(dir,'archive');candidate=archive;current=repo;await mkdir(path.join(repo,'dist'),{recursive:true});await mkdir(path.join(repo,'node_modules'));await writeFile(path.join(repo,'dist/old'),'original');await writeFile(path.join(repo,'node_modules/old'),'original');await mkdir(path.join(archive,'ops'),{recursive:true});await copyFile(helper,path.join(archive,'ops/render-space-preflight.mjs'));
    await program('git',`cmd="$3";case "$cmd" in status|fetch|merge-base) exit 0;; rev-parse) if [[ "$4" == HEAD ]];then printf '${old}\\n';else printf '${rev}\\n';fi;; archive) tar -cf - -C "$ARCHIVE" .;; checkout) printf '%s\\n' "$*" >> "$GITLOG";if [[ "\${STOP_AFTER_GUARD:-}" == 1 ]];then exit 47;fi;; *) exit 98;; esac`);
    script=(await readFile(new URL('../ops/cd/qingjian-cd',import.meta.url),'utf8')).replaceAll('/opt/ads-video-h5',repo).replaceAll('/var/cache/qingjian-cd',cache).replaceAll('/data/qingjian',data).replaceAll('/run/lock/qingjian-cd.lock',path.join(dir,'lock'));
  }
  const env={...process.env,PATH:bin+':'+path.dirname(process.execPath)+':/usr/bin:/bin',NODE_OPTIONS:'--import '+preload,TMPDIR:temp,DATA:data,PROJECT_VOLUME:volume,PROBES:probes,PROVIDER:provider,SERVICES:services,GITLOG:gitlog,CANDIDATE:fs.realpathSync(candidate),LOW_KIND:low,QINGJIAN_MIN_RENDER_BYTES:'1',HYPERFRAMES_BROWSER_PATH:path.join(bin,'browser'),ARCHIVE:path.join(dir,'archive'),STOP_AFTER_GUARD:low==='none'?'1':''};
  const result=spawnSync('/bin/bash',['-c',script,'resource-preflight-test',candidate],{env,encoding:'utf8',timeout:10000});assert.equal(result.error,undefined,String(result.error));
  return{dir,result,services,provider,probes,gitlog,current,old,kind};
}

for(const kind of ['cn','foreign'] as const)for(const low of ['candidate','data','project','temp'])test(`${kind} real deployment script rejects low ${low} storage before switching, restarting or any HTTP/paid acceptance`,async t=>{
  const s=await deploymentFixture(t,kind,low);assert.equal(s.result.status,1,s.result.stderr+'\n'+s.result.stdout);assert.match(s.result.stderr,/Render storage preflight rejected/);assert.match(s.result.stderr,/2147483648 bytes \(2 GiB/);assert.equal(fs.existsSync(s.services),false,'no restart or stop');assert.equal(fs.existsSync(s.provider),false,'no HTTP or provider submission');assert.equal(fs.existsSync(s.gitlog),false,'no live checkout switch');assert.ok(fs.existsSync(s.probes),'the actual archived helper executed');
  if(kind==='cn')assert.ok(fs.realpathSync(s.current).endsWith('/'+s.old));else{assert.equal(await readFile(path.join(s.current,'dist/old'),'utf8'),'original');assert.equal(await readFile(path.join(s.current,'node_modules/old'),'utf8'),'original');}
});
for(const kind of ['cn','foreign'] as const)test(`${kind} deployment boundary accepts exactly 2 GiB and reaches the first controlled switch operation`,async t=>{
  const s=await deploymentFixture(t,kind,'none');assert.equal(s.result.status,47,s.result.stderr);assert.match(s.result.stdout,/render-storage-preflight/);assert.equal(fs.existsSync(s.provider),false);assert.equal(fs.existsSync(kind==='cn'?s.services:s.gitlog),true,'the guard permits progress only after all real paths pass');
});
test('both scripts use their exact candidate helper before a live switch, and helper-only changes trigger Linux CI',async()=>{
  const cn=await readFile(new URL('../ops/cn/activate-release',import.meta.url),'utf8'),foreign=await readFile(new URL('../ops/cd/qingjian-cd',import.meta.url),'utf8'),ci=await readFile(new URL('../.github/workflows/cn-release.yml',import.meta.url),'utf8');
  assert.ok(cn.indexOf('$release/ops/render-space-preflight.mjs')<cn.indexOf('switched=1'));assert.ok(foreign.indexOf('$build_dir/ops/render-space-preflight.mjs')>foreign.indexOf('pnpm build'));assert.ok(foreign.indexOf('$build_dir/ops/render-space-preflight.mjs')<foreign.indexOf('switched=1'));
  for(const source of [cn,foreign])for(const suffix of ['lesson-workflows','narrative-scenes','media','exports','uploads'])assert.ok(source.includes('/data/qingjian/'+suffix));assert.match(ci,/'ops\/render-space-preflight.mjs'/);
});
