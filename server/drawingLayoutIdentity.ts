import type {HtmlDrawing} from './narrativeScenes';
const box=(n:HtmlDrawing['nodes'][number])=>({left:Math.min(n.x,n.x+n.w),right:Math.max(n.x,n.x+n.w),top:Math.min(n.y,n.y+n.h),bottom:Math.max(n.y,n.y+n.h)});
const contains=(a:HtmlDrawing['nodes'][number],b:HtmlDrawing['nodes'][number])=>{const x=box(a),y=box(b);return x.left<=y.left&&x.right>=y.right&&x.top<=y.top&&x.bottom>=y.bottom;};
const originalContainer=(a:HtmlDrawing['nodes'][number],b:HtmlDrawing['nodes'][number])=>{if(contains(a,b))return true;if(b.kind!=='text')return false;const x=box(a),y=box(b),area=(y.right-y.left)*(y.bottom-y.top);return area>0&&Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))*Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top))>=area*.5;};

/** A browser-layout retry adjusts existing geometry, never creates another
 * competing copy or rewrites the diagram. It is still only a proposal: the
 * complete browser check and fresh movie review remain mandatory. */
export function assertDrawingLayoutIdentity(next:HtmlDrawing,prior:HtmlDrawing):void{
  const fail=()=>{throw Error('局部布局修复必须保留原标题、节点顺序/ID、完整文字、颜色、强调、路径及图形；只调整现有文字/卡片的位置、大小或有界字号，不得新增、删除、复制或改写节点。');};
  if(!next||next.title!==prior.title||(next.motion||'corporate')!==(prior.motion||'corporate')||!Array.isArray(next.nodes)||next.nodes.length!==prior.nodes.length||next.serverCardLabels!==undefined)fail();
  for(const [i,old] of prior.nodes.entries()){
    const node=next.nodes[i];
    if(!node||['id','kind','text','tone','highlight','pathData'].some(key=>(node as any)[key]!== (old as any)[key]))fail();
    if(old.kind!=='card'&&old.kind!=='text'){
      if(['x','y','w','h','fontSize'].some(key=>(node as any)[key]!== (old as any)[key]))fail();
    }else if(![node.x,node.y,node.w,node.h,node.fontSize].every(Number.isFinite)||node.fontSize<24||node.fontSize>old.fontSize)fail();
    // Keep labels and fixed graphics in their original semantic container.
    const parents=prior.nodes.filter(n=>n.id!==old.id&&n.kind==='card'&&originalContainer(n,old));
    if(parents.some(parent=>!contains(next.nodes.find(n=>n.id===parent.id)!,node)))fail();
    if(old.kind==='text'&&!parents.length&&next.nodes.some(n=>n.kind==='card'&&n.id!==old.id&&contains(n,node)))fail();
  }
}
