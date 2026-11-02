import {clamp,mix} from './compression-model.mjs';
export const expectedPanels=6;
const sigmoid=x=>1/(1+Math.exp(-x));
const erf=x=>{const s=Math.sign(x),a=Math.abs(x),z=1/(1+.3275911*a);return s*(1-(((((1.061405429*z-1.453152027)*z)+1.421413741)*z-.284496736)*z+.254829592)*z*Math.exp(-a*a))};
export const functions=[sigmoid,Math.tanh,x=>Math.max(0,x),x=>x>=0?x:.1*x,x=>.5*x*(1+erf(x/Math.SQRT2)),x=>x*sigmoid(x)];
let seed=739;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const inputs=Array.from({length:144},(_,k)=>-3+8*(k+rand())/144);
for(let k=inputs.length-1;k>0;k--){const j=Math.floor(rand()*(k+1));[inputs[k],inputs[j]]=[inputs[j],inputs[k]]}
export const samples=inputs.map((x,k)=>({x,start:.25+Math.floor(k/12)*.24+rand()*.1}));
export function stateAt(t,j){const local=t%8,bins=Array(24).fill(0);for(const p of samples)if(local>=p.start+.75){const value=functions[j](p.x);bins[clamp(Math.floor((value+1)*4),0,23)]++}return {local,bins,stage:local<.3?'1 · 同一批均匀随机输入':local<4.2?'2 · 输入 → 函数 → 输出':'3 · 比较输出分布'};}
export function paintPanel({text,line,dot,flash,box,C},x,y,s,j,t,{h}){
 const col=s.color,left=x+50,right=x+266,top=y+121,bottom=y+h-55;
 const px=v=>left+(v+3)/8*(right-left),py=v=>bottom-(v+1)/6*(bottom-top),hx=x+331;
 text('函数曲线',x+159,y+109,20,C.muted);text('输出分布',x+370,y+109,20,col);
 line([[left,top],[left,bottom],[right,bottom]],C.muted,1.5,.7);
 line([[left,py(0)],[right,py(0)]],C.muted,1,.5);line([[px(0),top],[px(0),bottom]],C.muted,1,.3);
 for(const v of [-1,0,5])text(v,left-15,py(v)+6,20,C.muted);
 text('-3',left,bottom+25,20,C.muted);text('5',right,bottom+25,20,C.muted);text('x',px(0),bottom+25,20,C.muted);
 line(Array.from({length:121},(_,k)=>{const v=-3+8*k/120;return[px(v),py(functions[j](v))]}),col,2.6);
 line([[hx,top],[hx,bottom],[x+418,bottom]],C.muted,1.2,.6);
 const bh=(bottom-top)/24;
 s.bins.forEach((count,k)=>{if(count)box(hx+2,py(-1+(k+1)*.25),82*count/144,Math.max(2,bh-1),col,col,1,0)});
 text('0–144',x+372,bottom+25,20,C.muted);
 for(const p of samples){const u=(s.local-p.start)/.75;if(u<0||u>1.45)continue;const yy=py(functions[j](p.x));
  if(u<.48){const v=clamp(u/.48);dot(px(p.x),mix(py(0),yy,v),3.6,col,.75)}
  else if(u<1)dot(mix(px(p.x),hx,(u-.48)/.52),yy,3.4,col,.8);
  else flash(hx+2,yy,(u-1)/.45,col);
 }
}
