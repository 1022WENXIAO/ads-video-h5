import test from 'node:test';
import assert from 'node:assert/strict';
import {alignLessonSpeech,correctLessonTranscript} from '../server/lessonSpec';
import {NarrationAnalysisError,NarrationVerificationError,recognizeExistingNarration,verifyNarrationSpeech} from '../server/narrationAnalysisRecovery';
import {JobCancelledError} from '../server/jobExecution';
import {executionFailure,TextTransportError} from '../server/executionErrors';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

const chapter:LessonChapter={id:'c1',title:'核验时间',role:'foundation',goal:'说明时间与结论',prerequisites:[],narration:'截至北京时间八点十一分，来源确认了实际功能范围，结论仍以已核验证据为准。',reason:'受控本地核验',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'区分观察与发生时间',items:[{label:'来源',detail:'查证公开内容',cue:'来源确认'}]}};
function analysis(text:string):AudioAnalysis{
  const chars=[...text],duration=chars.length*.2;return {status:'ready',modelId:'controlled-asr',sourceHash:'same-controlled-waveform',duration,transcript:text,timing:'model-estimated',createdAt:'',pauses:[],warnings:[],sentences:[{id:'s1',text,start:0,end:duration,complete:true,words:chars.map((text,i)=>({text,start:i*.2,end:(i+1)*.2}))}]};
}
const align=(raw:AudioAnalysis)=>verifyNarrationSpeech(chapter.id,()=>{const corrected=correctLessonTranscript(chapter,raw);return alignLessonSpeech(chapter,corrected);});

test('an actual 08:10 versus 08:11 local clock mismatch is typed without correcting the source numbers',()=>{
  const raw=analysis(chapter.narration.replace('八点十一分','八点十分')),before=structuredClone(raw),script=structuredClone(chapter);
  assert.throws(()=>align(raw),error=>{
    assert.ok(error instanceof NarrationVerificationError);assert.equal(error.kind,'speech');assert.equal(error.chapterId,'c1');assert.match(error.message,/实际时钟/);
    assert.ok(error.cause instanceof Error);assert.equal(error.cause.message,error.message);assert.equal(error.cause.constructor,Error);return true;
  });
  assert.deepEqual(raw,before);assert.deepEqual(chapter,script);
  assert.equal(align(analysis(chapter.narration)).similarity,1);
});

test('inconsistent transcript and word clocks, missing speech and ordinary numeric errors retain strict verification',()=>{
  const inconsistent=analysis(chapter.narration);inconsistent.transcript=inconsistent.transcript.replace('八点十一分','八点十分');
  const examples=[inconsistent,analysis(chapter.narration.slice(0,-3)),analysis(chapter.narration.replace('八点十一分','九点十一分')),analysis(chapter.narration.replace('功能范围','功范围'))];
  for(const raw of examples){const before=structuredClone(raw);assert.throws(()=>align(raw),NarrationVerificationError);assert.deepEqual(raw,before);}
});

test('only known local verification errors are typed; provider, IO, cancellation and unknown failures keep their identity',()=>{
  const message='章节c1实际时钟的小时、分钟、秒或完整单位与脚本不同，需要独立复听或重录；不能把小数当作时刻。';
  for(const error of [
    new Error('HTTP 401: subtitle mentioned clock 匹配'),
    new Error('章节c1时钟模块异常，数字匹配失败'),
    new Error('章节another实际时钟的小时、分钟、秒或完整单位与脚本不同'),
    new TypeError(message),new SyntaxError(message),new JobCancelledError(),new DOMException(message,'AbortError'),
    Object.assign(new Error(message),{code:'EACCES'}),Object.assign(new Error(message),{status:401}),Object.assign(new Error(message),{retryable:true}),
    new Error(message,{cause:new Error('HTTP 503')}),new TextTransportError(3,new Error(message)),new NarrationAnalysisError(message,new Error('provider format')),
  ])assert.throws(()=>verifyNarrationSpeech('c1',()=>{throw error;}),caught=>caught===error);
  const local=new Error('动画原词「来源确认」未能与实际旁白对齐。');
  assert.throws(()=>verifyNarrationSpeech('c1',()=>{throw local;}),error=>error instanceof NarrationVerificationError&&error.cause===local);
});

test('existing local date, coverage and mathematical verification stems remain recoverable without a generic word regex',()=>{
  for(const message of [
    '章节c1日期数字或年月日单位与脚本不同，需要独立复听或重录。',
    '章节c1实际字词未完整匹配汉字「功」（脚本上下文「实际功能范围」），需要独立复听同一音频或核验后重录。',
    '章节c1实际旁白与脚本匹配80.0%，低于86%；需要重新合成。',
    '章节c1实际读出的年份与脚本不同，不能发布。',
    '章节c1实际读出的数学符号运算缺少“一减正确类别概率”或颠倒减法顺序，需要核验或重录。',
    '章节c1已核验公司专名「HTTP401科技」匹配不完整或不同，需要独立复听同一音频。',
  ]){const original=new Error(message);assert.throws(()=>verifyNarrationSpeech('c1',()=>{throw original;}),error=>error instanceof NarrationVerificationError&&error.kind==='speech'&&error.cause===original);}
});

test('measured pause and first/recheck verification causes remain explicit in diagnostic chains',()=>{
  const pause=new NarrationVerificationError('pause','c1','章节c1实测长停顿0.97秒');assert.equal(pause.kind,'pause');assert.equal(pause.cause,undefined);
  const firstCause=new Error('initial actual clock mismatch'),secondCause=new Error('independent actual clock mismatch');
  const first=new NarrationVerificationError('speech','c1','初次核验失败',{cause:firstCause}),second=new NarrationVerificationError('speech','c1','复听核验失败',{cause:secondCause});
  const combined=new NarrationVerificationError('speech','c1','初次核验失败；复听核验失败',{cause:second,firstError:first});
  assert.equal(combined.cause,second);assert.deepEqual(combined.errors,[first]);
  const diagnostic=executionFailure(combined);assert.deepEqual(diagnostic.causes!.map(c=>c.message),['复听核验失败','初次核验失败']);
  assert.deepEqual(diagnostic.causes!.map(c=>c.causes![0].message),['independent actual clock mismatch','initial actual clock mismatch']);
  const unmeasured=new Error('章节c1长停顿，需要重录');assert.throws(()=>verifyNarrationSpeech('c1',()=>{throw unmeasured;}),error=>error===unmeasured,'text alone does not manufacture a pause measurement');
});

test('a typed-looking error arriving from analysis cannot bypass the recognition boundary into a retake',async()=>{
  let attempts=0;const unexpected=new NarrationVerificationError('speech','c1','provider returned a clock label');
  await assert.rejects(recognizeExistingNarration(async()=>{attempts++;throw unexpected;}),error=>error instanceof NarrationAnalysisError&&error.cause===unexpected);
  assert.equal(attempts,1);
});
