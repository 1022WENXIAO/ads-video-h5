import type { LessonBarChart, LessonChapter, LessonReport, LessonVisual } from '../src/types';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
// A comparison may contain a quantitative chart even when its outer visual
// kind is not bar-chart. A single reported amount retains the value-card path.
export function quantitativeBarIntent(visual:LessonVisual):boolean {
  return visual.kind==='bar-chart'||visual.items.filter(item=>item.illustration==='bar-chart').length>=2;
}
export function requireBarChartData(visual:LessonVisual,chart=visual.barChart):LessonBarChart|undefined {
  if(!chart&&quantitativeBarIntent(visual))throw new Error('本章柱状图比较缺少结构化数值：请提供visual.barChart的bars（真实类别与数值）、unit和panels（零基线及同一刻度）。comparison中多个bar-chart信息点也须提供；不能由HTML绘图猜柱高，不能把缺失数据改成示意免责。只填写已核验来源或明确课堂演算中的数据。');
  return chart?validateBarChart(chart):undefined;
}
export function validateBarChart(chart:LessonBarChart){
  if(!chart||!Array.isArray(chart.bars)||chart.bars.length<2||chart.bars.length>6||new Set(chart.bars.map(b=>b.label)).size!==chart.bars.length)throw new Error('柱状图需要2–6个不同类别。');
  if(chart.bars.some(b=>typeof b.label!=='string'||!b.label.trim()||b.label.length>12||!Number.isFinite(b.value)||b.value<0||b.value>10000))throw new Error('柱状图类别或数值无效。');
  if(typeof chart.illustrative!=='boolean'||typeof chart.unit!=='string'||chart.unit.length>12||!Array.isArray(chart.panels)||chart.panels.length<1||chart.panels.length>2)throw new Error('柱状图须注明单位和1–2组实际坐标。');
  for(const p of chart.panels){if(!p.title||p.title.length>24||![p.min,p.max].every(Number.isFinite)||p.min<0||p.max<=p.min||p.max>10000)throw new Error('柱状图坐标范围无效。');}
  if(chart.panels.some(p=>p.min>0)&&(!chart.illustrative||chart.panels.length!==2||chart.panels[0].min!==0))throw new Error('非零基线只允许与零基线并排的明确截断示意，不能作为正常柱图。');
  return chart;
}

// Compatibility for already verified scripts: only use explicitly supplied
// category/value labels, never fabricate a canned data series for a topic.
export function inferBarData(chapters:LessonReport['chapters']):LessonBarChart|undefined{
  for(const chapter of chapters){
    const pairs=chapter.visual.items.map(item=>item.label.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)\s*([^\d\s]*)$/));
    if(pairs.some(p=>!p)||pairs.length<2)continue;
    const units=new Set(pairs.map(p=>p![3]));if(units.size!==1)continue;
    const bars=pairs.map(p=>({label:p![1].trim(),value:Number(p![2])})),max=Math.max(...bars.map(b=>b.value));
    if(max<=0||max>10000||bars.some(b=>b.value<0))continue;
    const step=10**Math.floor(Math.log10(max)),upper=Math.ceil(max/step)*step;
    return validateBarChart({bars,unit:pairs[0]![3],illustrative:true,panels:[{title:'示意数据',min:0,max:upper}]});
  }
}

export function chapterBarChart(chapter:LessonChapter,common?:LessonBarChart):LessonBarChart|undefined{
  if(chapter.visual.barChart)return requireBarChartData(chapter.visual);
  if(!common)return requireBarChartData(chapter.visual);
  const ranges=chapter.visual.items.flatMap(item=>{
    const range=item.label.match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/);
    return range?[{title:item.label,min:Number(range[1]),max:Number(range[2])}]:[];
  });
  if(ranges.length===2){
    const descriptions=chapter.visual.items.map(i=>i.detail).join(' '),specified=common.bars.filter(b=>descriptions.includes(b.label+String(b.value))||descriptions.includes(b.label+' '+String(b.value)));
    return validateBarChart({...common,bars:specified.length>=2?specified:common.bars,panels:ranges});
  }
  return common;
}

