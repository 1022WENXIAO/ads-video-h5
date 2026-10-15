import { jobDelay, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { validateSemanticReview,reviewFindings } from './reviewResults';
import { requestReviewJson, type ReviewObserver } from './reviewAssets';
import { blocksModelOutputRecovery } from './executionErrors';
import { bindVisualRetentionSources, visualRetentionFindings, visualRetentionReviewInstruction, VisualRetentionReviewError, type VisualRetentionRequirement, type VisualRetentionAttempt, type VisualRetentionSourceContext } from './visualRetentionReview';
import { numericVisualFindings,type VisualReviewContext } from './visualReviewEvidence';

export type SemanticReviewProtocolStage='message-json'|'review-schema'|'news-publication'|'numeric-evidence'|'retention-binding'|'retention-checks';
const protocolStages={
  'message-json':{code:'SEMANTIC_MESSAGE_JSON_INVALID',detail:'模型消息不是有效JSON'},
  'review-schema':{code:'SEMANTIC_REVIEW_SCHEMA_INVALID',detail:'审查字段格式无效'},
  'news-publication':{code:'SEMANTIC_NEWS_PUBLICATION_MISSING',detail:'新闻报道日期观察缺失'},
  'numeric-evidence':{code:'SEMANTIC_NUMERIC_EVIDENCE_INVALID',detail:'数字图解观察的章节或时点无效'},
  'retention-binding':{code:'SEMANTIC_RETENTION_BINDING_INVALID',detail:'视觉保留原素材证据绑定无效'},
  'retention-checks':{code:'SEMANTIC_RETENTION_CHECKS_INVALID',detail:'视觉保留逐项观察无效'},
} as const;
export interface SemanticReviewProtocolDiagnostic {attempt:number;stage:SemanticReviewProtocolStage;code:typeof protocolStages[SemanticReviewProtocolStage]['code'];detail:string;rawScore?:number}
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
    try {
      const body=await requestReviewJson(config,{model:config.modelId,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8000,messages:reviewMessages},'semantic',attempt,observe);
      protocolStage='message-json';
      const raw=JSON.parse(body.choices?.[0]?.message?.content||'');
      if(Number.isFinite(raw?.score))rawScore=raw.score;
      protocolStage='review-schema';
      // Preserve valid core fields before nested evidence bindings can fail.
      // Store the original parsed finding text before the existing typo filter.
      if(Number.isFinite(raw?.score)&&raw.score>=0&&raw.score<=100&&typeof raw.needsRepair==='boolean'){
        let originalFindings:string[]|undefined;
        try{originalFindings=reviewFindings(raw.findings);}catch{/* Invalid core finding text remains unknown. */}
        if(originalFindings)dispositionAttempts.push({attempt:attempt+1,score:raw.score,needsRepair:raw.needsRepair,findings:originalFindings});
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
      if(!attempt&&raw.needsRepair===false&&result.findings.length){
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
      if(protocolStage)protocolDiagnostics.push({attempt:attempt+1,stage:protocolStage,...protocolStages[protocolStage],...(rawScore===null?{}:{rawScore})});
      if(error instanceof VisualRetentionReviewError){
        retentionAttempts.push({score:rawScore,error:error.message});
        if(attempt){const failure=new VisualRetentionReviewError(error.message,{cause:error,attempts:retentionAttempts});retentionProtocolDiagnostics.set(failure,protocolDiagnostics.map(diagnostic=>({...diagnostic})));throw retainDisposition(failure);}
        reviewMessages.push({role:'user',content:'上一轮视觉保留核验协议无效：'+error.message+' 原分和失败证据保留，不要求提分。仅依据相同实际帧逐项纠正：'+visualRetentionReviewInstruction(retentionRequirements)});
      }
      if(attempt||blocksModelOutputRecovery(error)){
        if(attempt&&protocolStage)throw retainDisposition(new SemanticReviewProtocolError(protocolDiagnostics,error));
        throw error;
      }
      try{await jobDelay(600);}catch(cancelled){throw retainDisposition(cancelled);}
    }
  }
  throw new Error('成片审查请求未完成');
}
