import type {EditPlan} from '../shared/types';

/** Coordinates recorded by the matching renderer, never proof that the encoded
 * pixels are unobstructed. Keep this reference beside its own output frame. */
export function reviewFrameTextLayoutContext(plan:EditPlan,time:number,manifest:unknown,expectedPlanHash:string,expectedDimensions:readonly number[]) {
  const basis='matching-render-manifest-reference-not-pixel-proof';
  const unverified=(reason:string)=>({basis,frameTime:time,status:'unverified' as const,reason});
  const m=manifest as any,l=m?.textLayout;
  if(!Number.isFinite(time)||time<0||!expectedPlanHash||m?.planHash!==expectedPlanHash)return unverified('frame or plan binding unavailable');
  if(!l||l.version!==1||!['observed-blank','contain-rails'].includes(l.method)||!Number.isFinite(m.width)||!Number.isFinite(m.height)||m.width<=0||m.height<=0||m.width!==expectedDimensions[0]||m.height!==expectedDimensions[1]||l.width!==m.width||l.height!==m.height)return unverified('matching renderer layout unavailable');
  const active:Array<{kind:string;index:number;text:string;box:{x:number;y:number;width:number;height:number}}> = [];
  for(const kind of ['captions','overlays','motions'] as const) {
    const events=plan[kind]||[],boxes=l[kind];
    if(!Array.isArray(boxes)||boxes.length!==events.length)return unverified('renderer event count mismatch');
    for(let index=0;index<events.length;index++) {
      const event=events[index],box=boxes[index],text=kind==='motions'?(event as any).label:(event as any).text;
      if(!Number.isFinite(event.start)||!Number.isFinite(event.end)||event.end<=event.start||typeof text!=='string'||!box||!['x','y','width','height'].every(k=>Number.isFinite(box[k]))||box.x<0||box.y<0||box.width<=0||box.height<=0||box.x+box.width>m.width||box.y+box.height>m.height||!Array.isArray(box.lines)||box.lines.some((line:unknown)=>typeof line!=='string')||box.lines.join('')!==text.replace(/\n/g,''))return unverified('renderer event or box mismatch');
      if(event.start<=time&&time<event.end)active.push({kind,index,text,box:{x:box.x,y:box.y,width:box.width,height:box.height}});
    }
  }
  // Bound contextual output; an unusually crowded frame remains unknown.
  if(active.length>12)return unverified('too many concurrent text references');
  return {basis,frameTime:time,status:'reference-only' as const,coordinates:{width:m.width,height:m.height,origin:'encoded-frame-top-left',unit:'pixel'},active,
    instruction:'这些框仅帮助定位新增文字；原素材文字位置、实际字形与遮挡仍须读本张像素。相邻或同处顶部不等于相交，真实重叠、裁剪和不可读仍须报告。'};
}
