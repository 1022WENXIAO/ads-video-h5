import type { HtmlDrawing } from './narrativeScenes';

type Node = HtmlDrawing['nodes'][number];
type Box = { left:number; top:number; right:number; bottom:number };
export type IndependentTextIssue = { code:string; severity?:string; selector?:string; containerSelector?:string; text?:string };
const box=(n:Pick<Node,'x'|'y'|'w'|'h'>):Box=>({left:Math.min(n.x,n.x+n.w),top:Math.min(n.y,n.y+n.h),right:Math.max(n.x,n.x+n.w),bottom:Math.max(n.y,n.y+n.h)});
const intersects=(a:Box,b:Box)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;

/** Absolute line/quadratic/cubic control hulls are conservative extents, not
 * measured paint. Relative, arc and implicit reflected-control paths require
 * an authored redraw rather than guessing an empty region around them. */
function obstacle(node:Node):Box|undefined{
  const bounds=box(node);
  if(node.kind!=='path')return bounds;
  const token=/[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  const data=node.pathData||'',parts=data.match(token)||[];
  if(data.replace(token,'').replace(/[\s,]/g,'')||!parts.length)return;
  let index=0,command='',x=0,y=0,startX=0,startY=0;
  const point=(a:number,b:number)=>{if(!Number.isFinite(a)||!Number.isFinite(b))return false;bounds.left=Math.min(bounds.left,a);bounds.right=Math.max(bounds.right,a);bounds.top=Math.min(bounds.top,b);bounds.bottom=Math.max(bounds.bottom,b);return true;};
  while(index<parts.length){
    if(/^[A-Za-z]$/.test(parts[index])){
      command=parts[index++];
      if(!['M','L','H','V','Q','C','Z'].includes(command))return;
      if(command==='Z'){x=startX;y=startY;command='';continue;}
    }
    const count=command==='H'||command==='V'?1:command==='Q'?4:command==='C'?6:command==='M'||command==='L'?2:0;
    if(!count||index+count>parts.length||parts.slice(index,index+count).some(p=>/^[A-Za-z]$/.test(p)))return;
    const values=parts.slice(index,index+count).map(Number);index+=count;
    if(command==='H'){x=values[0];if(!point(x,y))return;}
    else if(command==='V'){y=values[0];if(!point(x,y))return;}
    else{
      for(let i=0;i<count;i+=2)if(!point(values[i],values[i+1]))return;
      x=values[count-2];y=values[count-1];
      if(command==='M'){startX=x;startY=y;command='L';}
    }
  }
  return bounds;
}

/** A same-word diagram label is not a redundant page heading. Unsupported
 * path extents remain ambiguous, so the compiler keeps their labels. */
export function drawingTextHasGraphicRelation(drawing:HtmlDrawing,text:Node):boolean{
  const label=box(text);
  for(const node of drawing.nodes){
    if(node.kind==='line'&&(intersects(box(node),label)||[[node.x,node.y],[node.x+node.w,node.y+node.h]].some(([x,y])=>x>=label.left&&x<=label.right&&y>=label.top&&y<=label.bottom)))return true;
    if(node.kind==='path'){
      const extent=obstacle(node);if(!extent)return true;
      if(intersects({left:extent.left-3,top:extent.top-3,right:extent.right+3,bottom:extent.bottom+3},label))return true;
    }
  }
  return false;
}

const lineHeight=(text:string,width:number,font:number)=>{
  let lines=1,used=0;
  for(const char of text){const glyph=font*(/[\u0000-\u007f]/.test(char)?.55:1);if(glyph>width)return Infinity;if(used&&used+glyph>width){lines++;used=0;}used+=glyph;}
  return Math.ceil(lines*font*1.3);
};

/** A proposal only: move one independent, unhighlighted transparent label to
 * an otherwise empty region, retaining its complete text/font and all other
 * nodes. The existing remaining HTML/font/paint/contrast check decides it.
 * Never move a connector, card, embedded label, numeric slot or bound SVG label. */
export function proposeIndependentTextLayout(drawing:HtmlDrawing,issues:IndependentTextIssue[],dimensions:[number,number],domId:(id:string)=>string):HtmlDrawing|undefined{
  if(!issues.length||issues.length>12||issues.some(i=>i.code!=='content_overlap'||i.severity&&i.severity!=='error'))return;
  if(!drawing||!Array.isArray(drawing.nodes)||drawing.nodes.length<3||drawing.nodes.length>30||new Set(drawing.nodes.map(n=>n.id)).size!==drawing.nodes.length||drawing.nodes.some(n=>typeof n.text!=='string'||![n.x,n.y,n.w,n.h,n.fontSize].every(Number.isFinite)))return;
  let pair:Node[]|undefined;
  for(const issue of issues){
    const nodes=[issue.selector,issue.containerSelector].map(selector=>drawing.nodes.filter(n=>selector==='#'+domId(n.id)));
    if(nodes.some(matches=>matches.length!==1)||nodes[0][0].id===nodes[1][0].id||issue.text!==nodes[0][0].text)return;
    const current=nodes.map(n=>n[0]);
    if(pair&&current.some(n=>!pair!.some(p=>p.id===n.id)))return;
    pair=current;
  }
  if(!pair||!intersects(box(pair[0]),box(pair[1])))return;
  const companions=new Set((drawing.serverCardLabels||[]).flatMap(b=>[b.cardId,b.labelId]));
  const targets=pair.filter(n=>n.kind==='text'&&!n.highlight&&n.text.trim()&&!/[\r\n]/.test(n.text)&&!companions.has(n.id));
  // Exactly one independent label avoids guessing which semantic item moves.
  if(targets.length!==1)return;
  const target=targets[0],original=box(target);
  if(drawing.nodes.some(n=>n.id!==target.id&&n.kind==='card'&&n.x+12<=target.x&&target.x+target.w<=n.x+n.w-12&&n.y+12<=target.y&&target.y+target.h<=n.y+n.h-12))return;
  if(drawingTextHasGraphicRelation(drawing,target))return;
  // Numeric/formula labels have their own indivisible slot and source rules.
  if(/[\d=+×÷%％°℃℉μΩ]/u.test(target.text)||/^[零〇一二两三四五六七八九十百千万亿点]+$/u.test(target.text))return;
  const [width,height]=dimensions;if(![width,height].every(n=>Number.isFinite(n)&&n>=1&&n<=4096))return;
  const safe={left:40,top:height>width?220:160,right:width-40,bottom:height>width?1010:height-170};
  let zones:Box[]=[safe];
  const obstacles:Box[]=[];
  const paths=drawing.nodes.filter(n=>n.kind==='path').map(obstacle);if(paths.some(p=>!p))return;
  // Moving this label cannot repair an already ambiguous paint relation on
  // another label. Keep the remaining authored redraw for the complete page.
  if(drawing.nodes.some(n=>n.id!==target.id&&n.text.trim()&&paths.some(p=>intersects(box(n),p!))))return;
  for(const node of drawing.nodes){
    if(node.id===target.id)continue;
    const extent=obstacle(node);if(!extent)return;
    const b={left:extent.left-6,top:extent.top-6,right:extent.right+6,bottom:extent.bottom+6};obstacles.push(b);
    zones=zones.flatMap(z=>!intersects(z,b)?[z]:[
      {...z,right:Math.min(z.right,b.left)}, {...z,left:Math.max(z.left,b.right)},
      {...z,bottom:Math.min(z.bottom,b.top)}, {...z,top:Math.max(z.top,b.bottom)},
    ]).filter(z=>z.right>z.left&&z.bottom>z.top);
    zones=[...new Map(zones.map(z=>[JSON.stringify(z),z])).values()].sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top)).slice(0,128);
  }
  const candidates=zones.flatMap(z=>{
    const w=Math.min(target.w,z.right-z.left),h=Math.max(target.h,lineHeight(target.text,w,target.fontSize));
    if(w<Math.max(target.w/2,target.fontSize*8)||!Number.isFinite(h)||h>Math.max(target.h,target.fontSize*1.3*3)||h>z.bottom-z.top)return[];
    const x=Math.max(z.left,Math.min(target.x,z.right-w)),y=Math.max(z.top,Math.min(target.y,z.bottom-h));
    return[{...target,x,y,w,h}];
  }).sort((a,b)=>Math.abs(a.x-target.x)+Math.abs(a.y-target.y)-Math.abs(b.x-target.x)-Math.abs(b.y-target.y)||b.w-a.w||a.y-b.y||a.x-b.x);
  for(const candidate of candidates){
    if(obstacles.some(b=>intersects(box(candidate),b)))continue;
    const next=structuredClone(drawing);Object.assign(next.nodes.find(n=>n.id===target.id)!,{x:candidate.x,y:candidate.y,w:candidate.w,h:candidate.h});
    return next;
  }
}
