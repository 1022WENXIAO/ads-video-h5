import type {HtmlDrawing} from './narrativeScenes';

export class DrawingLayoutIdentityError extends Error {
  readonly code='DRAWING_LAYOUT_IDENTITY';readonly retryable=false;
  constructor(message:string,readonly rawProposal?:string){super(message);this.name='DrawingLayoutIdentityError';}
}
type Segment={command:string;values:number[]};
function segments(source:string):Segment[]{
  const tokens=source.match(/[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)||[];
  if(tokens.join('')!==source.replace(/[\s,]/g,''))throw Error('局部布局修复遇到无效SVG路径。');
  const arity:Record<string,number>={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7};
  const result:Segment[]=[];let index=0,command='';
  while(index<tokens.length){
    if(/^[a-z]$/i.test(tokens[index]))command=tokens[index++];
    else if(!command)throw Error('局部布局修复遇到缺少命令的SVG路径。');
    const upper=command.toUpperCase();
    if(upper==='Z'){result.push({command,values:[]});command='';continue;}
    const count=arity[upper];if(!count)throw Error('局部布局修复遇到未知SVG命令。');
    const values=tokens.slice(index,index+count).map(Number);
    if(values.length!==count||!values.every(Number.isFinite))throw Error('局部布局修复遇到不完整SVG坐标。');
    if(upper==='A'&&(values[0]<0||values[1]<0||![0,1].includes(values[3])||![0,1].includes(values[4])))throw Error('局部布局修复遇到无效SVG圆弧。');
    result.push({command,values});index+=count;
    if(upper==='M')command=command==='M'?'L':'l';
  }
  if(result[0]?.command.toUpperCase()!=='M')throw Error('局部布局修复路径必须以moveto开始。');
  return result;
}
/** Translate existing shape coordinates; never ask a model to rewrite paths. */
export function translateDrawingPath(source:string,dx:number,dy:number):string{
  if(![dx,dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=10000))throw Error('局部布局修复位移必须为有限坐标。');
  return segments(source).map(({command,values},index)=>{
    const upper=command.toUpperCase(),v=[...values];
    if(command===upper){
      if(upper==='H')v[0]+=dx;
      else if(upper==='V')v[0]+=dy;
      else if(upper==='A'){v[5]+=dx;v[6]+=dy;}
      else for(let i=0;i<v.length;i++)v[i]+=i%2?dy:dx;
    }else if(index===0){v[0]+=dx;v[1]+=dy;}
    return command+v.map(n=>String(Number(n.toFixed(6)))).join(' ');
  }).join(' ');
}
function sameTranslatedPath(next:string|undefined,prior:string|undefined):boolean{
  if(next===prior)return true;if(!next||!prior)return false;
  try{
    const a=segments(prior),b=segments(next);
    if(a.length!==b.length)return false;
    const expected=segments(translateDrawingPath(prior,b[0].values[0]-a[0].values[0],b[0].values[1]-a[0].values[1]));
    return expected.every((s,i)=>s.command===b[i].command&&s.values.length===b[i].values.length&&s.values.every((n,j)=>Math.abs(n-b[i].values[j])<=.0000011));
  }catch{return false;}
}
/** Geometry patch responses cannot express new audience content. */
export function applyDrawingLayoutPatch(value:unknown,prior:HtmlDrawing):HtmlDrawing{
  const fail=(detail:string):never=>{throw Error('局部布局修复仅接受现有节点的几何补丁：'+detail);};
  const patch=value as any;
  if(!patch||Object.keys(patch).join(',')!=='nodes'||!Array.isArray(patch.nodes)||!patch.nodes.length||patch.nodes.length>prior.nodes.length)fail('返回{nodes:[{id,x?,y?,w?,h?,fontSize?,translate?:{x,y}}]}，不返回标题、文字、图形或样式。');
  const result=structuredClone(prior),seen=new Set<string>();
  for(const edit of patch.nodes){
    if(!edit||typeof edit.id!=='string'||seen.has(edit.id))fail('节点ID缺失或重复。');seen.add(edit.id);
    const node=result.nodes.find(n=>n.id===edit.id);if(!node)fail('未知节点'+edit.id+'。');
    if(Object.keys(edit).some(k=>!['id','x','y','w','h','fontSize','translate'].includes(k))||Object.keys(edit).length<2)fail(edit.id+'含内容字段或没有几何调整。');
    for(const key of ['x','y','w','h','fontSize'] as const)if(Object.hasOwn(edit,key)){
      if(typeof edit[key]!=='number'||!Number.isFinite(edit[key]))fail(edit.id+'.'+key+'必须为有限数值。');
      node![key]=edit[key];
    }
    if(Object.hasOwn(edit,'translate')){
      const t=edit.translate;
      if(node!.kind!=='path'||!t||Object.keys(t).sort().join(',')!=='x,y'||typeof t.x!=='number'||typeof t.y!=='number')fail(edit.id+'的translate仅用于原SVG路径整体平移。');
      node!.pathData=translateDrawingPath(node!.pathData!,t.x,t.y);
    }
  }
  assertDrawingLayoutIdentity(result,prior);
  const unchanged=result.nodes.every((n,i)=>{
    const old=prior.nodes[i];
    return ['x','y','w','h','fontSize'].every(key=>(n as any)[key]===(old as any)[key])&&(n.pathData===old.pathData||n.kind==='path'&&translateDrawingPath(n.pathData!,0,0)===translateDrawingPath(old.pathData!,0,0));
  });
  if(unchanged)fail('补丁没有改变实际布局；必须修复报告中重叠/遮挡的现有节点，零位移或重复原坐标不能消耗下一次HTML检查。');
  return result;
}
const box=(n:HtmlDrawing['nodes'][number])=>({left:Math.min(n.x,n.x+n.w),right:Math.max(n.x,n.x+n.w),top:Math.min(n.y,n.y+n.h),bottom:Math.max(n.y,n.y+n.h)});
const contains=(a:HtmlDrawing['nodes'][number],b:HtmlDrawing['nodes'][number])=>{const x=box(a),y=box(b);return x.left<=y.left&&x.right>=y.right&&x.top<=y.top&&x.bottom>=y.bottom;};
const coverage=(a:HtmlDrawing['nodes'][number],b:HtmlDrawing['nodes'][number])=>{const x=box(a),y=box(b),area=(y.right-y.left)*(y.bottom-y.top);return area>0?Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))*Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top))/area:0;};
const originalContainer=(a:HtmlDrawing['nodes'][number],b:HtmlDrawing['nodes'][number])=>{if(contains(a,b))return true;if(b.kind!=='text')return false;const x=box(a),y=box(b),area=(y.right-y.left)*(y.bottom-y.top);return area>0&&Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))*Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top))>=area*.5;};

