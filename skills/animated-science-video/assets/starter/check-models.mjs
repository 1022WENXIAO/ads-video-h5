import assert from 'node:assert/strict';
import fs from 'node:fs';
import {weights,quantized,quantScale,keptLinks,teacher,distillSteps,rankA,rankB,rankW,rankInput,rankOutput,mv,mm,compressionState,pruneTargets,pruneCutStart} from './scenes/compression-model.mjs';

// Validate the teaching example, including states immediately before/after every cut.
const checks=[];
weights.forEach((row,a)=>row.forEach((w,b)=>{
 assert.ok(quantized[a][b]>=-7&&quantized[a][b]<=7);
 assert.ok(Math.abs(w-quantized[a][b]*quantScale)<=quantScale/2+1e-12);
}));checks.push('INT4 range and nearest-level error bound');
assert.equal(compressionState(0,0).qDone,0);
assert.equal(compressionState(9,0).qDone,16);
assert.equal(pruneTargets.length,7);assert.equal(keptLinks.flat().filter(Boolean).length,9);
for(let k=0;k<7;k++){
 assert.equal(compressionState(pruneCutStart(k)+.39,1).removed,k);
 assert.equal(compressionState(pruneCutStart(k)+.41,1).removed,k+1);
 assert.ok(Math.abs(pruneTargets[k].w)<.35);
}checks.push('Seven individually timed cuts, retaining nine connections');
const ce=p=>-teacher.reduce((s,v,k)=>s+v*Math.log(p[k]),0);
distillSteps.slice(1).forEach((p,k)=>assert.ok(ce(p)<ce(distillSteps[k])));
assert.deepEqual(compressionState(14,2).student,distillSteps[5]);
checks.push('All five student updates reduce teacher-target cross entropy');
assert.deepEqual(mm(rankA,rankB),rankW);
mv(rankW,rankInput).forEach((v,k)=>assert.ok(Math.abs(v-rankOutput[k])<1e-12));
assert.equal(rankW.flat().length,36);assert.equal(rankA.flat().length+rankB.flat().length,24);
checks.push('W=A×B and two-stage computation have matching outputs; 36 to 24 parameters');
fs.mkdirSync(new URL('./qa/compression/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('./qa/compression/model-checks.json',import.meta.url),JSON.stringify({passed:true,checks},null,2));
console.log(JSON.stringify({passed:true,checks}));

const {functions,samples,stateAt:activationState}=await import('./scenes/activations.mjs');
assert.equal(samples.length,144);assert.ok(samples.every(p=>p.x>=-3&&p.x<=5));
for(let j=0;j<6;j++){assert.equal(activationState(0,j).bins.reduce((a,b)=>a+b,0),0);assert.equal(activationState(5,j).bins.reduce((a,b)=>a+b,0),144);assert.deepEqual(activationState(5,j).bins,activationState(13,j).bins);assert.ok(samples.every(p=>{const y=functions[j](p.x);return Number.isFinite(y)&&y>=-1&&y<=5}))}
console.log(JSON.stringify({activations:true,sharedSamples:144,allOutputsBinned:true,twoIdenticalEightSecondCycles:true}));
