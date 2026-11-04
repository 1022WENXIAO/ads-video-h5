import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PNG} from 'pngjs';
import {pixelfxLibrary,findPixelEffects,pixelEffect,normalizePixelBinding,renderPixelEffect,pixelBindings} from '../server/pixelfx';
import {createCreativeWorkspace,creativeHash} from '../server/creativeWorkspace';
import {defoldStarter,writeDefoldProject} from '../server/defoldProject';
import {pixelEditingTools} from '../server/pixelfxTools';
import {pixelfxProject} from './fixtures/pixelfxProject';
async function temporary(t:any){const p=await mkdtemp(path.join(os.tmpdir(),'qj-pixelfx-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}

test('pinned catalog is locally searchable in Chinese and English without external generation',async()=>{
 const library=await pixelfxLibrary();assert.equal(library.count,244);assert.equal(library.license,'MIT');assert.equal(library.categories.length,21);
 assert((await findPixelEffects('冰霜新星')).effects.some(e=>e.id==='ice/frost-nova'));
 assert((await findPixelEffects('金币收集')).effects.some(e=>/coin|collect/.test(e.id)));
 assert.equal((await findPixelEffects('fire/torch')).effects[0].id,'fire/torch');
 assert.equal((await findPixelEffects('definitely-nonexistent-effect')).total,0);
 await assert.rejects(pixelEffect('../../server/core'),/未找到/);
});
test('actual transparent frames are cached across binding names; recoloring and corrupted assets invalidate reuse',async t=>{
 const cache=await temporary(t),a=await normalizePixelBinding({name:'first',id:'fire/torch',fps:12,seed:4});
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No external provider may be used for cached effects');};
 try{
  const first=await renderPixelEffect(a,cache);assert.equal(first.cacheHit,false);const img=PNG.sync.read(await readFile(path.join(first.directory,first.render.pages[0].file)));
  assert(img.data.some((v,i)=>i%4===3&&v===0));assert(img.data.some((v,i)=>i%4===3&&v>0));assert(first.render.frames>12);
  const second=await renderPixelEffect({...a,name:'second'},cache);assert.equal(second.cacheHit,true);assert.equal(second.key,first.key);
  const blue=await renderPixelEffect({...a,palette:['#001122','#0055aa','#55ccff','#ffffff']},cache);assert.notEqual(blue.key,first.key);assert.notEqual(blue.render.hashes['page-0.png'],first.render.hashes['page-0.png']);
  await writeFile(path.join(first.directory,'page-0.png'),'corrupted');const repaired=await renderPixelEffect(a,cache);assert.equal(repaired.cacheHit,false);assert.equal(repaired.render.hashes['page-0.png'],first.render.hashes['page-0.png']);
 }finally{globalThis.fetch=originalFetch;}
});
test('effect tools edit versioned project dependencies and preserve pure-export guards',async t=>{
 const dir=await temporary(t),w=await createCreativeWorkspace(path.join(dir,'workspace'));await w.initialize(await defoldStarter());let changes=0;
 const tools=pixelEditingTools(w,path.join(dir,'cache'),()=>changes++,()=>true),use=tools.find(t=>t.name==='use_pixelfx_effect')!;
 await use.execute('one',{expectedRevision:1,name:'pickup',id:'pickups/collect-burst'} as any);assert.equal(w.snapshot().revision,2);assert.equal(changes,1);assert.equal((await pixelBindings(w.snapshot().files))[0].id,'pickups/collect-burst');
 await assert.rejects(use.execute('stale',{expectedRevision:1,name:'other',id:'fire/torch'} as any),/版本冲突/);
 const before=creativeHash(w.snapshot());const blocked=pixelEditingTools(w,path.join(dir,'cache'),()=>{},()=>false).find(t=>t.name==='use_pixelfx_effect')!;
 await assert.rejects(blocked.execute('blocked',{expectedRevision:2,name:'other',id:'fire/torch'} as any),/仅导出/);assert.equal(creativeHash(w.snapshot()),before);
 await tools.find(t=>t.name==='remove_pixelfx_effect')!.execute('remove',{expectedRevision:2,name:'pickup'} as any);assert.equal((await pixelBindings(w.snapshot().files)).length,0);
});
test('binding validation rejects invented resources, malformed colors and duplicate names',async()=>{
 for(const raw of [{name:'../x',id:'fire/torch'},{name:'x',id:'invented/fx'},{name:'x',id:'fire/torch',fps:100},{name:'x',id:'fire/torch',palette:['red','blue']}])await assert.rejects(normalizePixelBinding(raw));
 await assert.rejects(pixelBindings([{path:'assets/pixelfx.json',content:JSON.stringify({version:1,effects:[{name:'x',id:'fire/torch'},{name:'x',id:'ice/frost-nova'}]})}]),/重复/);
});
test('Defold resource writer packages real textures, GUI bindings, source provenance and license without opening arbitrary binary edits',async t=>{
 const dir=await temporary(t),project=await pixelfxProject();await writeDefoldProject(project,path.join(dir,'source'),{pixelfxCacheDirectory:path.join(dir,'cache')});
 const gui=await readFile(path.join(dir,'source/vfx.gui'),'utf8');assert.match(gui,/px_flame_0/);assert.match(gui,/px_frost_0/);
 const img=PNG.sync.read(await readFile(path.join(dir,'source/assets/pixelfx/flame/page-0.png')));assert(img.width>0&&img.height>0);
 assert.match(await readFile(path.join(dir,'source/lib/pixelfx.lua'),'utf8'),/set_flipbook_cursor/);
 assert.match(await readFile(path.join(dir,'source/pixelfx-licenses/LICENSE'),'utf8'),/MIT License/);
 const provenance=JSON.parse(await readFile(path.join(dir,'source/pixelfx-assets.json'),'utf8'));assert.equal(provenance.bindings.length,3);assert.equal(provenance.library.count,244);
 await assert.rejects(writeDefoldProject({...project,files:[...project.files,{path:'assets/unauthorized.png',content:'fake'}]},path.join(dir,'bad')),/文本资源|只开放/);
});
