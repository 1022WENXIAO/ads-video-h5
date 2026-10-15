import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,cp,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Change only a private source copy. A stale processing/review policy must
// invalidate cached authorization without mutating the live checkout.
test('changed narration and visual review helpers invalidate their bound cache evidence',async()=>{
  const source=fileURLToPath(new URL('..',import.meta.url));
  const copy=await mkdtemp(path.join(tmpdir(),'qingjian-policy-closure-'));
  try{
    await cp(path.join(source,'server'),path.join(copy,'server'),{recursive:true});
    await cp(path.join(source,'shared'),path.join(copy,'shared'),{recursive:true});
    await cp(path.join(source,'package.json'),path.join(copy,'package.json'));
    await symlink(path.join(source,'node_modules'),path.join(copy,'node_modules'),'dir');
    const {lessonRendererHash}=await import(pathToFileURL(path.join(copy,'server/lessonScenes.ts')).href);
    const {lessonSpeechProcessingHash}=await import(pathToFileURL(path.join(copy,'server/lessonSpeechProof.ts')).href);
    const renderer=lessonRendererHash(),speech=lessonSpeechProcessingHash();
    for(const name of ['narrationBatchRecovery.ts','taskPool.ts','visualReviewEvidence.ts','reviewResults.ts','semanticReview.ts','renderReview.ts']){
      const file=path.join(copy,'server',name),bytes=await readFile(file);
      await appendFile(file,'\n// independent cache invalidation probe\n');
      assert.notEqual(lessonRendererHash(),renderer,`${name}: old movie/review evidence must be invalidated`);
      if(['narrationBatchRecovery.ts','taskPool.ts'].includes(name))assert.notEqual(lessonSpeechProcessingHash(),speech,`${name}: old speech authorization must be invalidated`);
      else assert.equal(lessonSpeechProcessingHash(),speech,`${name}: a visual-only policy must not change audio authorization`);
      await writeFile(file,bytes);
      assert.equal(lessonRendererHash(),renderer);
      assert.equal(lessonSpeechProcessingHash(),speech);
    }
  }finally{await rm(copy,{recursive:true,force:true});}
});
