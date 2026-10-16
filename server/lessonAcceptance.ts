import type { LessonReport,ResearchReference } from '../src/types';
import { normalizeEvidence } from './hotSources';

export const requiresTodayEvent=(prompt:string)=>prompt.split(/[。；;\n]/).some(part=>!/(?:不要|别|不是|无需).{0,12}(?:今天|今日|今早)/.test(part)&&/(?:今天|今日|今早).{0,8}(?:发生|发布|宣布|上线|公开|开源|推出)|(?:发生|发布|宣布|上线|公开|开源|推出).{0,8}(?:今天|今日|今早)|happened today|today'?s (?:release|announcement)/i.test(part));
export const beijingDate=(now=Date.now())=>new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
export const requiresSelectionReason=(prompt:string)=>prompt.split(/[。；;\n]/).some(part=>!/(?:不要|无需|不用).{0,12}(?:选题理由|选择原因|为什么选)/.test(part)&&/为什么.{0,15}(?:选|挑)|(?:说明|解释|说清|交代|说说).{0,15}(?:选.{0,12}(?:依据|原因|理由)|选题)|选题理由|explain why.{0,30}(?:chose|choose|selected)/i.test(part));

export function selectionReasonFindings(value:unknown,report:LessonReport,prompt:string):string[]{
  if(!report.hotResearch||!requiresSelectionReason(prompt))return [];
  const reason=value as {chapterId?:unknown;quote?:unknown}|undefined;
  const chapter=report.chapters?.find(c=>c.id===reason?.chapterId),quote=typeof reason?.quote==='string'?normalizeEvidence(reason.quote):'';
  const visible=chapter&&[chapter.narration,chapter.visual.takeaway,...chapter.visual.items.flatMap(i=>[i.label,i.detail])].map(normalizeEvidence);
  return quote.length>=12&&quote.length<=400&&visible?.some(text=>text.includes(quote))?[]:['用户选题依据要求：必须在旁白或实际画面中说明为什么选择这条新闻，并提供本版可定位的原句；仅说今天选某题或把理由写在内部制作记录中不足。'];
}

export function newsRenderAcceptance(prompt:string,requestedAt=Date.now()):string{
  return `原始制作指令日期为北京时间${beijingDate(requestedAt)}。评审的是这条既有制作指令，用户指令与作品中的今天、今日按原始制作指令日期解释；既有成片跨零点复核不改变当时要求的事件日期。若真实音视频已明确交代原始当日的绝对日期，不能仅因后续复核跨日就判定其当时的今天表述错误。新制作指令仍按新指令的当日验收。本片按原始用户要求审查新闻，不能套用完整课堂推导、定义或编年史要求。`+
    (requiresTodayEvent(prompt)?'用户明确要求今天发生：核心事件必须有已读正文中的当日发生或首次宣布证据；报道发表于今天、今天选题、今天关注均不能满足。缺少证据仍为阻塞缺陷。':'用户要求最新热点或值得关注的报道：允许明确交代日期的近期事件，不能把旧事件冒充当日发布。')+
    (requiresSelectionReason(prompt)?'用户明确要求说明选题依据：实际旁白或画面必须说明为什么选这条新闻，仅有选题动作或内部reason记录不足；遗漏属于用户要求未满足，应放入findings。':'')+
    '来源限定可由实际旁白或对应可读画面表达，“彭博提到”与“据彭博报道”等清楚归属的同义说法均可，核对实际音频后再判遗漏。画面摘要允许含义一致的简短转述，不能仅因与旁白不逐字一致判错；改变日期、数字、因果或不确定性仍是缺陷。不得强制用户未要求的固定底部摘要条或指定版式；重要信息确实不可读或没有呈现时须指出实际证据。用户没有要求配乐时，缺少BGM只可列为建议；明确要求配乐或紧张氛围而实际缺失仍为阻塞缺陷。'+
    '遗漏指控须说明其依据：逐字引用原始用户条款及要求的范围、精度，或指出实际未通过的客观检查项，或引用本片真实声画原句、抽帧或音频证据说明实质误导。来源中的额外背景、report.objectives或旧审核suggestions不能单独新增发布义务。同日事件与报道的日期已经清楚交代、用户未要求精确时刻且实际表达未混淆时，不能仅因未列小时分钟而要求返修；更完整的时间线可放suggestions。用户明确要求精确时刻、跨日未分清、实际时刻或时区错误以及有证据的实质误导仍是阻塞缺陷。修复建议也须依据当前可信正文与明确时区；缺少这种支持时不得指定某个精确值作为必改目标，应说明证据缺口并要求核实，旧审核不是新事实的来源。'+
    '判断日期误报须引用完整旁白中实际断言事件发生时间的原句，并与已读来源的事件日期核对。“今天选择/今天关注”是选题动作，不能单凭这几个字推断事件今天发生；若后文已准确说明事件和报道日期，仅建议导语写得更明确应放入suggestions。实际声称今天发布而证据不符、未满足明确的当日事件要求仍放入findings。各缺陷注明章节ID、实际音频或画面证据与修复要求；脚本事实审查通过不能代替实际成片审查。';
}

// Publication freshness alone does not prove an event happened today.
// A strict daily-event request needs a concrete dated passage in a source
// actually read, as well as the model's independent factual judgment.
export function hasTodayEventEvidence(ref:ResearchReference|undefined,quoteValue:string,now=Date.now()):boolean{
  const date=beijingDate(now),[year,month,day]=date.split('-').map(Number);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const fullDate=new RegExp(`${year}[-/.年]0?${month}[-/.月]0?${day}(?:日|\\b)|${months[month-1]}\\s+${day}(?:st|nd|rd|th)?,?\\s+${year}\\b`, 'i');
  const shortDate=new RegExp(`(?:^|[^\\d])0?${month}月0?${day}日|${months[month-1]}\\s+${day}(?:st|nd|rd|th)?\\b`, 'i');
  const quote=normalizeEvidence(quoteValue);
    if(ref?.verification!=='news-page'||ref.freshness==='future'||quote.length<12||quoteValue.length>400||!normalizeEvidence(ref.excerpt).includes(quote))return false;
    const publishedToday=Boolean(ref.publishedAt&&Number.isFinite(Date.parse(ref.publishedAt))&&beijingDate(Date.parse(ref.publishedAt))===date);
    const monthNames=months.map(m=>m+'|'+m.slice(0,3)).join('|');
    const timePattern=new RegExp(`(?:19|20)\\d{2}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?|\\d{1,2}月\\d{1,2}日|(?:${monthNames})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d{2})?|今天|今日|昨天|昨日|去年|上周|\\btoday\\b|\\byesterday\\b|\\blast (?:week|year|month)\\b`,'gi');
    const times=[...quoteValue.matchAll(timePattern)].map(m=>({index:m.index!,end:m.index!+m[0].length,value:m[0]}));
    for(const event of quoteValue.matchAll(/发布|宣布|上线|推出|开源|开放|更新|升级|发生|launch\w*|announc\w*|releas\w*|introduc\w*|unveil\w*/gi)){
      const index=event.index!,before=quoteValue.slice(Math.max(0,index-16),index),after=quoteValue.slice(index+event[0].length,index+event[0].length+8);
      if(/^(?:时间|日期)/.test(after)||/(?:尚未|并未|没有|未曾|未|\bnot|\bno|\bnever)[^。；;]{0,14}$/i.test(before))continue;
      const preceding=times.filter(t=>t.end<=index).at(-1),following=times.find(t=>t.index>=index+event[0].length);
      const time=preceding&&index-preceding.end<=80?preceding:following&&following.index-index<=24?following:undefined;
      if(!time)continue;
      const datePrefix=quoteValue.slice(Math.max(0,time.index-20),time.index);
      if(/(?:发布时间|发布日期|Published(?: on)?)\s*[:：]?\s*$/i.test(datePrefix))continue;
      const sameDay=fullDate.test(time.value)||!/(?:19|20)\d{2}/.test(time.value)&&shortDate.test(time.value)&&publishedToday||/^(?:今天|今日|today)$/i.test(time.value)&&publishedToday;
      if(sameDay)return true;
    }
    return false;
}
export function todayEventFindings(value:unknown,report:LessonReport,prompt:string,now=Date.now()):string[]{
  if(!report.hotResearch||!requiresTodayEvent(prompt))return [];
  const date=beijingDate(now);
  const valid=Array.isArray(value)&&value.some(e=>e&&typeof e==='object'&&e.date===date&&typeof e.quote==='string'&&hasTodayEventEvidence(report.references.find(r=>r.id===e.referenceId),e.quote,now));
  return valid?[]:[`用户时效要求：用户要求今天发生（北京时间${date}），本稿没有已读正文中可定位的当日核心事件证据。重新查找合格新闻，不能用今天报道旧事件或“今天看”替代。`];
}
