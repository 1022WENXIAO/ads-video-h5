import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadVideoTemplates, publicTemplate } from '../server/videoTemplates';
import { selectMention, templateMentions } from '../shared/videoTemplates';
import { resolveTemplateRequest } from '../server/templateRequest';
import { validateScienceScene, patchScienceScene } from '../server/scienceScene';
import { openSciencePage, inspectScienceLayout } from '../server/scienceRender';
import { archiveTemplateProject } from '../server/templateArchive';
import { scienceFixture } from './fixtures/scienceScene';

test('template manifest loads the supplied skill and bounded references with a content fingerprint',async()=>{
  const templates=await loadVideoTemplates(),t=templates.find(t=>t.id==='animated-science-video')!;
  assert.ok(t);assert.match(t.context,/无口播/);assert.match(t.context,/paintPanel/);assert.match(t.context,/write_animation_scene/);
  assert.equal(t.testCases[0].prompt,'@动态图科普视频 制作一个LLM Prompt的原理视频');
  assert.match(t.skillHash,/^[a-f0-9]{64}$/);assert.equal('directory' in publicTemplate(t),false);assert.equal('instructions' in publicTemplate(t),false);
});

test('mentions select a template without matching an email or a name prefix; unknown names fail explicitly',async()=>{
  const templates=await loadVideoTemplates();
  for(const text of ['@动态图科普视频 制作一个LLM Prompt的原理视频','请用 ＠动态图科普视频 制作视频','@animated-science-video 制作视频'])assert.equal(selectMention(text,templates)?.id,'animated-science-video');
  assert.deepEqual(templateMentions('联系 shikanon@foxmail.com'),[]);
  assert.throws(()=>selectMention('@动态图科普视频新版 制作视频',templates),/未找到模板/);
  assert.throws(()=>selectMention('@未知模板 制作视频',templates),/未找到模板/);
});

test('template routing preserves draft-only requests and continues in the same skill after a saved draft',async()=>{
  const templates=await loadVideoTemplates(),session={templateId:'animated-science-video'};
  assert.equal(resolveTemplateRequest('@动态图科普视频 制作一个LLM Prompt的原理视频',{},templates).kind,'export');
  assert.equal(resolveTemplateRequest('@动态图科普视频 只写方案，先不要导出视频',{},templates).kind,'plan');
  assert.equal(resolveTemplateRequest('生成成片',session,templates).template?.id,session.templateId);
  assert.equal(resolveTemplateRequest('修改为24秒',session,templates).template?.id,session.templateId);
  assert.equal(resolveTemplateRequest('生成一张封面图',session,templates).template,undefined);
  assert.equal(resolveTemplateRequest('为什么要先研究资料',session,templates).template,undefined);
  assert.throws(()=>resolveTemplateRequest('每天9点 @动态图科普视频 制作视频',session,templates),/暂不支持定时执行/);
  assert.throws(()=>resolveTemplateRequest('@动态图科普视频',{},templates),/补充/);
});

test('science state models reject unverified sources, empty visual operations, invalid references and false result assertions',()=>{
  const base=scienceFixture(),urls=new Set(base.basis);
  assert.equal(validateScienceScene(base,urls).panels.length,6);
  const badSource=structuredClone(base);badSource.basis=['https://example.com/fabricated'];assert.throws(()=>validateScienceScene(badSource,urls),/来源/);
  const noMotion=structuredClone(base);noMotion.panels[0].steps[1].changes=[{nodeId:'data',active:true}];noMotion.panels[0].steps[2].changes=[{nodeId:'output',active:true}];noMotion.panels[0].checks[0].text='等待输入';assert.throws(()=>validateScienceScene(noMotion,urls),/可见操作/);
  const badLink=structuredClone(base);badLink.panels[0].transfers[0].to='missing';assert.throws(()=>validateScienceScene(badLink,urls),/传输引用/);
  const falseResult=structuredClone(base);falseResult.panels[0].checks[0].text='9';assert.throws(()=>validateScienceScene(falseResult,urls),/断言/);
});

test('local scene repairs preserve the remaining model and cannot access prototype or missing paths',()=>{
  const original=scienceFixture(),patched=patchScienceScene(original,[{path:'/panels/0/transfers/0/step',jsonValue:'2'}]);
  assert.equal(patched.panels[0].transfers[0].step,2);assert.equal(original.panels[0].transfers[0].step,1);assert.deepEqual(patched.panels[1],original.panels[1]);
  assert.throws(()=>patchScienceScene(original,[{path:'/panels/0/__proto__/polluted',jsonValue:'true'}]),/路径/);
  assert.throws(()=>patchScienceScene(original,[{path:'/panels/20/name',jsonValue:'"不存在"'}]),/路径/);
  assert.throws(()=>patchScienceScene(original,[{path:'/title',jsonValue:'not JSON'}]),/JSON/);
  const labelled=structuredClone(original);labelled.basis=['Brown et al., '+original.basis[0]];assert.deepEqual(validateScienceScene(labelled,new Set(original.basis)).basis,original.basis);
});

test('JSON demonstrations must parse and visible nodes may not overlap',()=>{
  const original=scienceFixture(),urls=new Set(original.basis),invalid=structuredClone(original);
  invalid.panels[0].english='JSON';invalid.panels[0].steps[2].changes[0].text='{数量:5}';invalid.panels[0].checks[0].text='{数量:5}';
  assert.throws(()=>validateScienceScene(invalid,urls),/非法JSON/);
  invalid.panels[0].steps[2].changes[0].text='{"数量":5}';invalid.panels[0].checks[0].text='{"数量":5}';assert.ok(validateScienceScene(invalid,urls));
  const overlapping=structuredClone(original);overlapping.panels[0].nodes[1].x=.5;overlapping.panels[0].nodes[1].y=.14;assert.throws(()=>validateScienceScene(overlapping,urls),/重叠/);
});

test('the real browser checks every frame and verifies deterministic seek, looping and result states',async()=>{
  const [template]=await loadVideoTemplates();
  for(const count of [4,6,8]){
    const cfg=scienceFixture(count),view=await openSciencePage(template,cfg);
    try{const layout=await inspectScienceLayout(view.page);assert.equal(layout.framesChecked,481);assert.equal(layout.checks.length,count);assert.equal(layout.loopIdentical,true);}
    finally{await view.close();}
  }
});

test('project archives retain UTF-8 source names and do not include sibling private files',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-template-zip-'));
  try{
    const project=path.join(dir,'project');await mkdir(project);await writeFile(path.join(project,'配置.json'),'中文数据');await writeFile(path.join(dir,'private.txt'),'private');
    const zip=path.join(dir,'project.zip');await archiveTemplateProject(project,zip);const bytes=await readFile(zip);
    assert.equal(bytes.readUInt32LE(),0x04034b50);assert.equal(bytes.readUInt16LE(6),0x800);assert.ok(bytes.includes(Buffer.from('配置.json')));assert.ok(!bytes.includes(Buffer.from('private.txt')));
    await assert.rejects(archiveTemplateProject(project,zip),{code:'EEXIST'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