export function barChartDetail(item:LessonVisual['items'][number],chart?:LessonBarChart):string{
  if(!chart)return item.detail;
  const compact=item.label.replace(/\s/g,'');
  const bar=chart.bars.find(b=>compact===b.label+b.value+chart.unit);
  if(!bar)return item.detail;
  const values=chart.bars.map(b=>b.value),max=Math.max(...values),min=Math.min(...values);
  const rank=max===min?'各类别数值相同':bar.value===max?(values.filter(v=>v===max).length>1?'并列最高':'本组最高'):bar.value===min?(values.filter(v=>v===min).length>1?'并列最低':'本组最低'):'介于最高和最低之间';
  // Numeric cards are compiled from the verified series. Model descriptions
  // may contain animation notes; those belong to cue/reason, never the video.
  return `数值 ${bar.value}${chart.unit}；${rank}`;
}

export function barChartSvg(chart:LessonBarChart):string{
  validateBarChart(chart);
  const panels=chart.panels.length,panelWidth=700/panels;
  const contents=chart.panels.map((panel,p)=>{
    const left=p*panelWidth+45,right=(p+1)*panelWidth-12,top=68,bottom=294,width=right-left;
    const y=(value:number)=>bottom-(value-panel.min)/(panel.max-panel.min)*(bottom-top);
    const ticks=Array.from({length:5},(_,i)=>{const v=panel.min+(panel.max-panel.min)*i/4;return `<path d="M${left} ${y(v)}H${right}" stroke="#e5e7eb"/><text x="${left-8}" y="${y(v)+6}" text-anchor="end" font-size="${panels===1?21:18}">${+v.toFixed(2)}</text>`;}).join('');
    const slot=width/chart.bars.length,barWidth=Math.min(65,slot*.55);
    const bars=chart.bars.map((bar,i)=>{
      const x=left+slot*(i+.5),clipped=bar.value<panel.min||bar.value>panel.max,visible=Math.max(panel.min,Math.min(panel.max,bar.value));
      const height=bottom-y(visible),labelY=clipped&&bar.value<panel.min?bottom-12:Math.max(top+18,y(visible)-10);
      return `<g id="chart-bar-${p}-${i}" data-value="${bar.value}" data-axis-min="${panel.min}" data-axis-max="${panel.max}">${height>0?`<rect x="${x-barWidth/2}" y="${y(visible)}" width="${barWidth}" height="${height}" fill="${i%2?'#c16442':'#4c95b7'}"/>`:''}<text x="${x}" y="${labelY}" text-anchor="middle" font-size="${panels===1?24:20}">${bar.value}${clipped?(bar.value<panel.min?'↓':'↑'):''}</text><text x="${x}" y="${bottom+28}" text-anchor="middle" font-size="${panels===1?24:20}">${escape(bar.label)}</text>${clipped?`<text x="${x}" y="${bottom+54}" text-anchor="middle" font-size="18">${bar.value<panel.min?'低于下限':'高于上限'}</text>`:''}</g>`;
    }).join('');
    return `<g><text x="${(left+right)/2}" y="30" text-anchor="middle" font-size="${panels===1?26:22}">${escape(panel.title)}</text><text x="${left}" y="54" font-size="18">单位：${escape(chart.unit||'数值')}</text>${ticks}<path d="M${left} ${top}V${bottom}H${right}" fill="none" stroke="#626773" stroke-width="2"/>${bars}${panel.min>0?`<text x="${(left+right)/2}" y="379" text-anchor="middle" font-size="20" fill="#a64a31">截断示意：下限 ${panel.min}</text>`:''}</g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 700 405" role="img" aria-label="${escape(chart.illustrative?'示意柱状图':'柱状图')}" font-family="Arial,'PingFang SC',sans-serif" fill="#282c38">${contents}<text x="350" y="402" text-anchor="middle" font-size="18">${chart.illustrative?'示意数据 · ':''}柱高依所示数值与对应刻度计算</text></svg>`;
}
