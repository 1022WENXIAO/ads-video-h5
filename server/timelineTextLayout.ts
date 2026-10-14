import { spawnForJob as spawn, throwIfJobCancelled } from './jobExecution';
import ffmpegPath from 'ffmpeg-static';
import type { EditPlan, TimelineText } from '../src/types';

export interface TextBox { x:number; y:number; width:number; height:number; fontSize:number; lines:string[]; }
export interface SourceOccupancy { width:number; height:number; occupied:Uint8Array; frames:number; certain:boolean; reason?:string; }
export interface TimelineTextLayout {
  version:1; method:'observed-blank'|'contain-rails'; width:number; height:number;
  captions:TextBox[]; overlays:TextBox[]; motions:TextBox[];
  sourceFit?:{x:number;y:number;width:number;height:number};
  analysis:{frames:number;width:number;height:number;certain:boolean;reason?:string};
}
export const ordinarySubtitleSize=(width:number)=>Math.max(24,Math.round(width/30));
const units=(text:string)=>[...text].length;
export function wrapLayoutText(text:string,fontSize:number,maxWidth:number):string[] {
  const lines:string[]=[];let line='';
  for(const char of text){if(char==='\n'){lines.push(line);line='';continue;}if(line&&units(line+char)*fontSize>maxWidth){lines.push(line);line='';}line+=char;}
  lines.push(line);return lines;
}
function box(text:string,fontSize:number,width:number,motion=false):TextBox {
  const lines=wrapLayoutText(text,fontSize,width-24);
  return {x:0,y:0,width:Math.ceil(Math.max(...lines.map(units),1)*fontSize)+24,height:Math.ceil(lines.length*fontSize*1.25)+(motion?14:12),fontSize,lines};
}
export function boxesOverlap(a:TextBox,b:TextBox,gap=8):boolean {return a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y;}

/** All decoded frames contribute to the occupied mask. This deliberately only
 * recognizes a uniform corner background, not arbitrary photographic scenery. */