/** A browser-layout retry adjusts existing geometry, never creates another
 * competing copy or rewrites the diagram. It is still only a proposal: the
 * complete browser check and fresh movie review remain mandatory. */
export function assertDrawingLayoutIdentity(next:HtmlDrawing,prior:HtmlDrawing):void{
  const fail=(detail='')=>{throw new DrawingLayoutIdentityError('局部布局修复必须保留原标题、节点顺序/ID、完整文字、颜色、强调与原图形；只调整几何布局及有界字号，路径仅可整体平移，不得新增、删除、复制或改写节点。'+detail);};
  if(!next||next.title!==prior.title||(next.motion||'corporate')!==(prior.motion||'corporate')||!Array.isArray(next.nodes)||next.nodes.length!==prior.nodes.length||next.serverCardLabels!==undefined)fail();
  for(const [i,old] of prior.nodes.entries()){
    const node=next.nodes[i];
    if(!node||['id','kind','text','tone','highlight'].some(key=>(node as any)[key]!== (old as any)[key]))fail(old.id+'内容改变。');
    if(old.kind==='path'){
      if(!sameTranslatedPath(node.pathData,old.pathData)||node.fontSize!==old.fontSize||![node.x,node.y,node.w,node.h].every(Number.isFinite))fail(old.id+'路径形状改变。');
    }else if(node.pathData!==old.pathData)fail(old.id+'增加路径。');
    if(old.kind!=='card'&&old.kind!=='text'){
      if(old.kind!=='path'&&(['w','h','fontSize'].some(key=>(node as any)[key]!== (old as any)[key])||![node.x,node.y].every(Number.isFinite)))fail(old.id+'图形尺寸改变。');
    }else if(![node.x,node.y,node.w,node.h,node.fontSize].every(Number.isFinite)||node.fontSize<24||node.fontSize>old.fontSize)fail(old.id+'坐标必须有限，字号必须在24到原字号'+old.fontSize+'之间；收到字号'+node.fontSize+'。空间不足时扩宽文字框并移动现有几何，不要缩成不可读字号。');
    // Keep labels and fixed graphics in their original semantic container.
    const parents=prior.nodes.filter(n=>n.id!==old.id&&n.kind==='card'&&originalContainer(n,old));
    // Preserve the observed relation, not a stronger invented relation. A
    // harmless existing partial text box must not block an unrelated repair.
    const outside=parents.filter(parent=>{const after=next.nodes.find(n=>n.id===parent.id)!;return contains(parent,old)?!contains(after,node):coverage(after,node)+1e-9<coverage(parent,old);});
    if(outside.length)fail(old.id+'必须保留与原卡片'+outside.map(n=>n.id).join(',')+'的包含关系；原先完全包含的仍须完全包含，部分包含的比例不得减少。');
    if(old.kind==='text'&&!parents.length&&next.nodes.some(n=>n.kind==='card'&&n.id!==old.id&&contains(n,node)))fail(old.id+'是独立标签，不能移入无关卡片。');
  }
}
