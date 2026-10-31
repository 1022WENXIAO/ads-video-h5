import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {configureEvaluationCaseLimit} from '../ops/cn/configure-evaluation-limits';
import {defaultReleaseEvaluationSettings} from '../server/releaseEvaluations';

test('offline timeout configuration preserves exact historical attempts and original bytes in a private backup',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-case-limit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'releases.json'),backups=path.join(dir,'backups'),settings=defaultReleaseEvaluationSettings();
  const state={version:1,settings,releases:[{id:'actual-timeout-example',revision:'a'.repeat(40),status:'failed',attempt:1,settingsSnapshot:{...settings},summary:{passed:0,rendered:2},error:'本例超过1800秒，已停止实际任务。',history:[{status:'failed',summary:{passed:0}}]}],retainedUnknownField:{keep:true}};
  const bytes=JSON.stringify(state,null,4)+'\n';await writeFile(file,bytes,{mode:0o600});const owner=await stat(file);
  const result=await configureEvaluationCaseLimit(file,2700,backups);assert.equal(result.changed,true);
  const actual=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(actual,{...state,settings:{...settings,maxCaseSeconds:2700}});
  assert.equal(actual.releases[0].settingsSnapshot.maxCaseSeconds,1800);assert.equal(actual.releases[0].status,'failed');assert.equal(actual.settings.maxSuiteSeconds,7200);assert.equal(actual.settings.caseCount,3);assert.equal(actual.settings.maxAttempts,2);
  const saved=(await readdir(backups))[0];assert.equal(await readFile(path.join(backups,saved),'utf8'),bytes);assert.equal((await stat(path.join(backups,saved))).mode&0o777,0o600);const after=await stat(file);assert.equal(after.mode&0o777,0o600);assert.equal(after.uid,owner.uid);assert.equal(after.gid,owner.gid);
  assert.deepEqual(await configureEvaluationCaseLimit(file,2700,backups),{changed:false,maxCaseSeconds:2700});assert.equal((await readdir(backups)).length,1);
});

test('invalid or corrupt timeout configuration cannot rewrite records or create a backup',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-case-limit-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'releases.json'),backups=path.join(dir,'backups');
  const bytes=JSON.stringify({version:1,settings:defaultReleaseEvaluationSettings(),releases:[{status:'failed'}]});await writeFile(file,bytes,{mode:0o600});
  for(const seconds of [0,59,3601,Infinity,2700.5])await assert.rejects(configureEvaluationCaseLimit(file,seconds,backups),/60–3600/);
  assert.equal(await readFile(file,'utf8'),bytes);assert.deepEqual(await readdir(dir),['releases.json']);
  await writeFile(file,'{"version":1');await assert.rejects(configureEvaluationCaseLimit(file,2700,backups),SyntaxError);assert.equal(await readFile(file,'utf8'),'{"version":1');assert.deepEqual(await readdir(dir),['releases.json']);
});