export function addOccupancyFrame(state:SourceOccupancy,rgb:Uint8Array):void {
  if(rgb.length!==state.width*state.height*3)throw new Error('留白检测帧大小无效。');
  state.frames++;
  const {width:w,height:h}=state,points=[[1,1],[w-2,1],[1,h-2],[w-2,h-2]];
  const colors=points.map(([x,y])=>[...rgb.slice((y*w+x)*3,(y*w+x)*3+3)]);
  const bg=[0,1,2].map(c=>colors.map(color=>color[c]).sort((a,b)=>a-b)[1]);
  if(colors.some(color=>color.some((value,c)=>Math.abs(value-bg[c])>12))){state.certain=false;state.reason='源画面背景不确定，使用完整画面文字分区';return;}
  for(let pixel=0;pixel<w*h;pixel++)if([0,1,2].some(c=>Math.abs(rgb[pixel*3+c]-bg[c])>4))state.occupied[pixel]=1;
}
export async function decodeSourceOccupancy(file:string,seconds:number):Promise<SourceOccupancy> {
  throwIfJobCancelled();
  const width=256,height=144,state:SourceOccupancy={width,height,occupied:new Uint8Array(width*height),frames:0,certain:true};
  if(!(seconds>0)||seconds>90)return {...state,certain:false,reason:'长视频使用完整画面文字分区，避免无界逐帧分析'};
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(ffmpegPath||'ffmpeg',['-v','error','-threads','1','-i',file,'-an','-vf',`scale=${width}:${height}:flags=area`,'-t',String(seconds),'-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{stdio:['ignore','pipe','pipe']});
    const frameBytes=width*height*3;let pending=Buffer.alloc(0),log='',settled=false,frames=0;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('源画面留白检测超时，未生成遮挡未知的覆盖层。'));},120000);
    child.stdout.on('data',(chunk:Buffer)=>{try{throwIfJobCancelled();pending=Buffer.concat([pending,chunk]);while(pending.length>=frameBytes){const frame=pending.subarray(0,frameBytes);pending=pending.subarray(frameBytes);addOccupancyFrame(state,frame);if(++frames>90*120+1)throw new Error('源画面留白检测超过有界帧数。');}}catch(error){child.kill('SIGKILL');finish(error as Error);}});
    child.stderr.on('data',(chunk:Buffer)=>{log=(log+chunk.toString()).slice(-1500);});
    child.on('error',error=>finish(error));child.on('close',code=>{try{throwIfJobCancelled();if(code!==0||pending.length||!state.frames)throw new Error(`源画面留白检测失败：${log.slice(-500)}`);finish();}catch(error){finish(error as Error);}});
  });
  return state;
}
function integral(state:SourceOccupancy):Uint32Array {
  const sum=new Uint32Array((state.width+1)*(state.height+1));
  for(let y=0;y<state.height;y++)for(let x=0;x<state.width;x++){const i=(y+1)*(state.width+1)+x+1;sum[i]=state.occupied[y*state.width+x]+sum[i-1]+sum[i-state.width-1]-sum[i-state.width-2];}
  return sum;
}
export function isObservedBlank(rect:TextBox,state:SourceOccupancy,width:number,height:number,sum=integral(state)):boolean {
  if(!state.certain||!state.frames||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.x<0||rect.y<0||rect.width<=0||rect.height<=0||rect.x+rect.width>width||rect.y+rect.height>height)return false;
  const gap=12,left=Math.max(0,Math.floor((rect.x-gap)*state.width/width)),right=Math.min(state.width,Math.ceil((rect.x+rect.width+gap)*state.width/width)),top=Math.max(0,Math.floor((rect.y-gap)*state.height/height)),bottom=Math.min(state.height,Math.ceil((rect.y+rect.height+gap)*state.height/height)),stride=state.width+1;
  return sum[bottom*stride+right]-sum[top*stride+right]-sum[bottom*stride+left]+sum[top*stride+left]===0;
}
type TimedBox={box:TextBox;start:number;end:number;type:'captions'|'overlays'|'motions';index:number};
function rows(items:TimedBox[]):TimedBox[][] {
  const result:TimedBox[][]=[];
  for(const item of [...items].sort((a,b)=>a.start-b.start)){let row=result.find(row=>row.at(-1)!.end<=item.start+.00001);if(!row){row=[];result.push(row);}row.push(item);}
  return result;
}
export function createTimelineTextLayout(plan:EditPlan,width:number,height:number,state?:SourceOccupancy):TimelineTextLayout {
  const subtitle=ordinarySubtitleSize(width),items:TimedBox[]=[];
  for(const type of ['captions','overlays'] as const)(plan[type]||[]).forEach((item:TimelineText,index:number)=>{const size=Math.round(subtitle*(item.style==='title'?1.45:item.style==='keyword'?1.15:1));const b=box(item.text,size,width*.88);if(item.animation==='rise')b.height+=16;items.push({box:b,start:item.start,end:item.end,type,index});});
  (plan.motions||[]).forEach((item,index)=>items.push({box:box(item.label,Math.max(24,Math.round(width/40)),width*.6,true),start:item.start,end:item.end,type:'motions',index}));
  const motionRows=rows(items.filter(item=>item.type==='motions')),textRows=rows(items.filter(item=>item.type!=='motions'));
  const groups=[...textRows,...motionRows].map(row=>({row,rect:{...row[0].box,width:Math.max(...row.map(item=>item.box.width)),height:Math.max(...row.map(item=>item.box.height))}}));
  const analysis=state?{frames:state.frames,width:state.width,height:state.height,certain:state.certain,reason:state.reason}:{frames:0,width:0,height:0,certain:false,reason:'未确认真实留白，使用完整画面文字分区'};
  const layout:TimelineTextLayout={version:1,method:'observed-blank',width,height,captions:[],overlays:[],motions:[],analysis};
  const placed:TextBox[]=[],sum=state&&integral(state);
  for(const group of groups){
    let found:TextBox|undefined;
    const motion=group.row[0].type==='motions',preferredY=motion?8:height-Math.round(height*.095)-group.rect.height;
    const ys=[preferredY,...Array.from({length:Math.ceil((height-group.rect.height-16)/8)},(_,i)=>8+i*8)].filter(y=>y>=8&&y+group.rect.height<=height-8).sort((a,b)=>Math.abs(a-preferredY)-Math.abs(b-preferredY));
    const xs=[(width-group.rect.width)/2,...Array.from({length:Math.ceil((width-group.rect.width-16)/8)},(_,i)=>8+i*8)].filter(x=>x>=8&&x+group.rect.width<=width-8).sort((a,b)=>Math.abs(a-(width-group.rect.width)/2)-Math.abs(b-(width-group.rect.width)/2));
    if(state?.certain&&state.frames)for(const y of ys){for(const x of xs){const candidate={...group.rect,x,y};if(!placed.some(other=>boxesOverlap(candidate,other))&&isObservedBlank(candidate,state,width,height,sum)){found=candidate;break;}}if(found)break;}
    if(!found){layout.method='contain-rails';break;}placed.push(found);
  }
  if(layout.method==='contain-rails'){
    const top=motionRows.reduce((sum,row)=>sum+Math.max(...row.map(item=>item.box.height))+12,8),bottom=textRows.reduce((sum,row)=>sum+Math.max(...row.map(item=>item.box.height))+12,8);
    if(top+bottom>height*.55)throw new Error('字幕与动效完整文字无法在可读字号和完整源画面分区内排下；请减少同时出现的文字，不会删字或裁剪源画面。');
    const ratio=Math.min(1,(height-top-bottom)/height),w=Math.floor(width*ratio/2)*2,h=Math.floor(height*ratio/2)*2;
    layout.sourceFit={x:Math.floor((width-w)/4)*2,y:Math.floor((top+(height-top-bottom-h)/2)/2)*2,width:w,height:h};
    let textY=height-bottom+6,motionY=8;
    for(const group of groups){const motion=group.row[0].type==='motions';group.rect={...group.rect,x:(width-group.rect.width)/2,y:motion?motionY:textY};if(motion)motionY+=group.rect.height+12;else textY+=group.rect.height+12;}
  }else groups.forEach((group,index)=>{group.rect=placed[index];});
  for(const group of groups)for(const item of group.row)layout[item.type][item.index]={...item.box,x:group.rect.x+(group.rect.width-item.box.width)/2,y:group.rect.y+(group.rect.height-item.box.height)/2};
  return layout;
}
export async function prepareTimelineTextLayout(plan:EditPlan,width:number,height:number,source:string):Promise<TimelineTextLayout|undefined> {
  if(plan.lesson||plan.reconstruction||!plan.captions?.length&&!plan.overlays?.length&&!plan.motions?.length)return;
  return createTimelineTextLayout(plan,width,height,await decodeSourceOccupancy(source,plan.targetSeconds));
}
