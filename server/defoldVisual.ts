import {PNG} from 'pngjs';
/** Observe the visible controlled object independently of generated Lua telemetry. */
export function observePlayer(png:Uint8Array){
 const {width,height,data}=PNG.sync.read(Buffer.from(png));const visited=new Uint8Array(width*height);
 const y0=Math.floor(height*.70),y1=Math.floor(height*.94),components:Array<{x:number;y:number;area:number}>=[];
 const bright=(i:number)=>{const r=data[i*4],g=data[i*4+1],b=data[i*4+2];return Math.max(r,g,b)>=110&&Math.max(r,g,b)-Math.min(r,g,b)>=45;};
 for(let y=y0;y<y1;y++)for(let x=0;x<width;x++){
  const start=y*width+x;if(visited[start]||!bright(start))continue;const queue=[start];visited[start]=1;let sx=0,sy=0;
  for(let n=0;n<queue.length;n++){const i=queue[n],cx=i%width,cy=Math.floor(i/width);sx+=cx;sy+=cy;for(const next of [cx>0?i-1:-1,cx<width-1?i+1:-1,cy>y0?i-width:-1,cy<y1-1?i+width:-1])if(next>=0&&!visited[next]&&bright(next)){visited[next]=1;queue.push(next);}}
  if(queue.length>=64)components.push({x:sx/queue.length/width,y:sy/queue.length/height,area:queue.length});
 }
 components.sort((a,b)=>b.area-a.area);if(!components.length)throw Error('无法独立识别控制区域的可见主体，请调整测试场景；不能仅凭状态上报通过。');return components[0];
}
export function assertVisualMovement(before:ReturnType<typeof observePlayer>,after:ReturnType<typeof observePlayer>,restarted:ReturnType<typeof observePlayer>){
 if(after.x-before.x<.025||Math.abs(restarted.x-before.x)>.035)throw Error('画面验收失败：可见玩家未随右键移动，或重启没有恢复可见位置；逻辑坐标不能代替真实画面。');
 return {passed:true,observer:'canvas-pixels' as const,before,after,restarted};
}
