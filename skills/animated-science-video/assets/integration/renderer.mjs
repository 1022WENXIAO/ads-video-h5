import * as authored from './scene.mjs';
const clamp=v=>Math.max(0,Math.min(1,v)),mix=(a,b,u)=>a+(b-a)*u;
export const W=1080,H=1920;
export const scenes={authored};
export const C={bg:'#070b13',card:'#101826',edge:'#26364d',text:'#f1f5fb',muted:'#a3b3c8',dim:'#53657d',red:'#fb7185',blue:'#7dd3fc'};
const FONT='"Animated CJK", "Noto Sans CJK SC", "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';
export function panelRects(n){
 if(!Number.isInteger(n)||n<4||n>8)throw Error('Use 4 to 8 comparison panels');
 const rows=Math.ceil(n/2),h=(1045-(rows-1)*25)/rows;
 return Array.from({length:n},(_,i)=>({x:80+(i%2)*470,y:500+Math.floor(i/2)*(h+25),w:450,h}));
}
export function createRenderer(canvas,cfg){
 const painter=scenes[cfg.scene];if(!painter)throw Error('Unknown scene; implement and register its model and paintPanel');
 if(cfg.panels.length<4||cfg.panels.length>8)throw Error('Config count differs from scene model');
 const c=canvas.getContext('2d');let bounds=[],capture=false,panel=-1,t=0,region='chrome';
 function text(v,x,y,size=26,color=C.text,align='center',weight=400){
  v=String(v);c.font=`${weight} ${size}px ${FONT}`;c.textAlign=align;c.textBaseline='alphabetic';c.fillStyle=color;c.fillText(v,x,y);
  if(capture&&v&&c.globalAlpha>.08){const m=c.measureText(v),left=x-(align==='center'?m.width/2:align==='right'?m.width:0),top=y-(m.actualBoundingBoxAscent||size),height=(m.actualBoundingBoxAscent||size)+(m.actualBoundingBoxDescent||size*.15),tr=c.getTransform();
   const pts=[[left,top],[left+m.width,top],[left,top+height],[left+m.width,top+height]].map(([xx,yy])=>({x:tr.a*xx+tr.c*yy+tr.e,y:tr.b*xx+tr.d*yy+tr.f}));
   const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);bounds.push({text:v,x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys),size,panel,region,scaleX:Math.hypot(tr.a,tr.b),scaleY:Math.hypot(tr.c,tr.d)});
  }
 }
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
 function drawScene(time,{captureBounds=false}={}){
  const period=cfg.duration,t0=((time%period)+period)%period;
  t=t0;capture=captureBounds;bounds=[];panel=-1;region='chrome';c.resetTransform();c.globalAlpha=1;c.fillStyle=C.bg;c.fillRect(0,0,W,H);
  text(cfg.kicker,80,256,25,C.muted,'left');text(`${cfg.panels.length} 图对照`,1000,256,25,C.blue,'right');
  text(cfg.title,80,330,60,C.text,'left',600);text(cfg.subtitle,82,382,30,C.blue,'left');
  box(80,413,920,63,C.edge,'#101a28');text(cfg.prompt,540,455,29,C.text);
  panelRects(cfg.panels.length).forEach(({x,y,w,h},i)=>{
   panel=i;const p=cfg.panels[i];box(x,y,w,h,C.edge,C.card,14);box(x+18,y+20,29,29,p.color,p.color,5);
   text(String(i+1).padStart(2,'0'),x+32.5,y+42,20,C.bg,'center',600);text(p.name,x+61,y+43,34,C.text,'left',600);
   c.font=`600 34px ${FONT}`;const nameWidth=c.measureText(p.name).width;
   if(p.english)text(`（${p.english}）`,x+66+nameWidth,y+43,24,p.color,'left',500);
   text(p.sub,x+20,y+78,23,p.color,'left');
   t=t0;const state={...p,...painter.stateAt(t0,i,cfg)};
   region='body';c.save();painter.paintPanel(ui,x,y,state,i,t0,{w,h,body:{x:x+20,y:y+108,w:w-40,h:h-145}});c.restore();
   region='stage';text(state.stage,x+w/2,y+h-13,20,C.muted);region='chrome';
  });
  panel=-1;text(cfg.footerNote,540,1628,26,C.muted);line([[80,1660],[1000,1660]],C.edge);
  text(cfg.footerLeft||'动态原理图',80,1690,21,C.dim,'left');text(cfg.author||'',1000,1690,21,C.muted,'right');
  return {time:t0,textBounds:bounds,panelCount:cfg.panels.length};
 }
 const blend=canvas.ownerDocument.createElement('canvas');blend.width=W;blend.height=H;
 const blendContext=blend.getContext('2d');
 function draw(time,options={}){
  const result=drawScene(time,options),remaining=cfg.duration-result.time;
  // Composite after authored drawing: scene-local alpha assignments cannot break the loop reset.
  if(remaining<.45){
   blendContext.resetTransform();blendContext.globalAlpha=1;blendContext.clearRect(0,0,W,H);blendContext.drawImage(canvas,0,0);
   drawScene(0);c.resetTransform();const u=clamp(remaining/.45);c.globalAlpha=u*u*(3-2*u);c.drawImage(blend,0,0);c.globalAlpha=1;
  }
  return result;
 }
 return {draw,canvas};
}
