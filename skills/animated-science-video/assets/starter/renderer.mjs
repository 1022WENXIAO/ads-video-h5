import * as compression from './scenes/compression.mjs';
import * as activations from './scenes/activations.mjs';
import {clamp,mix} from './scenes/compression-model.mjs';
export const W=1080,H=1920;
export const scenes={compression,activations};
export const C={bg:'#070b13',card:'#101826',edge:'#26364d',text:'#f1f5fb',muted:'#a3b3c8',dim:'#53657d',red:'#fb7185',blue:'#7dd3fc'};
const FONT='"Animated CJK", "Noto Sans CJK SC", "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';
export function panelRects(n){
 if(!Number.isInteger(n)||n<4||n>8)throw Error('Use 4 to 8 comparison panels');
 const rows=Math.ceil(n/2),h=(1045-(rows-1)*25)/rows;
 return Array.from({length:n},(_,i)=>({x:80+(i%2)*470,y:500+Math.floor(i/2)*(h+25),w:450,h}));
}
export function createRenderer(canvas,cfg){
 const painter=scenes[cfg.scene];if(!painter)throw Error('Unknown scene; implement and register its model and paintPanel');
 if(cfg.panels.length!==painter.expectedPanels)throw Error('Config count differs from scene model');
 const c=canvas.getContext('2d');let bounds=[],capture=false,panel=-1,t=0;
 function text(v,x,y,size=26,color=C.text,align='center',weight=400){v=String(v);c.font=`${weight} ${size}px ${FONT}`;c.textAlign=align;c.textBaseline='alphabetic';c.fillStyle=color;c.fillText(v,x,y);if(capture){const m=c.measureText(v);bounds.push({text:v,x:x-(align==='center'?m.width/2:align==='right'?m.width:0),y:y-size,w:m.width,h:size*1.2,size,panel,scaleX:1,scaleY:1});}}
 function box(x,y,w,h,col=C.edge,fill=C.card,r=8,lw=1.5){c.beginPath();c.roundRect(x,y,w,h,r);c.fillStyle=fill;c.fill();c.strokeStyle=col;c.lineWidth=lw;c.stroke();}
 function line(points,col=C.edge,width=2,alpha=1){c.save();c.globalAlpha*=alpha;c.beginPath();points.forEach((v,i)=>i?c.lineTo(...v):c.moveTo(...v));c.strokeStyle=col;c.lineWidth=width;c.lineCap='round';c.lineJoin='round';c.stroke();c.restore();}
 function dot(x,y,r,col,alpha=1){c.save();c.globalAlpha*=alpha;c.beginPath();c.arc(x,y,r,0,2*Math.PI);c.fillStyle=col;c.fill();c.restore();}
 function flash(x,y,u,col){if(u<0||u>1)return;c.save();c.globalAlpha*=1-u;c.beginPath();c.arc(x,y,6+14*u,0,2*Math.PI);c.strokeStyle=col;c.lineWidth=2;c.stroke();dot(x,y,3,C.text);c.restore();}
 function pulse(points,start,end,col){line(points,col,1.7,.22);if(t>=start&&t<end){const lens=points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1]));let d=(t-start)/(end-start)*lens.reduce((a,b)=>a+b,0);for(let i=0;i<lens.length;i++){if(d<=lens[i]||i===lens.length-1){const u=lens[i]?d/lens[i]:0,a=points[i],b=points[i+1],x=mix(a[0],b[0],u),y=mix(a[1],b[1],u);dot(x,y,9,col,.16);dot(x,y,4.5,col);break;}d-=lens[i];}}
  if(t>=end){const a=points.at(-2),b=points.at(-1),ang=Math.atan2(b[1]-a[1],b[0]-a[0]);line([[b[0]-7*Math.cos(ang-.5),b[1]-7*Math.sin(ang-.5)],b,[b[0]-7*Math.cos(ang+.5),b[1]-7*Math.sin(ang+.5)]],col,1.6,.7);flash(...b,(t-end)/.4,col);}}
 function node(cx,cy,w,h,label,at,col,size=25){const on=t>=at;box(cx-w/2,cy-h/2,w,h,on?col:C.edge,on?'#142132':C.card,8,on?1.6:1.2);if(on&&label!=='')text(label,cx,cy+size*.34,size,col);}
 function tint(col,alpha,fn){c.save();c.globalAlpha*=alpha;fn();c.restore();}
 function heat(A,cx,cy,cellW=25,cellH=25,col=C.blue,numbers=false){const rows=A.length,cols=A[0].length,left=cx-cols*cellW/2,top=cy-rows*cellH/2;A.forEach((row,i)=>row.forEach((v,j)=>{const xx=left+j*cellW,yy=top+i*cellH;tint(col,.2+.65*clamp(Math.abs(v)),()=>box(xx+1,yy+1,cellW-2,cellH-2,col,col,2,.7));if(numbers)text(typeof v==='number'?(Math.abs(v)<1&&v!==0?v.toFixed(1):v):v,xx+cellW/2,yy+cellH*.72,22,C.text);}));}

 const ui={c,text,box,line,dot,flash,pulse,node,tint,heat,C};
 function draw(time,{captureBounds=false}={}){
  const period=cfg.duration,t0=((time%period)+period)%period;
  t=t0;capture=captureBounds;bounds=[];panel=-1;c.resetTransform();c.globalAlpha=1;c.fillStyle=C.bg;c.fillRect(0,0,W,H);
  text(cfg.kicker,80,256,25,C.muted,'left');text(`${cfg.panels.length} 图对照`,1000,256,25,C.blue,'right');
  text(cfg.title,80,330,60,C.text,'left',600);text(cfg.subtitle,82,382,30,C.blue,'left');
  box(80,413,920,63,C.edge,'#101a28');text(cfg.prompt,540,455,29,C.text);
  panelRects(cfg.panels.length).forEach(({x,y,w,h},i)=>{
   panel=i;const p=cfg.panels[i];box(x,y,w,h,C.edge,C.card,14);box(x+18,y+20,29,29,p.color,p.color,5);
   text(String(i+1).padStart(2,'0'),x+32.5,y+42,20,C.bg,'center',600);text(p.name,x+61,y+43,34,C.text,'left',600);
   c.font=`600 34px ${FONT}`;const nameWidth=c.measureText(p.name).width;
   if(p.english)text(`（${p.english}）`,x+66+nameWidth,y+43,24,p.color,'left',500);
   text(p.sub,x+20,y+78,23,p.color,'left');
   const paint=at=>{t=at;const state={...p,...painter.stateAt(at,i,cfg)};painter.paintPanel(ui,x,y,state,i,at,{w,h});text(state.stage,x+w/2,y+h-13,20,C.muted)};
   const fade=t0>period-.45?clamp((period-t0)/.45):1;
   if(fade<1){c.save();c.globalAlpha=1-fade;paint(0);c.restore()}
   c.save();c.globalAlpha=fade;paint(t0);c.restore();
  });
  panel=-1;text(cfg.footerNote,540,1628,26,C.muted);line([[80,1660],[1000,1660]],C.edge);
  text(cfg.footerLeft||'动态原理图',80,1690,21,C.dim,'left');text(cfg.author||'',1000,1690,21,C.muted,'right');
  return {time:t0,textBounds:bounds,panelCount:cfg.panels.length};
 }
 return {draw,canvas};
}
