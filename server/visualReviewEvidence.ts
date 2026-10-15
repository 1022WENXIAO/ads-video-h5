/** These are model observations of supplied movie frames, not machine pixel
 * counts. Binding only makes the evidence attributable and auditable. */
export interface NumericVisualCheck {
  chapterId:string;frameTime:number;claim:string;expectedCount:number;observedCount:number;observedEvidence:string;
}
export interface VisualReviewContext {frameTimes:number[];chapters:Array<{id:string;start:number;end:number}>}
export const NUMERIC_VISUAL_REVIEW_INSTRUCTION='逐个核对实际画面中带明确数量的图解：标注top-k/选择k个时，数清稳定抽帧的激活节点和连接路径是否一致；柱高与数值、单位和刻度须一致。柱状图须在同一张稳定成片帧中，沿同一轴和同一零基线，先辨认至少两个刻度，再核对柱体矩形的实际顶端；数值标签文字的上沿不是柱体顶端，不能把接近最高刻度误说成对齐最高刻度。不得用不同轴、不同帧或尚未稳定的入场状态比较柱高。刻度、单位或柱边界无法清楚辨认时，只如实说明该项抽样未核验，不编造精确读数或断言数值冲突；已清楚证实的数值错误仍须列为缺陷。标注“示意”不能豁免明确数字矛盾。不要因早期动画尚未全部进入就推断缺少节点；只对可清楚观察的稳定画面报问题，不确定则说明未验证。可另返回numericVisualChecks:[{chapterId,frameTime,claim,expectedCount,observedCount,observedEvidence}]，claim逐字抄录实际数量标签，frameTime只能取本次提供的成片抽帧时点，observedEvidence说明实际看见哪些激活节点/路径；这些是模型观测，不自报机器已数像素。明确数量不一致必须列findings，不能因总分高或示意标记降为建议。每条finding只写一个具体缺陷；拼写错误必须逐字给实际原串和正确目标串，两串完全相同不构成拼写错误；同条排版问题须单独列出。';
export function parseNumericVisualChecks(value:unknown):NumericVisualCheck[]|undefined {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>24)throw new Error('数字图解观察须为不超过24项的数组。');
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('数字图解观察格式无效。');
    const v=item as Record<string,unknown>;
    if(typeof v.chapterId!=='string'||!v.chapterId.trim()||v.chapterId.length>100||typeof v.claim!=='string'||!v.claim.trim()||v.claim.length>200||typeof v.observedEvidence!=='string'||!v.observedEvidence.trim()||v.observedEvidence.length>500||typeof v.frameTime!=='number'||!Number.isFinite(v.frameTime)||v.frameTime<0||!Number.isSafeInteger(v.expectedCount)||!Number.isSafeInteger(v.observedCount)||Number(v.expectedCount)<0||Number(v.expectedCount)>1e6||Number(v.observedCount)<0||Number(v.observedCount)>1e6)throw new Error('数字图解观察缺少实际标签、数量、章节或抽帧时点。');
    const explicit=[...v.claim.matchAll(/\btop\s*[-–—]?\s*(\d+)\b|(?:选择|激活)\s*(\d+)\s*(?:个|条)/gi)].map(match=>Number(match[1]??match[2]));
    if(explicit.some(count=>count!==v.expectedCount))throw new Error('数字图解的明确数量标签与expectedCount矛盾。');
    return {chapterId:v.chapterId,frameTime:v.frameTime,claim:v.claim,expectedCount:v.expectedCount as number,observedCount:v.observedCount as number,observedEvidence:v.observedEvidence};
  });
}
export function numericVisualFindings(checks:NumericVisualCheck[]|undefined,context?:VisualReviewContext):string[]{
  if(!checks?.length)return [];
  if(!context)throw new Error('数字图解观察未绑定本次实际成片抽帧。');
  const seen=new Map<string,string>();
  return checks.flatMap(check=>{
    const chapters=context.chapters.filter(chapter=>chapter.id===check.chapterId);
    if(chapters.length!==1||!Number.isFinite(chapters[0].start)||!Number.isFinite(chapters[0].end)||chapters[0].end<=chapters[0].start||!context.frameTimes.includes(check.frameTime)||check.frameTime<chapters[0].start||check.frameTime>=chapters[0].end)throw new Error('数字图解观察的章节或时点不属于本次实际抽帧。');
    const key=JSON.stringify([check.chapterId,check.frameTime,check.claim]),value=JSON.stringify([check.expectedCount,check.observedCount]);
    if(seen.has(key)&&seen.get(key)!==value)throw new Error('同一抽帧标签的数量观察相互冲突。');
    if(seen.has(key))return [];seen.set(key,value);
    return check.expectedCount===check.observedCount?[]:[`${check.chapterId}：实际画面标签「${check.claim}」标注${check.expectedCount}个，模型观察该抽帧仅${check.observedCount}个（${check.observedEvidence}）；画面数量与标注不一致，请重绘图解。`];
  });
}

/** Remove only a logically empty spelling correction. Mixed findings retain
 * their separate real layout/fact defect and the original item is archived. */
export function filterIdenticalSpellingFindings(findings:string[]):{findings:string[];discarded:Array<{original:string;reason:string}>}{
  const discarded:Array<{original:string;reason:string}>=[];
  const filtered=findings.flatMap(original=>{
    const pattern=/(?:将|把)(?:来源名|名称|来源名称|文字|文本)?[“"「『']([^”"」』']+)[”"」』'](?:错误地)?(?:误写|错写|拼错|错误写成)为?[“"「『']([^”"」』']+)[”"」』']/g;
    const equal=[...original.matchAll(pattern)].filter(match=>match[1]===match[2]);
    if(!equal.length)return [original];
    const ranges:Array<{from:number;to:number}>=[];
    for(const match of equal.reverse()){
      let from=match.index!,to=from+match[0].length;
      // A quoted warning/denial is not itself a positive typo allegation.
      if(/(?:并非|不是|没有|并未|不应|不能说)\s*$/.test(original.slice(Math.max(0,from-8),from)))continue;
      const before=/(?:属于)?(?:渲染)?拼写错误[，,]\s*$/.exec(original.slice(0,from));
      const after=/^[，,]\s*(?:属于)?(?:渲染)?拼写错误/.exec(original.slice(to));
      if(before)from=before.index;if(after)to+=after[0].length;
      ranges.push({from,to});
    }
    if(!ranges.length)return [original];
    const merged:Array<{from:number;to:number}>=[];
    for(const range of ranges.sort((a,b)=>a.from-b.from)){const last=merged.at(-1);if(last&&range.from<=last.to)last.to=Math.max(last.to,range.to);else merged.push({...range});}
    let retained=original;for(const range of merged.reverse())retained=retained.slice(0,range.from)+retained.slice(range.to);
    retained=retained.replace(/([：:])[，,；;]+/g,'$1').replace(/[，,]{2,}/g,'，').replace(/[，,；;。\s]+$/,'').trim();
    discarded.push({original,reason:'拼写纠正的原串与目标串逐字完全相同；仅剔除此局部指控及紧邻拼写评价，保留其它文字、实际缺陷和原评分。'});
    return retained&&!/^[^：:]{1,100}[：:]\s*$/.test(retained)?[retained]:[];
  });
  return {findings:filtered,discarded};
}
