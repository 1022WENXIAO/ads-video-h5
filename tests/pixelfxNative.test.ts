import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildDefold,defoldEnvironment} from '../server/defoldRuntime';
import {inspectDefold} from '../server/defoldInspect';
import {pixelfxProject} from './fixtures/pixelfxProject';
import {observePixelGame} from './fixtures/pixelfxNativeProbe';
const environment=await defoldEnvironment();
test('pixelfx textures compile into a native game and independently observed pixels both appear and animate',{skip:!environment.available,timeout:180000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qj-pixelfx-native-'));
 try{
  const build=await buildDefold(await pixelfxProject(),path.join(dir,'builds'),{pixelfxCacheDirectory:path.join(dir,'cache')});assert.equal(build.effectAssets?.length,3);
  assert.match(await readFile(path.join(build.directory,'LICENSE.pixelfx.txt'),'utf8'),/MIT License/);
  assert.equal((await inspectDefold(build,path.join(dir,'inspection'))).technicalPassed,true);
  const observed=await observePixelGame(build,path.join(dir,'pixels'));assert.equal(observed.passed,true);assert.equal(observed.userAccepted,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
