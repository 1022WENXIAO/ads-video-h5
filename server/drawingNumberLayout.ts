import type {HtmlDrawing} from './narrativeScenes';

/** Only standalone numeric labels; ordinary prose keeps its normal wrapping. */
export const numericDrawingText = (text: string) => /^[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[%％‰])?$/.test(text.replace(/\s/g, ''));

/** A complete value with insufficient geometry, never a split/invalid value. */
export class NumericDrawingSlotError extends Error {
  constructor(readonly requiredWidth:number,readonly requiredHeight:number,message:string){super(message);this.name='NumericDrawingSlotError';}
}

export function assertNumericDrawingNode(node: { id: string; kind: string; text: string; w: number; h: number; fontSize: number }): void {
  if (!numericDrawingText(node.text)) return;
  const padding = node.kind === 'card' ? 30 : node.kind === 'circle' ? 14 : 0;
  const minimumWidth = Math.ceil(node.text.trim().length * node.fontSize * .55 + padding);
  if (/[\r\n]/.test(node.text) || node.w < minimumWidth || node.h < node.fontSize * 1.3 + padding - 3) {
    const message='数字节点' + node.id + '的完整数值“' + node.text.replace(/\s/g, '') + '”必须单行显示；至少保留' + minimumWidth + 'px宽与现有' + node.fontSize + 'px字号，扩大合法宽度或重排，不能拆开数字或缩小字号。';
    if(!/[\r\n]/.test(node.text)&&['text','card','circle'].includes(node.kind)&&node.text.length<=32&&[node.w,node.h,node.fontSize].every(Number.isFinite)&&node.w>=1&&node.h>=1&&node.fontSize>=24&&node.fontSize<=64)throw new NumericDrawingSlotError(minimumWidth,Math.ceil(node.fontSize*1.3+padding),message);
    throw new Error(message);
  }
}

/** A geometry proposal, never an acceptance result. Keep the authored number,
 * font, node order and animation centre; the normal validators and real
 * loaded-font/paint checks must still run on the proposed drawing. */
export function fitNumericDrawingSlots(drawing:HtmlDrawing,safe:{left:number;top:number;right:number;bottom:number}):HtmlDrawing|undefined {
  if(!Array.isArray(drawing.nodes)||drawing.nodes.length>30||drawing.serverCardLabels!==undefined||![safe.left,safe.top,safe.right,safe.bottom].every(Number.isFinite))return;
  if(drawing.nodes.some(n=>!n||typeof n.text!=='string'||![n.x,n.y,n.w,n.h,n.fontSize].every(Number.isFinite)))return;
  const box=(n:{x:number;y:number;w:number;h:number},pad=0)=>({left:Math.min(n.x,n.x+n.w)-pad,top:Math.min(n.y,n.y+n.h)-pad,right:Math.max(n.x,n.x+n.w)+pad,bottom:Math.max(n.y,n.y+n.h)+pad});
  const contains=(a:typeof safe,b:typeof safe)=>a.left<=b.left&&a.top<=b.top&&a.right>=b.right&&a.bottom>=b.bottom;
  const area=(a:typeof safe,b:typeof safe)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const next=structuredClone(drawing);let changed=false;
  for(const node of next.nodes){
    if(!['text','card','circle'].includes(node.kind)||!numericDrawingText(node.text))continue;
    // A split value is not a size problem. Never join, rewrite or shrink it.
    if(/[\r\n]/.test(node.text)||node.w<=0||node.h<=0||node.fontSize<24||node.fontSize>64)return;
    try{assertNumericDrawingNode(node);continue;}catch(error){if(!(error instanceof NumericDrawingSlotError))return;}
    const old=box(node),padding=node.kind==='card'?30:node.kind==='circle'?14:0;
    const w=Math.max(node.w,Math.ceil(node.text.trim().length*node.fontSize*.55+padding)),h=Math.max(node.h,Math.ceil(node.fontSize*1.3+padding));
    const candidate={...node,x:node.x-(w-node.w)/2,y:node.y-(h-node.h)/2,w,h},expanded=box(candidate);
    if(!contains(safe,old)||!contains(safe,expanded))return;
    for(const other of next.nodes){
      if(other===node)continue;
      const obstacle=box(other,other.kind==='line'||other.kind==='path'?3:0);
      // Contained badges may grow only inside the existing container's
      // content box. Any glyph collision still belongs to the real checker.
      const inset=other.kind==='card'?15:other.kind==='circle'?7:0;
      if(inset&&contains(obstacle,old)&&contains({left:obstacle.left+inset,top:obstacle.top+inset,right:obstacle.right-inset,bottom:obstacle.bottom-inset},expanded))continue;
      if(area(expanded,obstacle)>area(old,obstacle)+1e-6)return;
    }
    Object.assign(node,candidate);changed=true;
  }
  return changed?next:undefined;
}

export const NUMERIC_DRAWING_CSS = '.node[data-qj-number]{white-space:nowrap;overflow-wrap:normal;word-break:normal}.node.text[data-qj-number]{padding:0}';

// The estimate above is only an early rejection. This uses actual loaded-font
// glyphs and the real content box, so a narrow axis cannot pass by wrapping.
export const NUMERIC_DRAWING_CHECK_SCRIPT = `document.fonts.ready.then(()=>{for(const node of document.querySelectorAll('[data-qj-number]')){const range=document.createRange();range.selectNodeContents(node);const style=getComputedStyle(node),box=node.getBoundingClientRect(),scale=node.offsetWidth?box.width/node.offsetWidth:1;const width=range.getBoundingClientRect().width/(scale||1),available=node.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);if(width>available+1)throw new Error('数字字形溢出：'+node.id+' '+node.textContent+' 实际'+width.toFixed(2)+'px>可用'+available.toFixed(2)+'px；保留数字与字号，加宽或重排。');}});`;
