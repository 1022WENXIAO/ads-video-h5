import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReleaseEvaluationFixtures } from '../server/releaseEvaluationFixtures';
import { createEvaluations, evaluationFileHash } from '../server/evaluations';
import { runFFmpeg } from '../server/core';
import type { ModelConfig } from '../server/modelRegistry';

test('controlled editing sources validate actual cached files and repair corruption without resynthesizing speech', {timeout:20000}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'qingjian-release-fixtures-')); t.after(() => rm(dir,{recursive:true,force:true}));
  // Deterministic audio fixture substitutes only the paid provider in this unit test.
  const speech = path.join(dir,'speech.mp3'); await runFFmpeg(['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=300:sample_rate=48000','-t','13','-c:a','libmp3lame',speech]);
  const bytes = await readFile(speech); let synthesisCalls = 0;
  const audioConfig: ModelConfig = {id:'test-audio',name:'audio',provider:'fixture',kind:'audio',modelId:'seed-audio-1.0',baseUrl:'https://example.com',apiKey:'PRIVATE',enabled:true};
  const dependencies = {audioConfig,generateSpeech:async () => {synthesisCalls++;return {bytes,mimeType:'audio/mpeg'};}};
  const evaluations = createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async () => ({text:null,audio:null,image:null,understanding:null}),execute:async () => {throw new Error('not an execution test');},stop:async () => {},artifactFile:() => undefined});
  await evaluations.init();
  const initial = await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies);
  assert.equal(initial.length,2); assert.equal(synthesisCalls,2); assert.notEqual(initial[0].sha256,initial[1].sha256);
  assert.deepEqual(await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies),initial);
  const firstFile = path.join(dir,'evaluations/fixtures',initial[0].id); await writeFile(firstFile,'corrupt cached movie');
  const repaired = await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies);
  assert.notEqual(repaired[0].id,initial[0].id); assert.equal(repaired[1].id,initial[1].id); assert.equal(synthesisCalls,2);
  assert.equal(await evaluationFileHash(path.join(dir,'evaluations/fixtures',repaired[0].id)),repaired[0].sha256);
  assert.deepEqual(await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies),repaired);
  assert.equal(evaluations.catalog().fixtures.length,3);
  await rm(path.join(dir,'evaluations/fixtures',repaired[1].id));
  const missingRepaired = await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies);
  assert.notEqual(missingRepaired[1].id,repaired[1].id); assert.equal(missingRepaired[0].id,repaired[0].id); assert.equal(synthesisCalls,2);
});
