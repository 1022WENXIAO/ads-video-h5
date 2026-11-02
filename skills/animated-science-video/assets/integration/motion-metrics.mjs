export function createMotionMeter(panelRects=[],options={}){
 const width=options.width||230,height=options.height||262,stride=options.stride||4,fps=options.fps||30;
 const regions=[{x:0,y:0,w:width,h:height},...panelRects.map(r=>({x:Math.max(0,Math.ceil((r.x+20-80)*width/920)),y:Math.max(0,Math.ceil((r.y+108-500)*height/1045)),w:Math.floor((r.w-40)*width/920),h:Math.floor((r.h-145)*height/1045)}))];
 const areas=regions.map(()=>[]);let previous=null,frames=0;
 function push(bytes){
  if(bytes.length!==width*height*stride)throw Error('运动采样尺寸不符');
  if(previous){
   for(let j=0;j<regions.length;j++){const r=regions[j];let changed=0,total=0;
    for(let y=r.y;y<Math.min(height,r.y+r.h);y++)for(let x=r.x;x<Math.min(width,r.x+r.w);x++){const p=(y*width+x)*stride;if(Math.max(Math.abs(bytes[p]-previous[p]),Math.abs(bytes[p+1]-previous[p+1]),Math.abs(bytes[p+2]-previous[p+2]))>12)changed++;total++;}
    areas[j].push(100*changed/Math.max(1,total));
   }
  }
  previous=new Uint8Array(bytes);frames++;
 }
 function summarize(values){
  const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;let still=0,longest=0;
  for(const v of values){still=v<.015?still+1:0;longest=Math.max(longest,still);}
  return {framePairs:n,meanChangedAreaPct:n?values.reduce((a,b)=>a+b,0)/n:0,medianChangedAreaPct:n?sorted[Math.floor(n*.5)]:0,p90ChangedAreaPct:n?sorted[Math.min(n-1,Math.floor(n*.9))]:0,activeFramePct:n?100*values.filter(v=>v>=.03).length/n:0,longestStillSeconds:longest/fps};
 }
 function result(){return {frames,width,height,pixelThreshold:12,...summarize(areas[0]),panels:areas.slice(1).map((v,i)=>({panel:i+1,...summarize(v)}))};}
 return {push,result};
}
