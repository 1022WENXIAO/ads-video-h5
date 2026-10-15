import { CARD_LAYOUT_RENDERER_SIGNATURE } from './drawingCardLayout';
import { numericDrawingText, assertNumericDrawingNode, NUMERIC_DRAWING_CSS, NUMERIC_DRAWING_CHECK_SCRIPT } from './drawingNumberLayout';
import type { NewsPublicationAnnotation, NewsPublicationEvidence } from '../src/types';
import { newsPublicationNoteHtml, newsPublicationNoteCss, createNewsPublicationAnnotation, newsPublicationTimestamp } from './newsTime';
import { inspectNewsPublicationHtml } from './newsPublicationHtml';
import {barChartSvg,validateBarChart,chapterBarChart,inferBarData,barChartDetail,quantitativeBarIntent,requireBarChartData} from './barChart';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AudioAnalysis, Format, LessonChapter, LessonCurveFunction, LessonPacing, LessonPresentation, LessonVisual, LessonBarChart } from '../src/types';
import { lessonDimensions, correctLessonTranscript, lessonCaptionAnalysis } from './lessonSpec';
import { captionsFromTranscript } from './timeline';
import { hashBytes, renderHtmlProject, drawingHtml, authorDrawing, validateDrawing, drawingDimensions, type HtmlDrawing } from './narrativeScenes';
import { probeVideo, runFFmpeg } from './core';
import { motionLibrary } from './motionComponents';
import {visualRepairTargets,speechOnlyRepair,lessonVisualBrief} from './visualRecovery';
import {assertVisibleContent} from './visibleContent';
import {voiceComparisonTask} from './audioQuality';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const colors=['#e56a48','#397ba4','#7b65a5'];
export function lessonCurve(fn:LessonCurveFunction,x:number,parameter=1):number{
  switch(fn){case'mse':return x*x;case'mae':return Math.abs(x);case'huber':return Math.abs(x)<=parameter ? .5*x*x : parameter*(Math.abs(x)-.5*parameter);case'cross-entropy':return -Math.log(x);case'hinge':return Math.max(0,1-x);case'focal':return -((1-x)**parameter)*Math.log(x);}
}
function curveSvg(chapter:LessonChapter):string{
  const p=chapter.visual.plot!;const x=(v:number)=>74+(v-p.xMin)/(p.xMax-p.xMin)*552,y=(v:number)=>318-(v-p.yMin)/(p.yMax-p.yMin)*256;
  const ticks=Array.from({length:5},(_,i)=>{
    const xv=p.xMin+(p.xMax-p.xMin)*i/4,yv=p.yMin+(p.yMax-p.yMin)*i/4;
    return `<line x1="74" y1="${y(yv)}" x2="626" y2="${y(yv)}" stroke="#e8e2da"/><text x="62" y="${y(yv)+7}" text-anchor="end">${+yv.toFixed(2)}</text><text x="${x(xv)}" y="347" text-anchor="middle">${+xv.toFixed(2)}</text>`;
  }).join('');
  const paths=p.curves.map((c,i)=>{
    const points=Array.from({length:121},(_,j)=>{const xv=p.xMin+(p.xMax-p.xMin)*j/120;const yv=lessonCurve(c.fn,xv,c.parameter??(c.fn==='focal'?2:1));return `${j?'L':'M'}${x(xv).toFixed(2)} ${y(yv).toFixed(2)}`;}).join(' ');
    const legendWidth=552/p.curves.length,left=74+i*legendWidth;
    return `<path id="curve-${i}" d="${points}" stroke="${colors[i]}" stroke-width="4" fill="none" clip-path="url(#plot-clip)"/><g id="legend-${i}"><line x1="${left}" y1="25" x2="${left+22}" y2="25" stroke="${colors[i]}" stroke-width="4"/><text data-math-width="${legendWidth-40}" data-math-min-font="22" x="${left+30}" y="32" fill="${colors[i]}" font-size="24" font-weight="600">${escape(c.label)}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 700 405" aria-label="${escape(p.yLabel)}随${escape(p.xLabel)}的函数曲线"><defs><clipPath id="plot-clip"><rect x="74" y="62" width="552" height="256"/></clipPath></defs><g id="axes" font-size="20" fill="#575a61">${ticks}<path d="M74 62V318H626" fill="none" stroke="#8f9298" stroke-width="2"/><text x="350" y="391" text-anchor="middle" font-size="23">${escape(p.xLabel)}</text><text x="12" y="52" font-size="22">${escape(p.yLabel)}</text></g>${paths}</svg>`;
}
// Split only outside nested mathematical groups: the slash in sim(q,x)/τ
// must stay inside the exponent, rather than becoming the outer fraction.
function outerOperator(value:string,operator:string):number{
  let depth=0;
  for(let i=0;i<value.length;i++){
    if('([{'.includes(value[i]))depth++;
    else if(')]}'.includes(value[i]))depth--;
    else if(depth===0&&value[i]===operator)return i;
  }
  return -1;
}
function unwrap(value:string):string{
  const trimmed=value.trim();
  if(trimmed[0]!=='('||trimmed.at(-1)!==')')return trimmed;
  let depth=0;for(let i=0;i<trimmed.length;i++){if(trimmed[i]==='(')depth++;else if(trimmed[i]===')')depth--;if(depth===0&&i<trimmed.length-1)return trimmed;}
  return trimmed.slice(1,-1).trim();
}
export function lessonFormulaParts(formula:string):Array<{prefix?:string;numerator?:string;denominator?:string[];text?:string}>{
  return formula.split(/[;；\n]/).map(v=>v.trim()).filter(Boolean).map(text=>{
    const open=text.indexOf('['),close=text.lastIndexOf(']');
    if(open>=0&&close===text.length-1){
      const inside=text.slice(open+1,close),slash=outerOperator(inside,'/');
      if(slash>=0){const denominator=unwrap(inside.slice(slash+1)),plus=outerOperator(denominator,'+');return {prefix:text.slice(0,open).trim(),numerator:inside.slice(0,slash).trim(),denominator:plus<0?[denominator]:[denominator.slice(0,plus).trim(),'+ '+denominator.slice(plus+1).trim()]};}
    }
    const log=text.match(/^(.*?)log\s*\((.*)\)$/);
    if(log){const slash=outerOperator(log[2],'/');if(slash>=0)return {prefix:log[1]+'log',numerator:log[2].slice(0,slash).trim(),denominator:[log[2].slice(slash+1).trim()]};}
    return {text};
  });
}
function formulaSvg(formula:string):string{
  const parts=lessonFormulaParts(formula),step=252/parts.length;
  const rows=parts.map((part,i)=>{
    const center=48+step*(i+.5);
    if(part.text)return `<g id="formula-${i}"><text data-math-width="620" data-math-min-font="28" x="350" y="${center+14}" text-anchor="middle" font-size="44">${escape(part.text)}</text></g>`;
    const denominator=part.denominator!,bar=center-(denominator.length===2?8:0),x=430,left=192,right=666;
    return `<g id="formula-${i}"><text data-math-width="154" data-math-min-font="28" x="98" y="${center+10}" text-anchor="middle" font-size="32">${escape(part.prefix!)}</text><text data-math-width="${right-left-12}" data-math-min-font="28" x="${x}" y="${bar-15}" text-anchor="middle" font-size="34">${escape(part.numerator!)}</text><path d="M${left} ${bar}H${right}" stroke="#282c38" stroke-width="2"/>${denominator.map((line,j)=>`<text data-math-width="${right-left-12}" data-math-min-font="28" x="${x}" y="${bar+34+j*35}" text-anchor="middle" font-size="32">${escape(line)}</text>`).join('')}<path d="M184 ${bar-56}H177V${bar+denominator.length*36+12}H184 M674 ${bar-56}H681V${bar+denominator.length*36+12}H674" stroke="#282c38" stroke-width="2" fill="none"/></g>`;
  }).join('');
  return `<svg class="formula" viewBox="0 0 700 350" aria-label="${escape(formula)}"><rect x="12" y="48" width="676" height="252" rx="26" fill="#fff0e9"/><g font-family="Arial,'PingFang SC',sans-serif" fill="#282c38">${rows}</g></svg>`;
}

export const NEWS_ILLUSTRATIONS=['interface','steps','code','character','controller','interaction','gallery','announcement','signal','hardware','modules','thermos','bar-chart','book','clothing','desk','coffee','orbit','battery','map'] as const;
function newsIllustration(item:LessonVisual['items'][number],index:number):string{
  const subject=item.label+' '+item.detail;
  const inferred=/风格|画风/.test(subject)?'gallery':/视线|鼠标|交互/.test(subject)?'interaction':/英雄|超人|角色/.test(subject)?'character':/代码|编程|JavaScript/i.test(subject)?'code':/公告|官网/.test(subject)?'announcement':/界面|标签|页面/.test(subject)?'interface':/步骤|第.{1,2}步|关闭联网/.test(subject)?'steps':'signal';
  const object=/保温|真空|杯壁|反射层/.test(subject)?'thermos':/柱状|纵轴|横轴|零基线/.test(subject)?'bar-chart':/读书|阅读|书页/.test(subject)?'book':/T恤|折衣|衣服|衣袖/.test(subject)?'clothing':/书桌|桌面|收纳/.test(subject)?'desk':/咖啡|滤杯|手冲/.test(subject)?'coffee':/月亮|地球|日食|月食/.test(subject)?'orbit':/电池|储能/.test(subject)?'battery':/杭州|城市|地图/.test(subject)?'map':/手柄|摇杆|GameCube/i.test(subject)?'controller':/专家|路由|稀疏模块/.test(subject)?'modules':/显卡|显存|内存|固态|硬盘|\b(?:GPU|CPU|SSD|VRAM|RAM)\b|RTX\s*\d|RX\s*\d/i.test(subject)?'hardware':/画风|绘画风格/.test(subject)?'gallery':/英雄|超人/.test(subject)?'character':undefined;
  const kind=object||(item.illustration&&NEWS_ILLUSTRATIONS.includes(item.illustration)?item.illustration:inferred);
  const hero='<path d="M65 53L38 120Q90 139 145 117L110 53" fill="var(--news-accent)" opacity=".7"/><circle cx="88" cy="33" r="17" fill="currentColor"/><path d="M62 57Q87 47 115 57L124 104H107L100 86V133H78V86L70 104H53Z" fill="#54779b"/><path d="M79 66L97 66L103 78L88 91L74 78Z" fill="var(--news-accent)"/>';
  const frame='<rect x="12" y="16" width="156" height="114" rx="10" fill="none" stroke="currentColor" stroke-width="3"/><path d="M12 41H168" stroke="#95a2b5" stroke-width="2"/><circle cx="27" cy="29" r="3" fill="var(--news-accent)"/><circle cx="39" cy="29" r="3" fill="#95a2b5"/>';
  const person='<circle cx="90" cy="34" r="19" fill="currentColor"/><path d="M42 129V93Q44 66 90 62Q136 66 138 93V129Z" fill="#54779b"/><path d="M87 70H94L101 114L90 127L80 114Z" fill="var(--news-accent)"/>';
  const controller='<path d="M39 44Q90 31 141 44L167 99Q177 132 154 131L125 108H55L26 131Q3 132 13 99Z" fill="#54779b" stroke="currentColor" stroke-width="3"/><path d="M38 66H57M47 57V76" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="67" cy="94" r="13" fill="#101622" stroke="#95a2b5" stroke-width="2"/><circle cx="118" cy="103" r="10" fill="var(--news-accent)"/><circle cx="137" cy="64" r="11" fill="var(--news-accent)"/><circle cx="118" cy="74" r="6" fill="currentColor"/><circle cx="141" cy="86" r="5" fill="currentColor"/>';
  const components:Array<[string,string]>=[];
  if(/显卡|显存|\b(?:GPU|VRAM)\b|RTX\s*\d|RX\s*\d/i.test(subject))components.push(['GPU','<path d="M18 43H162V103H18Z" fill="#54779b" stroke="currentColor" stroke-width="3"/><circle cx="62" cy="73" r="22" fill="#101622" stroke="var(--news-accent)" stroke-width="3"/><circle cx="118" cy="73" r="22" fill="#101622" stroke="var(--news-accent)" stroke-width="3"/><path d="M49 60L75 86M75 60L49 86M105 60L131 86M131 60L105 86M34 106H125" stroke="currentColor" stroke-width="3"/><path d="M12 35V111" stroke="currentColor" stroke-width="5"/>']);
  if(/内存|\b(?:RAM|DDR\d?)\b/i.test(subject))components.push(['RAM','<rect x="18" y="48" width="144" height="50" rx="4" fill="#54779b" stroke="currentColor" stroke-width="3"/><path d="M27 57H50V87H27ZM61 57H84V87H61ZM95 57H118V87H95ZM129 57H152V87H129Z" fill="#101622"/><path d="M27 101H84M100 101H153" stroke="var(--news-accent)" stroke-width="5"/>']);
  if(/固态|硬盘|\bSSD\b/i.test(subject))components.push(['SSD','<rect x="18" y="51" width="144" height="45" rx="7" fill="#54779b" stroke="currentColor" stroke-width="3"/><rect x="31" y="59" width="31" height="29" rx="3" fill="#101622"/><rect x="76" y="59" width="31" height="29" rx="3" fill="#101622"/><circle cx="145" cy="74" r="6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M10 57V68M10 80V91" stroke="var(--news-accent)" stroke-width="6"/>']);
  if(/\bCPU\b|处理器/i.test(subject)||!components.length)components.push(['CPU','<rect x="50" y="34" width="80" height="80" rx="8" fill="#54779b" stroke="currentColor" stroke-width="3"/><rect x="68" y="52" width="44" height="44" rx="4" fill="var(--news-accent)"/><path d="M61 23V34M80 23V34M100 23V34M119 23V34M61 114V125M80 114V125M100 114V125M119 114V125M39 45H50M39 64H50M39 84H50M39 103H50M130 45H141M130 64H141M130 84H141M130 103H141" stroke="currentColor" stroke-width="3"/>']);
  const hardware=components.slice(0,4).map(([name,shape],i,all)=>`<g data-component="${name}" transform="translate(${all.length===1?0:(i%2)*90} ${all.length<=2?0:Math.floor(i/2)*70}) scale(${all.length===1?1:.5})">${shape}<text x="90" y="140" text-anchor="middle" font-size="20" fill="currentColor">${name}</text></g>`).join('');
  const modules='<circle cx="19" cy="72" r="13" fill="var(--news-accent)"/><path d="M33 72H55M55 38V110M55 38H81M55 72H81M55 110H81" stroke="currentColor" stroke-width="3" fill="none"/>'+[0,1,2].map(i=>`<rect x="83" y="${22+i*36}" width="70" height="27" rx="5" fill="${i===1?'var(--news-accent)':'#54779b'}" opacity="${i===1?1:.45}"/><path d="M96 ${33+i*36}H138M96 ${40+i*36}H126" stroke="${i===1?'#101622':'currentColor'}" stroke-width="3"/>`).join('');
  // A single reported amount is a value card, not an invented comparison.
  // Full quantitative charts use the separately validated barChart data.
  const metrics=[...item.label.matchAll(/([<>≤≥＜＞]?\s*\d+(?:\.\d+)?)(亿美元|亿元|万美元|万元|美元|元|%|％|GB|MB|台|个|人|次)/g)];
  const metricCard=metrics.length===1?`<rect data-metric="true" x="14" y="23" width="152" height="102" rx="12" fill="none" stroke="currentColor" stroke-width="3"/><text data-math-width="132" data-math-min-font="18" x="90" y="68" text-anchor="middle" font-size="32" fill="currentColor">${escape(metrics[0][1].trim())}</text><text x="90" y="103" text-anchor="middle" font-size="20">${escape(metrics[0][2])}</text>`:undefined;
  const topical:Record<string,string>={
    thermos:'<path d="M55 22H125V120Q90 139 55 120Z" fill="#e5edf3" stroke="currentColor" stroke-width="3"/><path d="M68 28H112V109Q90 123 68 109Z" fill="#f6bd91" stroke="#c16442" stroke-width="3"/><path d="M68 24H112" stroke="#54779b" stroke-width="9"/><path d="M27 53L49 53M27 81L49 81M132 53H153M132 81H153" stroke="var(--news-accent)" stroke-width="3" stroke-dasharray="4 4"/><path d="M42 47L49 53L42 59M139 75L132 81L139 87" stroke="var(--news-accent)" fill="none" stroke-width="3"/>',
    'bar-chart':metricCard||'<path d="M25 20V118H168" fill="none" stroke="currentColor" stroke-width="3"/><path d="M22 88H168M22 58H168M22 28H168" stroke="#bbc7d2" stroke-dasharray="3 4"/><rect x="47" y="66" width="34" height="50" fill="#54779b"/><rect x="110" y="32" width="34" height="84" fill="var(--news-accent)"/><text x="10" y="122" font-size="15">0</text><text x="65" y="138" text-anchor="middle" font-size="16">甲</text><text x="127" y="138" text-anchor="middle" font-size="16">乙</text>',
    book:'<path d="M15 28Q50 13 90 35Q130 13 165 28V117Q127 103 90 123Q52 103 15 117Z" fill="#f6ecd9" stroke="currentColor" stroke-width="3"/><path d="M90 35V123M30 48L73 58M30 70L73 80M110 58L151 48M110 80L151 70" stroke="#54779b" stroke-width="3"/>',
    clothing:'<path d="M60 27L31 34L13 70L43 85L55 64V127H125V64L138 85L168 70L149 34L120 27Q90 49 60 27Z" fill="#54779b" stroke="currentColor" stroke-width="3"/><path d="M72 53V114M108 53V114M61 85H119" stroke="#f6ecd9" stroke-width="2" stroke-dasharray="4 4"/>',
    desk:'<path d="M14 91H166V105H14ZM31 105V134M149 105V134" fill="#c69a72" stroke="currentColor" stroke-width="3"/><rect x="43" y="23" width="96" height="58" rx="5" fill="#54779b"/><path d="M90 81V91M67 89H113" stroke="currentColor" stroke-width="4"/>',
    coffee:'<path d="M48 30H132L108 81H72Z" fill="#b87652" stroke="currentColor" stroke-width="3"/><path d="M62 95H119V126H62ZM119 99H135Q148 114 129 120H119" fill="none" stroke="currentColor" stroke-width="3"/><path d="M90 82V92M59 40L78 73M121 40L102 73" stroke="#54779b" stroke-width="3"/>',
    orbit:'<ellipse cx="93" cy="75" rx="74" ry="45" fill="none" stroke="#95a2b5" stroke-width="2"/><circle cx="90" cy="75" r="23" fill="#54779b"/><circle cx="150" cy="49" r="12" fill="#c7c5bc"/><path d="M16 47L61 70M16 76H61M16 105L61 80" stroke="var(--news-accent)" stroke-width="3"/>',
    battery:'<rect x="18" y="45" width="135" height="66" rx="7" fill="none" stroke="currentColor" stroke-width="3"/><path d="M153 65H164V91H153" fill="currentColor"/><path d="M72 54L55 82H86L76 103L115 72H86L98 54Z" fill="var(--news-accent)"/>',
    map:'<path d="M18 36L62 21L114 38L162 21V112L114 128L62 111L18 128Z" fill="#e5edf3" stroke="currentColor" stroke-width="3"/><path d="M62 21V111M114 38V128" stroke="#95a2b5" stroke-width="2"/><circle cx="92" cy="68" r="13" fill="var(--news-accent)"/><path d="M86 77L92 88L99 77" fill="var(--news-accent)"/>',
  };
  const drawing=topical[kind]||(kind==='hardware'?hardware:kind==='modules'?modules:kind==='controller'?controller:kind==='character'?(/英雄|超人/.test(subject)?hero:person):kind==='interaction'?'<ellipse cx="72" cy="64" rx="44" ry="24" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="84" cy="64" r="12" fill="var(--news-accent)"/><path d="M107 65L145 88" stroke="#95a2b5" stroke-width="2" stroke-dasharray="5 4"/><path d="M142 81L160 120L145 113L139 126L130 121L137 108L123 105Z" fill="currentColor"/>':kind==='gallery'?'<rect x="5" y="29" width="49" height="90" rx="7" fill="none" stroke="currentColor" stroke-width="2"/><rect x="65" y="18" width="50" height="112" rx="7" fill="none" stroke="var(--news-accent)" stroke-width="3"/><rect x="126" y="29" width="49" height="90" rx="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="30" cy="54" r="9" fill="var(--news-accent)"/><path d="M17 72L43 72L47 105H12Z" fill="#54779b"/><g transform="translate(51 39) scale(.44)">'+hero+'</g><circle cx="150" cy="54" r="9" fill="#54779b"/><path d="M136 72L166 72L170 105H132Z" fill="var(--news-accent)"/>':kind==='code'?frame+'<path d="M60 63L43 81L60 99M121 63L138 81L121 99M99 59L80 104" stroke="var(--news-accent)" stroke-width="5" fill="none"/>':kind==='steps'?`<path d="M20 91H160" stroke="#95a2b5" stroke-width="3"/><circle cx="43" cy="91" r="22" fill="var(--news-accent)"/><text x="43" y="98" text-anchor="middle" font-size="21" fill="#101622">${index+1}</text><path d="M83 78L101 91L83 104" stroke="currentColor" stroke-width="4" fill="none"/><rect x="115" y="69" width="44" height="44" rx="10" fill="none" stroke="currentColor" stroke-width="3"/><path d="M125 91L134 100L150 82" stroke="var(--news-accent)" stroke-width="3" fill="none"/>`:kind==='interface'||kind==='announcement'?frame+`<rect x="28" y="56" width="124" height="21" rx="5" fill="var(--news-accent)" opacity=".4"/><path d="M30 92H124M30 108H99" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>`:'<circle cx="90" cy="73" r="48" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="90" cy="73" r="30" stroke="#95a2b5" stroke-width="2" fill="none"/><path d="M90 73L126 38" stroke="var(--news-accent)" stroke-width="4"/><circle cx="125" cy="39" r="6" fill="var(--news-accent)"/><path d="M20 73H160M90 17V129" stroke="#95a2b5" stroke-width="1" stroke-dasharray="4 5"/>');
  return `<svg class="news-illustration" data-illustration="${kind}" viewBox="0 0 180 145" role="img" aria-label="${escape(item.label)}示意图">${drawing}</svg>`;
}

export function lessonSceneHtml(chapter:LessonChapter,index:number,total:number,duration:number,format:Format,presentation?:LessonPresentation,news=false,barChart?:LessonBarChart,publicationAnnotation?:NewsPublicationAnnotation):string{
  const urgent=presentation?.mood==='urgent';
  const [w,h]=lessonDimensions(format),portrait=h>w;
  const count=chapter.visual.items.length;barChart=chapterBarChart(chapter,barChart);
  const smallSide=!portrait&&(Boolean(barChart)||chapter.visual.kind==='curve'||chapter.visual.kind==='formula');
  const labelSize=smallSide&&count>=3?(count===4?18:22):portrait?29:26;
  const detailSize=smallSide&&count>=3?(count===4?14:18):portrait?24:21;
  const padding=smallSide&&count>=3?(count===4?8:10):portrait?20:16;
  const naturalTitleSize=Math.min(portrait?48:50,Math.max(portrait?34:38,Math.floor((w-(portrait?72:96))/[...chapter.title].length)));
  const singleLineTitleSize=Math.floor((w-(portrait?72:96))/Math.max(1,[...chapter.title].length));
  const titleSize=publicationAnnotation&&!portrait&&singleLineTitleSize>=34?Math.min(naturalTitleSize,singleLineTitleSize):naturalTitleSize;

  const side=Boolean(barChart)||chapter.visual.kind==='curve'||chapter.visual.kind==='formula';
  const cards=chapter.visual.items.map((item,i)=>`<article id="item-${i}" class="teaching-item"><span class="item-number">${String(i+1).padStart(2,'0')}</span><div><h2>${escape(item.label)}</h2><p>${escape(barChartDetail(item,barChart))}</p></div>${!barChart&&(news||!side&&(item.illustration||/保温|真空|杯壁|反射层|柱状|纵轴|横轴|零基线|读书|阅读|书页|T恤|衣服|书桌|收纳|咖啡|滤杯|月亮|地球|日食|月食|电池|杭州|地图|步骤/.test(item.label+' '+item.detail)))?newsIllustration(item,i):''}</article>`).join('');
  const graphic=barChart?barChartSvg(barChart):chapter.visual.kind==='curve'?curveSvg(chapter):chapter.visual.kind==='formula'?formulaSvg(chapter.visual.formula!):'';
  const cues=chapter.cues||chapter.visual.items.map((v,i)=>({text:v.cue,start:.4+i*Math.max(1,(duration-3)/chapter.visual.items.length),end:1+i}));
  const enters=chapter.visual.items.map((_,i)=>{
    const at=Math.max(.35,Math.min(duration-2,cues[i]?.start??.4+i));
    return `tl.from('#item-${i}',{y:10,duration:${urgent ? .24 : .45},ease:'power3.out'},${(.12+i*.12).toFixed(3)});QJMotion.focusPulse(tl,'#item-${i}',${(at+.1).toFixed(3)},.6);`;
  }).join('');
  const curves=chapter.visual.plot?.curves.map((_,i)=>`QJMotion.connectorFlow(tl,'#curve-${i}',${(.65+i*.18).toFixed(3)},1.1);tl.from('#legend-${i}',{opacity:0,x:-8,duration:.4,ease:'sine.out'},.4);`).join('')||'';
  const formula=chapter.visual.formula?chapter.visual.formula.split(/[;；\n]/).filter(Boolean).map((_,i)=>`tl.from('#formula-${i}',{opacity:0,duration:.5,ease:'sine.out'},${(.6+i*.2).toFixed(3)});`).join(''):'';
  const takeawayAt=Math.max(1,Math.min(duration-3.2,(cues.at(-1)?.end??duration-4)+.3));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
@font-face{font-family:'PingFang SC';src:local('PingFang SC')}@font-face{font-family:'Noto Sans CJK SC';src:local('Noto Sans CJK SC')}
*{box-sizing:border-box}#main{--news-accent:#c16442}.news-illustration{width:110px;height:100px;flex:none;color:#39516b}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#fffdfa;color:#282c38;font-family:'PingFang SC','Noto Sans CJK SC',Arial,sans-serif}#main{width:${w}px;height:${h}px;position:relative;padding:${portrait?36:28}px ${portrait?36:48}px}h1{margin:0;font-size:${titleSize}px;line-height:1.18;letter-spacing:-1px;max-width:100%;overflow-wrap:anywhere}.lesson-content{position:absolute;left:${portrait?36:48}px;right:${portrait?36:48}px;top:${portrait?155:125}px;height:${portrait?850:395}px;display:${side?'grid':'flex'};${side?`grid-template-${portrait?'rows':'columns'}:${portrait?'1.12fr 1fr':'1.3fr 1fr'};`:''}gap:${portrait?24:28}px;align-items:center}.graphic{width:100%;height:100%;display:flex;align-items:center}.chart,.formula{width:100%;max-height:100%;overflow:visible}.teaching-items{display:flex;flex-direction:${!side&&!portrait?'row':'column'};gap:14px;width:100%;height:100%;justify-content:center}.teaching-item{position:relative;border:2px solid #e7dfd8;border-radius:18px;background:#fffdfa;display:flex;gap:16px;padding:${padding}px;flex:1;min-width:0;align-items:center}.teaching-item h2{font-size:${labelSize}px;line-height:1.2;margin:0 0 6px;overflow-wrap:anywhere}.teaching-item p{font-size:${detailSize}px;line-height:1.35;margin:0;color:#5a5e68;overflow-wrap:anywhere}.item-number{flex:none;color:#a64a31;font-size:${portrait?26:22}px;line-height:1;font-variant-numeric:tabular-nums}.wide-items .teaching-item{flex-direction:column;align-items:flex-start;justify-content:center;background:#fff3ec}.wide-items h2{font-size:${portrait?32:32}px}.wide-items p{font-size:${portrait?26:24}px;text-wrap:balance}.timeline-items{position:relative}.timeline-items:before{content:'';position:absolute;${portrait?'left:20px;top:0;bottom:0;width:3px':'top:18px;left:0;right:0;height:3px'};background:#4c95b7}.timeline-items .teaching-item{border-top:5px solid #4c95b7}.timeline-items .item-number{background:#397ba4;color:white;border-radius:50%;padding:8px;font-size:18px;z-index:1}${count===2?'.comparison-items .teaching-item:nth-child(2){background:#eaf3f7;border-color:#4c95b7}':''}.takeaway{position:absolute;left:${portrait?36:48}px;right:${portrait?36:48}px;top:${portrait?1030:537}px;margin:0;border-left:4px solid #e56a48;padding:8px 18px;font-size:${portrait?30:27}px;line-height:1.3;max-height:${portrait?100:76}px;overflow-wrap:anywhere}.accent{position:absolute;top:0;left:0;width:100%;height:${news?6:0}px;background:#e56a48}
${urgent?`html,body{background:#101622;color:#f6f3ed}#main{background:radial-gradient(ellipse at top right,#382027,transparent 58%)}.teaching-item,.wide-items .teaching-item,.comparison-items .teaching-item:nth-child(2){background:#1d2533;border-color:#344457;border-left:5px solid #ff625d}.teaching-item p{color:#ced5df}.item-number{color:#ff847d}.takeaway{border-color:#ff625d}.accent{background:#ff625d}.timeline-items:before{background:#ff625d}.timeline-items .teaching-item{border-top-color:#ff625d}.timeline-items .item-number{background:#a3333a;color:#fff}.chart text,.formula text{fill:#f6f3ed}.formula>rect{fill:#1d2533}.formula path{stroke:#f6f3ed}`:''}
${!news?`#main .teaching-item:has(.news-illustration){${portrait?'display:grid;grid-template-columns:26px minmax(0,1fr) 110px;':'flex-direction:column;align-items:flex-start;justify-content:center;gap:10px' }}`:''}
${news?`#main{--news-accent:${urgent?"#ff625d":"#e56a48"}}.news-label{font-size:20px;letter-spacing:3px;color:${urgent?"var(--news-accent)":"#a64a31"};margin-bottom:12px}.news-composition .teaching-item{${portrait?"display:grid;grid-template-columns:44px minmax(0,1fr) 180px;":"display:flex;flex-direction:column;align-items:flex-start;"}gap:18px;flex:0 1 ${portrait?(count===4?198:250):395}px;min-height:${portrait?176:0}px}.news-composition .item-number{display:flex;align-items:center;justify-content:center;min-width:44px;width:44px;padding:8px 0;line-height:1.2}.news-illustration{width:${portrait?180:160}px;height:${portrait?145:130}px;max-width:100%;flex:none;color:inherit}.news-composition .teaching-items{justify-content:center}.news-composition .takeaway{border-left-width:7px;background:${urgent?"#1d2533":"#fff0e9"};border-radius:12px;padding:18px}.news-composition .wide-items h2{font-size:${portrait?30:27}px}.news-composition .wide-items p{font-size:${portrait?25:23}px}`:""}
${publicationAnnotation?newsPublicationNoteCss(portrait)+`.lesson-content{top:${portrait?220:160}px;height:${portrait?785:360}px}`:''}</style><script src="./gsap.min.js"></script></head><body><section id="main" class="${news?"news-composition":""}" data-composition-id="main" data-width="${w}" data-height="${h}" data-start="0" data-duration="${duration}"><div id="accent" class="accent"></div><header>${news&&!publicationAnnotation?'<div class="news-label">资讯核验 · 示意画面</div>':""}<h1 id="title">${escape(chapter.title)}</h1></header>${publicationAnnotation?newsPublicationNoteHtml(publicationAnnotation):''}<main class="lesson-content">${side?`<div id="graphic" class="graphic">${graphic}</div>`:''}<div class="teaching-items ${side?'':'wide-items'} ${chapter.visual.kind==='timeline'?'timeline-items':''} ${chapter.visual.kind==='comparison'?'comparison-items':''}">${cards}</div></main><p id="takeaway" class="takeaway">${escape(chapter.visual.takeaway)}</p></section><script>
// Measure SVG glyphs in the actual rendering browser before any motion. The
// general layout inspector sees the SVG box, but cannot see overflowing text.
for(const node of document.querySelectorAll('[data-math-width]')){
  const limit=Number(node.dataset.mathWidth),minimum=Number(node.dataset.mathMinFont);let size=Number(node.getAttribute('font-size'));
  while(node.getComputedTextLength()>limit&&size>minimum){size--;node.setAttribute('font-size',String(size));}
  if(node.getComputedTextLength()>limit+.5)throw new Error('教学公式/图例超出可读布局：'+node.textContent+'。缩短图例或拆分公式，不能继续缩小字号。');
}

${motionLibrary}window.__timelines={};const tl=gsap.timeline({paused:true});tl.from('#accent',{scaleX:0,transformOrigin:'left',duration:.6,ease:'power2.out'},.1);tl.from('#title',{y:${publicationAnnotation&&!portrait?0:20},duration:.6,ease:'power3.out'},.05);${side?"tl.from('#graphic',{opacity:0,y:12,duration:.6,ease:'power2.out'},.45);":''}${enters}${curves}${formula}tl.to('#title',{opacity:0,duration:.2,ease:'sine.in'},${Math.max(.8,duration-.35).toFixed(3)});tl.from('#takeaway',{opacity:0,x:-12,duration:.5,ease:'power2.out'},${takeawayAt.toFixed(3)});${urgent?`tl.to('#accent',{opacity:.55,duration:.45,repeat:${Math.min(10,Math.floor(duration/1.1))},yoyo:true,ease:'sine.inOut'},1);`:''}window.__timelines.main=tl;</script></body></html>`;
}

export function lessonRendererHash(){
  // Include helpers behind the renderer/caption functions as well as their
  // entry points: a changed closure policy must invalidate prior evidence.
  const policies=['./lessonHtmlRecovery.ts','./lessonHtmlFallbackPolicy.ts','./drawingGeometry.ts','./drawingCardLayout.ts','./narrativeScenes.ts','./visualRecovery.ts','./visualReviewEvidence.ts','./visualRetentionReview.ts','./visualRetentionSources.ts','./reviewResults.ts','./semanticReview.ts','./renderReview.ts','./lessonLayoutRepair.ts','./lessonModelVersions.ts','./lessonModelSpelling.ts','./lessonRepairScope.ts','./lessonAudio.ts','./lessonSpeechProof.ts','./narrationBatchRecovery.ts','./taskPool.ts','./narrationHomophones.ts','./lessonSpec.ts','./lessonCommonSpelling.ts','./lessonSpeechCoverage.ts','./newsTime.ts','../package.json'].map(file=>readFileSync(new URL(file,import.meta.url),'utf8'));
  return hashBytes([...policies,CARD_LAYOUT_RENDERER_SIGNATURE,lessonSceneHtml,newsIllustration,curveSvg,formulaSvg,drawingHtml,authorDrawing,validateDrawing,drawingDimensions,barChartSvg,validateBarChart,chapterBarChart,inferBarData,barChartDetail,quantitativeBarIntent,requireBarChartData,visualRepairTargets,speechOnlyRepair,lessonVisualBrief,createNewsPublicationAnnotation,newsPublicationTimestamp,newsPublicationNoteHtml,newsPublicationNoteCss,inspectNewsPublicationHtml,numericDrawingText,assertNumericDrawingNode,NUMERIC_DRAWING_CSS,NUMERIC_DRAWING_CHECK_SCRIPT,assertVisibleContent,correctLessonTranscript,lessonCaptionAnalysis,captionsFromTranscript,voiceComparisonTask].map(fn=>fn.toString()).join('\n'));
}

export async function produceLessonScene(chapter:LessonChapter,index:number,total:number,format:Format,speechFile:string,analysis:AudioAnalysis,project:string,pacing?:LessonPacing,presentation?:LessonPresentation,news=false,drawing?:HtmlDrawing,barChart?:LessonBarChart,publicationAnnotation?:NewsPublicationAnnotation){
  // Verified quantitative data takes precedence over any supplied authored
  // drawing. Cached/model geometry cannot override the compiled chart scale.
  barChart=chapterBarChart(chapter,barChart);
  const lead=pacing?.leadSeconds??.35,tail=pacing?.tailSeconds??.55,duration=+(analysis.duration+lead+tail).toFixed(3);
  const shifted={...chapter,cues:chapter.cues?.map(c=>({...c,start:c.start+lead,end:c.end+lead}))};
  const html=drawing&&!barChart?drawingHtml(drawing,duration,format,publicationAnnotation):lessonSceneHtml(shifted,index,total,duration,format,presentation,news,barChart,publicationAnnotation),htmlHash=hashBytes(html);await mkdir(project,{recursive:true});
  const visual=path.join(project,'visual.mp4'),output=path.join(project,'scene.mp4');
  let cached=false;try{const meta=JSON.parse(await readFile(path.join(project,'visual-cache.json'),'utf8'));cached=meta.htmlHash===htmlHash&&Math.abs((await probeVideo(visual)).duration-duration)<.1;}catch{}
  let publicationCheck:Awaited<ReturnType<typeof inspectNewsPublicationHtml>>|undefined;
  await writeFile(path.join(project,'index.html'),html);
  await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
  if(publicationAnnotation)publicationCheck=await inspectNewsPublicationHtml(project,publicationAnnotation,duration,format);
  if(!cached){await renderHtmlProject(project,visual,{fullCheck:true});await writeFile(path.join(project,'visual-cache.json'),JSON.stringify({htmlHash}),{mode:0o600});}
  await runFFmpeg(['-v','error','-y','-i',visual,'-i',speechFile,'-map','0:v','-map','1:a','-c:v','copy','-af',`adelay=${lead*1000}|${lead*1000},apad`,'-t',String(duration),'-c:a','aac','-ar','44100','-ac','2','-movflags','+faststart',output]);
  const publicationEvidence:NewsPublicationEvidence|undefined=publicationAnnotation&&publicationCheck?{...publicationAnnotation,...publicationCheck,sceneHash:hashBytes(await readFile(output)),htmlVerified:true}:undefined;
  return {file:output,duration,htmlHash,publicationEvidence,audioHash:hashBytes(await readFile(speechFile)),analysis:{...analysis,duration,sourceHash:hashBytes(await readFile(output)),sentences:analysis.sentences.map(s=>({...s,start:s.start+lead,end:s.end+lead,words:s.words.map(w=>({...w,start:w.start+lead,end:w.end+lead}))})),pauses:[{start:0,end:lead},...analysis.pauses.map(p=>({start:p.start+lead,end:p.end+lead})),{start:duration-tail,end:duration}]}};
}
