import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {applyDrawingLayoutPatch,assertDrawingLayoutIdentity} from '../server/drawingLayoutIdentity';
import {validateDrawing,drawingHtml,checkHtmlProject} from '../server/narrativeScenes';
import {wantsScheduleManagement} from '../server/scheduleIntent';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-e3-partial-containment.json',import.meta.url),'utf8'));

test('actual unrelated court-label repair preserves existing partial labels instead of inventing full containment',()=>{
  const before=structuredClone(fixture.drawing),next=applyDrawingLayoutPatch(fixture.patch,before);
  validateDrawing(next,'9:16');assertDrawingLayoutIdentity(next,before);
  for(const id of ['detail1','detail2'])assert.deepEqual(next.nodes.find((n:any)=>n.id===id),before.nodes.find((n:any)=>n.id===id));
  assert.deepEqual(next.nodes.map(n=>n.text),before.nodes.map((n:any)=>n.text));assert.deepEqual(before,fixture.drawing);
});
test('partial ownership cannot decrease and full ownership cannot become partial',()=>{
  const before=fixture.drawing;
  assert.throws(()=>applyDrawingLayoutPatch({nodes:[{id:'detail1',y:600}]},before),/包含关系/);
  const full=structuredClone(before);full.nodes.find((n:any)=>n.id==='step1').h=200;
  assert.throws(()=>applyDrawingLayoutPatch({nodes:[{id:'detail1',y:630}]},full),/包含关系/);
});
test('actual gardening topic and educational reminders are content rather than schedule operations',async()=>{
  const actual=JSON.parse(await readFile(new URL('./fixtures/qa-e3-gardening-request.json',import.meta.url),'utf8'));
  for(const request of [actual.request,'做一个视频讲每天运动后补水，也提醒不同年龄需求不同。','讲为什么每天固定浇水不好？请生成视频并提醒不同植物需求不同。'])assert.equal(wantsScheduleManagement(request),false,request);
});
test('explicit recurring reminders, scheduled videos and task lifecycle operations remain scheduling',()=>{
  for(const request of ['每天早上9点，提醒我给盆栽检查土壤。','每天9点提醒喝水','每隔30分钟提醒休息','每周一上午九点提醒检查盆土','每天9点帮我生成新闻视频。','每隔30分钟自动执行任务。','明天8点提醒我们开会。','暂停定时任务','查看计划任务','schedule a daily job','帮我创建定时生成视频的任务'])assert.equal(wantsScheduleManagement(request),true,request);
});
test('actual partial-containment drawing is rejected before repair and corrected geometry passes full browser checks',{skip:process.platform==='win32',timeout:180000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qj-partial-containment-'));
  try{
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(dir,'gsap.min.js'));
    await writeFile(path.join(dir,'index.html'),drawingHtml(fixture.drawing,8,'9:16'));
    await assert.rejects(checkHtmlProject(dir,{fullCheck:true}),/未通过/);
    const original=await readFile(path.join(dir,'check-report.json'),'utf8');assert.match(original,/content_overlap/);assert.match(original,/qj-author-court/);
    await writeFile(path.join(dir,'index.html'),drawingHtml(applyDrawingLayoutPatch(fixture.patch,fixture.drawing),8,'9:16'));
    await checkHtmlProject(dir,{fullCheck:true});assert.equal(JSON.parse(await readFile(path.join(dir,'check-report.json'),'utf8')).ok,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
