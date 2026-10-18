import { jobDelay, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { validateSemanticReview,reviewFindings } from './reviewResults';
import { requestReviewJson, type ReviewObserver } from './reviewAssets';
import { blocksModelOutputRecovery } from './executionErrors';
import { bindVisualRetentionSources, visualRetentionFindings, visualRetentionReviewInstruction, VisualRetentionReviewError, type VisualRetentionRequirement, type VisualRetentionAttempt, type VisualRetentionSourceContext } from './visualRetentionReview';
import { numericVisualFindings,parseNumericVisualChecks,type VisualReviewContext } from './visualReviewEvidence';
import { parseVisualRetentionChecks } from './visualRetentionReview';

export type SemanticReviewProtocolStage='message-json'|'review-schema'|'news-publication'|'numeric-evidence'|'retention-binding'|'retention-checks';
const protocolStages={
  'message-json':{code:'SEMANTIC_MESSAGE_JSON_INVALID',detail:'模型消息不是有效JSON'},
  'review-schema':{code:'SEMANTIC_REVIEW_SCHEMA_INVALID',detail:'审查字段格式无效'},
  'news-publication':{code:'SEMANTIC_NEWS_PUBLICATION_MISSING',detail:'新闻报道日期观察缺失'},
  'numeric-evidence':{code:'SEMANTIC_NUMERIC_EVIDENCE_INVALID',detail:'数字图解观察的章节或时点无效'},
  'retention-binding':{code:'SEMANTIC_RETENTION_BINDING_INVALID',detail:'视觉保留原素材证据绑定无效'},
  'retention-checks':{code:'SEMANTIC_RETENTION_CHECKS_INVALID',detail:'视觉保留逐项观察无效'},
} as const;
export interface SemanticReviewFieldDiagnostic {path:string;expected:string;actualType:'missing'|'null'|'array'|'object'|'string'|'number'|'boolean';missing:boolean}
export interface SemanticReviewProtocolDiagnostic {attempt:number;stage:SemanticReviewProtocolStage;code:typeof protocolStages[SemanticReviewProtocolStage]['code'];detail:string;rawScore?:number;fields?:SemanticReviewFieldDiagnostic[]}

// Diagnostic-only: the existing validators still decide validity. Never retain
// a provider value, property name, exception text or inferred repair verdict.
function fieldDiagnostic(path:string,expected:string,value:unknown):SemanticReviewFieldDiagnostic {
  const actualType=value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value;
  return {path,expected,actualType:actualType as SemanticReviewFieldDiagnostic['actualType'],missing:value===undefined};
}
function schemaDiagnostic(value:any):{stage:SemanticReviewProtocolStage;fields:SemanticReviewFieldDiagnostic[]} {
  const core=(fields:SemanticReviewFieldDiagnostic[])=>({stage:'review-schema' as const,fields});
  if(!value||typeof value!=='object'||Array.isArray(value))return core([fieldDiagnostic('$','JSON object',value)]);
  const fields:SemanticReviewFieldDiagnostic[]=[];
  if(!Number.isFinite(value.score)||value.score<0||value.score>100)fields.push(fieldDiagnostic('score','finite number in [0,100]',value.score));
  if(typeof value.needsRepair!=='boolean')fields.push(fieldDiagnostic('needsRepair','JSON boolean',value.needsRepair));
  for(const name of ['findings','suggestions'] as const){
    if(name==='suggestions'&&value[name]==null)continue;
    try{reviewFindings(value[name]);}catch{
      const items=value[name];
      if(!Array.isArray(items))fields.push(fieldDiagnostic(name,'array of readable findings',items));
      else for(let i=0;i<items.length&&fields.length<6;i++){
        try{reviewFindings([items[i]]);}catch{fields.push(fieldDiagnostic(`${name}[${i}]`,'nonempty string or readable finding object',items[i]));}
      }
    }
  }
  if(fields.length)return core(fields.slice(0,6));
  try{parseNumericVisualChecks(value.numericVisualChecks);}catch{
    return {stage:'numeric-evidence',fields:[fieldDiagnostic('numericVisualChecks','valid numeric-observation array with chapterId/frameTime/claim/expectedCount/observedCount/observedEvidence',value.numericVisualChecks)]};
  }
  try{parseVisualRetentionChecks(value.visualRetentionChecks);}catch{
    return {stage:'retention-checks',fields:[fieldDiagnostic('visualRetentionChecks','valid retention-check array with id/quote/status/frameTimes/detail',value.visualRetentionChecks)]};
  }
  // Isolate the optional publication field through the same strict validator,
  // rather than copying its length/range rules or changing accepted inputs.
  try{validateSemanticReview({...value,numericVisualChecks:undefined,visualRetentionChecks:undefined});}catch{
    return {stage:'news-publication',fields:[fieldDiagnostic('newsPublication','object with visible:boolean,chapterId:string,quote:string,frameTime:finite number',value.newsPublication)]};
  }
  return core([fieldDiagnostic('$','valid semantic-review object',value)]);
}
function protocolFeedback(diagnostic:SemanticReviewProtocolDiagnostic,requiresNewsPublication:boolean):string {
  return '上一轮成片评审的输出协议未通过，不是本地判定影片有错或替你决定needsRepair。安全字段诊断：'+JSON.stringify(diagnostic)+
    '。请仅依据上面同一份实际音频和抽帧重新评审，按具体字段纠正格式；原始评分及已经可读的处置仍保留，不要求沿用或提高旧分，不得删除真实缺陷来通过校验。回复内容必须是单个有效JSON对象，不含代码块或额外说明。完整核心字段：score为0到100的有限number；needsRepair为JSON boolean（true/false，不是字符串，不能省略）；findings为可读问题字符串或问题对象的array，没有真实缺陷才返回[]；suggestions为array。不得用分数推导或代填缺失的needsRepair。'+
    (requiresNewsPublication?'新闻另须newsPublication:{visible:boolean,chapterId:string,quote:string,frameTime:number}，只据本次真实抽帧填写；无法确认就如实visible=false，不从期望文案推定可见。':'')+
    '本轮findings和suggestions仅输出字符串数组，不再输出问题对象或嵌套对象。每条真实缺陷把章节ID、实际时点、观察证据和修复要求合成一条完整字符串；保留已发现的真实问题，不能为修正格式改成空数组。score和needsRepair仍须显式返回实际数字及布尔值，不得因格式修正省略或推导。没有实际缺陷才可findings:[]。'+
    '若返回可选numericVisualChecks或visualRetentionChecks，须符合本次原有完整字段及真实章节/时间/要求绑定；未知保持未知，不编造证据。';
}
export class SemanticReviewProtocolError extends Error {
  readonly diagnostics:readonly SemanticReviewProtocolDiagnostic[];
  constructor(diagnostics:SemanticReviewProtocolDiagnostic[],cause:unknown){
    const last=diagnostics.at(-1)!;
    super(`成片语义审查协议未完成：${last.code}（${last.detail}）`,{cause});this.name='SemanticReviewProtocolError';
    this.diagnostics=diagnostics.map(diagnostic=>({...diagnostic}));
  }
}
// Retention failures retain their existing class/attempt contract. Supplemental
// protocol diagnostics never serialize their cause or provider response.
const retentionProtocolDiagnostics=new WeakMap<object,readonly SemanticReviewProtocolDiagnostic[]>();
export function semanticReviewProtocolDiagnostics(error:unknown):readonly SemanticReviewProtocolDiagnostic[]|undefined{
  return error instanceof SemanticReviewProtocolError?error.diagnostics:error instanceof VisualRetentionReviewError?retentionProtocolDiagnostics.get(error):undefined;
}

export const SEMANTIC_EVIDENCE_REVIEW_INSTRUCTION = '\n证据判读边界：判定自相矛盾前，先核对是否在比较同一变量、量纲、参照刻度、时间区间和条件，并引用对应文字、旁白或成片帧。不同过程的速率、流速、累计量和接触时长不是同一个量，不能只因一处说快、另一处说慢或久就判为矛盾。箭头方向须与同帧明确的同一轴、刻度、方向标签及旁白核对；同一基准下的相反指向仍是实际缺陷，不能用习惯方向或别的机器/坐标系替代该图的明确基准。逐张核对本次实际成片帧与原素材帧的身份；任一实际成片帧已经出现某项内容，就不能因其他帧未出现而断言整片未保留该内容，但仍须分别核对其他保留义务。仅在所给成片抽样中未看见，应写“抽样未确认/待查”，不能推断完整视频缺失。视觉保留协议可用本次同源哈希、源帧时间与全部实际选片范围证明原画面在范围之外，并返回真实sourceEvidence；只有服务端完成这些绑定后派生的typed sourceOmitted才是源画面未选入的可信证据，不得自行声明该标志，也不能以单帧未见冒充这种全量范围证据。保留原始评分、真实缺陷和不确定性，不为纠正误判而提高分数或掩盖另一项未满足要求。事件日期与报道日期的区分须按用户原始指令规定的范围，核对整片实际可见表达；只有用户明确要求每章或每页分别呈现时，才逐项要求重复。不能仅因其他章节没有重复首章已呈现的日期，就增设逐章重复义务或断言混淆；实际日期错误、精度不足或整片未清楚区分事件与报道时间，仍须按原要求如实报告。';

export const SEMANTIC_SPATIAL_REVIEW_INSTRUCTION = '\n文字遮挡须依据同一张实际成片帧：指出发生交叠的两段文字或图形、各自相对位置及被遮住的具体部分。同处顶部、水平相邻或距离较近本身不是重叠；看见二者间有空白间隔时，不能写成标签遮住文字。渲染坐标参照只用于定位新增标签，不能替代本帧像素，也不能证明原素材文字安全；真实相交、不可读、裁剪、孤字排版等问题仍须报告。无法确认遮挡时保留不确定性，不编造被遮文字。纠正输出格式或证据绑定，不代表影片出现了新缺陷，不需要为了协议返修补写findings；同时不得删除已核实的缺陷或提高原分来通过。';

export interface SemanticReviewDispositionAttempt {attempt:number;score:number;needsRepair:boolean;findings:string[]}
const dispositionHistory=new WeakMap<object,readonly SemanticReviewDispositionAttempt[]>();
export function semanticReviewDispositionAttempts(error:unknown):readonly SemanticReviewDispositionAttempt[]|undefined{
  return error!==null&&typeof error==='object'?dispositionHistory.get(error):undefined;
}

export async function requestSemanticReview(config:ModelConfig,messages:unknown[],observe?:ReviewObserver,requiresNewsPublication=false,visualContext?:VisualReviewContext & {visualRetentionRequirements?:VisualRetentionRequirement[];visualRetentionSources?:VisualRetentionSourceContext}) {
  const evidenceAttempts:Array<{score:number;discardedFindings:Array<{original:string;reason:string}>}>=[];
  const reviewMessages=[...messages];
  const retentionRequirements=visualContext?.visualRetentionRequirements||[],retentionAttempts:VisualRetentionAttempt[]=[];
  const protocolDiagnostics:SemanticReviewProtocolDiagnostic[]=[];
  const dispositionAttempts:SemanticReviewDispositionAttempt[]=[];
  const retainDisposition=<T>(error:T):T=>{if(error!==null&&typeof error==='object'&&dispositionAttempts.length)dispositionHistory.set(error,dispositionAttempts.map(item=>({...item,findings:[...item.findings]})));return error;};
  for(let attempt=0;attempt<2;attempt++) {
    let rawScore:number|null=null;
    // A previous parse failure must never brand a later HTTP/network failure.
    let protocolStage:SemanticReviewProtocolStage|undefined;
    let raw:unknown;
    let messageContent:unknown;
    try {
      const body=await requestReviewJson(config,{model:config.modelId,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8000,messages:reviewMessages},'semantic',attempt,observe);
      protocolStage='message-json';
      messageContent=body.choices?.[0]?.message?.content;
      raw=JSON.parse((messageContent||'') as string);
      const parsed=raw as any;
      if(Number.isFinite(parsed?.score))rawScore=parsed.score;
      protocolStage='review-schema';
      // Preserve valid core fields before nested evidence bindings can fail.
      // Store the original parsed finding text before the existing typo filter.
      if(Number.isFinite(parsed?.score)&&parsed.score>=0&&parsed.score<=100&&typeof parsed.needsRepair==='boolean'){
        let originalFindings:string[]|undefined;
        try{originalFindings=reviewFindings(parsed.findings);}catch{/* Invalid core finding text remains unknown. */}
        if(originalFindings)dispositionAttempts.push({attempt:attempt+1,score:parsed.score,needsRepair:parsed.needsRepair,findings:originalFindings});
      }
      const result=validateSemanticReview(raw);
      protocolStage='news-publication';
      if(requiresNewsPublication&&!result.newsPublication)throw new Error('新闻报道日期抽帧审查未完成。');
      protocolStage='numeric-evidence';
      const numericFindings=numericVisualFindings(result.numericVisualChecks,visualContext);
      protocolStage='retention-binding';
      result.visualRetentionChecks=bindVisualRetentionSources(result.visualRetentionChecks,visualContext?.visualRetentionSources);
      protocolStage='retention-checks';
      const retentionFindings=visualRetentionFindings(result.visualRetentionChecks,retentionRequirements,visualContext?.frameTimes);
      if(retentionRequirements.length)retentionAttempts.push({score:result.score,checks:result.visualRetentionChecks});
      if(result.discardedFindings?.length)evidenceAttempts.push({score:result.score,discardedFindings:result.discardedFindings});
      // Record the model's original flag before conservative normalization.
      // Conflicting field roles require clarification, never local deletion of
      // a finding or a higher grade. Reuse the existing two-request budget.
      if(!attempt&&parsed.needsRepair===false&&result.findings.length){
        reviewMessages.push({role:'user',content:'上一轮needsRepair=false，但findings仍非空，字段处置相互矛盾。原始评分'+result.score+'、flag和问题列表已保留，不要求提高评分，也不能删除真实缺陷来消除矛盾。仅依据上面同一份实际音频和抽帧重新核对：findings只列仍需返修的实际缺陷；若有真实缺陷应保留并令needsRepair=true。核验通过、无错字或正常动效等肯定观察不能填入findings；没有实际缺陷时返回findings:[]，可选改进放suggestions。待澄清列表：'+JSON.stringify(result.findings)});
        await jobDelay(600);continue;
      }
      // Correct a sole self-identical accusation only within the existing two
      // review attempts. Its raw score and needsRepair flag are never lifted to make it pass.
      if(!attempt&&result.discardedFindings?.length&&!result.findings.length&&!numericFindings.length&&!retentionFindings.length){
        reviewMessages.push({role:'user',content:'上一轮唯一拼写指控的原串与目标串逐字相同，不能证明拼写有误。原始评分'+result.score+'及原指控已保留记录，不要求提高分数。请重新依据上面同一份实际音频和抽帧给出有效判断，保留任何真正缺陷或不确定性；不要原样重复无差异指控。具体问题：'+JSON.stringify(result.discardedFindings)});
        await jobDelay(600);continue;
      }
      return {...result,dispositionAttempts,findings:[...result.findings,...numericFindings,...retentionFindings],needsRepair:result.needsRepair||numericFindings.length>0||retentionFindings.length>0,...(retentionAttempts.length?{retentionAttempts}:{}),...(evidenceAttempts.length?{evidenceAttempts}: {}),...(protocolDiagnostics.length?{protocolDiagnostics:protocolDiagnostics.map(diagnostic=>({...diagnostic}))}:{})};
    } catch(error) {
      retainDisposition(error);
      try{throwIfJobCancelled();}catch(cancelled){throw retainDisposition(cancelled);}
      let fields:SemanticReviewFieldDiagnostic[]|undefined;
      if(protocolStage==='review-schema'){
        const diagnostic=schemaDiagnostic(raw);protocolStage=diagnostic.stage;fields=diagnostic.fields;
      }else if(protocolStage==='message-json')fields=[fieldDiagnostic('message.content','valid JSON object',messageContent)];
      else if(protocolStage==='news-publication')fields=[fieldDiagnostic('newsPublication','required actual-frame publication observation',(raw as any)?.newsPublication)];
      else if(protocolStage==='numeric-evidence')fields=[fieldDiagnostic('numericVisualChecks','observations bound to this request\'s actual chapter and frame times',(raw as any)?.numericVisualChecks)];
      else if(protocolStage==='retention-binding')fields=[fieldDiagnostic('visualRetentionChecks','source evidence bound to this request\'s actual source frames',(raw as any)?.visualRetentionChecks)];
      else if(protocolStage==='retention-checks')fields=[fieldDiagnostic('visualRetentionChecks','all original requirements bound to this request\'s actual frame times',(raw as any)?.visualRetentionChecks)];
      if(protocolStage)protocolDiagnostics.push({attempt:attempt+1,stage:protocolStage,...protocolStages[protocolStage],...(rawScore===null?{}:{rawScore}),...(fields?{fields}:{})});
      if(error instanceof VisualRetentionReviewError){
        retentionAttempts.push({score:rawScore,error:error.message});
        if(attempt){const failure=new VisualRetentionReviewError(error.message,{cause:error,attempts:retentionAttempts});retentionProtocolDiagnostics.set(failure,protocolDiagnostics.map(diagnostic=>({...diagnostic})));throw retainDisposition(failure);}
        reviewMessages.push({role:'user',content:'视觉保留协议存在缺项或无效绑定；原分和失败证据保留，仅依据同一份实际帧纠正。'+protocolFeedback(protocolDiagnostics.at(-1)!,requiresNewsPublication)+visualRetentionReviewInstruction(retentionRequirements)});
      }
      if(attempt||blocksModelOutputRecovery(error)){
        if(attempt&&protocolStage)throw retainDisposition(new SemanticReviewProtocolError(protocolDiagnostics,error));
        throw error;
      }
      if(protocolStage&&!(error instanceof VisualRetentionReviewError))reviewMessages.push({role:'user',content:protocolFeedback(protocolDiagnostics.at(-1)!,requiresNewsPublication)});
      try{await jobDelay(600);}catch(cancelled){throw retainDisposition(cancelled);}
    }
  }
  throw new Error('成片审查请求未完成');
}
