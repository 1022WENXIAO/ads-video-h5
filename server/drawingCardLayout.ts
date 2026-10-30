import type { HtmlDrawing } from './narrativeScenes';
import {drawingDomId} from './narrativeScenes';
import {drawingDateCopyId,drawingDateText} from './drawingDateText';
import type { Format } from '../src/types';

type Node = HtmlDrawing['nodes'][number];
type Issue = { code: string; selector?: string; containerSelector?: string };
const box = (n: Node) => ({ left: Math.min(n.x,n.x+n.w), right: Math.max(n.x,n.x+n.w), top: Math.min(n.y,n.y+n.h), bottom: Math.max(n.y,n.y+n.h) });
const overlap = (a: Node,b: Node) => { const x=box(a),y=box(b);return x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top; };
const lines = (text:string,width:number,font:number) => text.split(/\r?\n/).reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].reduce((n,c)=>n+(/[\u0000-\u007f]/.test(c)?.55:1),0)*font/width)),0);
const textHeight = (n:Node,width=n.w) => Math.ceil(lines(n.text,width,n.fontSize)*n.fontSize*1.3);
const associated = (card:Node,text:Node) => {
  if(card.kind!=='card'||!card.text.trim()||text.kind!=='text'||!text.text.trim()||text.x<card.x+12||text.x+text.w>card.x+card.w-12||text.y<card.y+card.h/2)return false;
  const inside=Math.max(0,Math.min(card.y+card.h,text.y+text.h)-text.y);
  return inside>=text.h*.8&&text.y+text.h<=card.y+card.h+Math.min(24,card.h*.1);
};
const issueNodes=(drawing:HtmlDrawing,issue:Issue):Node[]|undefined=>{
  // HyperFrames reports the real text wrapper when a date is kept intact.
  // Resolve only our exact generated ID on a node that actually owns dates;
  // arbitrary descendants and unknown/mixed selectors remain unsupported.
  const selectors=[issue.selector,issue.containerSelector].map(selector=>{
    const copies=drawing.nodes.filter(n=>selector==='#'+drawingDateCopyId(n.id)&&drawingDateText(n.text,s=>s).startsWith('<span class="qj-date-copy"'));
    return copies.length===1?'#'+drawingDomId(copies[0].id):selector;
  });
  if(selectors.some(s=>!s||!/^#[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)))return;
  // Resolve complete compiled IDs, including logical IDs already carrying the
  // prefix. Never strip a prefix and accidentally select a different node.
  const compiled=selectors.map(s=>drawing.nodes.filter(n=>'#'+drawingDomId(n.id)===s));
  if(compiled.some(matches=>matches.length))return compiled.every(matches=>matches.length===1)?compiled.map(matches=>matches[0]):undefined;
  // Captured pre-namespace reports remain useful for their original layouts.
  // Framework IDs and mixed/unknown selectors cannot identify author nodes.
  if(selectors.some(s=>/^#(?:main|title|note|ambient-a|ambient-b)$/.test(s!)))return;
  const legacy=selectors.map(s=>drawing.nodes.filter(n=>'#'+n.id===s));
  return legacy.every(matches=>matches.length===1)?legacy.map(matches=>matches[0]):undefined;
};

/** Give an existing card label an empty upper zone without moving any of its
 * diagram entities. If necessary the card expands upward into unused space. */
export function liftCardLabels(drawing:HtmlDrawing,issues:Issue[],format:Format):HtmlDrawing|undefined {
  if(!issues.length||issues.some(i=>!['content_overlap','text_occluded'].includes(i.code)))return;
  const next=structuredClone(drawing),cards=new Set<string>();
  const inset=(card:Node,n:Node)=>n.x>=card.x+12&&n.x+n.w<=card.x+card.w-12&&n.y>=card.y+12&&n.y+n.h<=card.y+card.h-12;
  for(const issue of issues){
    const pair=issueNodes(next,issue);if(!pair)return;
    const card=pair.find(n=>n?.kind==='card'&&n.text.trim()),child=pair.find(n=>n&&(n.kind==='text'||n.kind==='circle'));
    if(!card||!child||!inset(card,child))return;cards.add(card.id);
  }
  for(const id of cards){
    const card=next.nodes.find(n=>n.id===id)!,original={...card};
    const contents=next.nodes.filter(n=>n.id!==id&&inset(original,n));
    const label:Node={...card,id:card.id+'_label',kind:'text',x:card.x+15,y:card.y+15,w:card.w-30,h:0,highlight:false};
    if(label.id.length>64||next.nodes.some(n=>n.id===label.id))return;
    label.h=textHeight(label);
    label.y=Math.min(label.y,...contents.map(n=>n.y-15-label.h));
    const top=format==='9:16'?220:160,newTop=Math.min(card.y,label.y-15);
    if(newTop<top||label.y+label.h>card.y+card.h-15)return;
    card.h+=card.y-newTop;card.y=newTop;
    if(next.nodes.some(n=>n.id!==id&&overlap(label,n)))return;
    const addedSpace={...card,y:newTop,h:original.y-newTop};
    if(newTop<original.y&&next.nodes.some(n=>n.id!==id&&overlap(addedSpace,n)))return;
    card.text='';
    // Put the header before embedded entities in the entry animation order.
    next.nodes.splice(next.nodes.findIndex(n=>n.id===id)+1,0,label);
  }
  return next.nodes.length<=30?next:undefined;
}

/** Reflow only an unambiguous card/detail pair identified by the real checker.
 * Text, font sizes, horizontal geometry and paths are immutable. Empty vertical
 * space may be reassigned, and a card may grow into otherwise unused space.
 * A real second browser check still decides whether the proposal is usable. */
export function reflowCardDetails(drawing:HtmlDrawing,issues:Issue[],format:Format):HtmlDrawing|undefined {
  if(!issues.length||issues.some(issue=>!['content_overlap','text_occluded'].includes(issue.code)))return;
  const pairs=new Map<string,string>();
  for(const text of drawing.nodes.filter(n=>n.kind==='text'&&n.text.trim())){
    const parents=drawing.nodes.filter(card=>associated(card,text));
    if(parents.length>1)return;
    if(parents.length===1){if(pairs.has(parents[0].id))return;pairs.set(parents[0].id,text.id);}
  }
  for(const issue of issues){
    const ids=issueNodes(drawing,issue)?.map(n=>n.id);if(!ids)return;
    if(ids.some(id=>!id)||!ids.some(id=>id&&pairs.has(id)&&pairs.get(id)===ids.find(other=>other!==id)))return;
  }
  const next=structuredClone(drawing),labels=new Map<string,Node>();
  for(const[cardId,textId]of pairs){
    const card=next.nodes.find(n=>n.id===cardId)!,detail=next.nodes.find(n=>n.id===textId)!;
    // A path inside the card may carry data or a mechanism. Reflowing text
    // around that drawing needs a new authored layout, not this narrow repair.
    if(next.nodes.some(n=>(n.kind==='path'||n.kind==='line')&&overlap(card,n)))return;
    const label:Node={...card,id:card.id+'_label',kind:'text',x:card.x+15,y:card.y+15,w:card.w-30,h:0,highlight:false};
    if(label.id.length>64||next.nodes.some(n=>n.id===label.id))return;
    label.h=textHeight(label);
    detail.y=label.y+label.h+8;detail.h=textHeight(detail);
    card.h=Math.max(card.h,detail.y+detail.h+15-card.y);card.text='';
    const height=format==='9:16'?1280:720,width=format==='16:9'?1280:720;
    if(card.x+card.w>width-40||card.y+card.h>(height>width?1010:height-170))return;
    labels.set(detail.id,label);
  }
  for(const[cardId,textId]of pairs){
    const card=next.nodes.find(n=>n.id===cardId)!,detail=next.nodes.find(n=>n.id===textId)!,label=labels.get(textId)!;
    if(next.nodes.some(n=>n.id!==cardId&&n.id!==textId&&overlap(card,n)))return;
    if([...labels.values()].some(n=>n.id!==label.id&&overlap(card,n)))return;
    if(overlap(label,detail))return;
  }
  // Enter the label before its detail. Their shared downward entry motion
  // then increases separation instead of sweeping a later label over text.
  next.nodes=next.nodes.flatMap(n=>labels.has(n.id)?[labels.get(n.id)!,n]:[n]);
  if(next.nodes.length>30)return;
  return next;
}

/** Propose edge-adjacent rows for two independent opaque caption cards. Only
 * the upper card moves; words, fonts, paths, sizes and animation order stay
 * unchanged. The remaining complete browser check decides actual readability. */
export function stackIndependentCards(drawing:HtmlDrawing,issues:Issue[],format:Format):HtmlDrawing|undefined {
  if(!issues.length||issues.some(i=>!['content_overlap','text_occluded'].includes(i.code)))return;
  let pair:Node[]|undefined;
  const bound=new Set((drawing.serverCardLabels||[]).flatMap(v=>[v.cardId,v.labelId]));
  for(const issue of issues){
    const current=issueNodes(drawing,issue);
    if(!current||current.some(n=>n.kind!=='card'||!n.text.trim()||n.highlight||bound.has(n.id)))return;
    if(pair&&current.some(n=>!pair!.some(p=>p.id===n.id)))return;
    pair=current;
  }
  if(!pair||pair[0].id===pair[1].id||!overlap(pair[0],pair[1]))return;
  const [upper,lower]=[...pair].sort((a,b)=>a.y-b.y);
  if(upper.x!==lower.x||upper.w!==lower.w||upper.y===lower.y)return;
  const candidate={...upper,y:lower.y-upper.h};
  const width=format==='16:9'?1280:720,height=format==='9:16'?1280:720;
  if(candidate.y>upper.y||candidate.x<40||candidate.x+candidate.w>width-40||candidate.y<(height>width?220:160)||lower.y+lower.h>(height>width?1010:height-170))return;
  // Embedded or connected diagram entities require an authored redraw. These
  // are conservative proposal boxes; SVG/font/contrast checks remain required.
  if(drawing.nodes.some(n=>!pair!.some(p=>p.id===n.id)&&(overlap(upper,n)||overlap(lower,n)||overlap(candidate,n))))return;
  const next=structuredClone(drawing);next.nodes.find(n=>n.id===upper.id)!.y=candidate.y;
  return next;
}

export const CARD_LAYOUT_RENDERER_SIGNATURE=[box,overlap,lines,textHeight,associated,drawingDomId,issueNodes,liftCardLabels,reflowCardDetails,stackIndependentCards].map(fn=>fn.toString()).join('\n');
