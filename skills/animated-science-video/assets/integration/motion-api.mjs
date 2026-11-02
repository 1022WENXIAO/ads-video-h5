// Browser-only animation capabilities. Every helper derives its output from t.
export function createMotionAPI(){
 const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v)),mix=(a,b,u)=>a+(b-a)*u;
 const easing={linear:u=>u,smooth:u=>u*u*(3-2*u),inOutCubic:u=>u<.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2,outCubic:u=>1-Math.pow(1-u,3),outBack:u=>1+2.70158*Math.pow(u-1,3)+1.70158*Math.pow(u-1,2)};
 const progress=(t,start,duration,ease='smooth')=>(easing[ease]||easing.smooth)(clamp((t-start)/Math.max(.001,duration)));
 function pointAt(points,u){
  if(points.length<2)throw Error('轨迹至少需要2个点');
  const lengths=points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1])),total=lengths.reduce((a,b)=>a+b,0);let d=clamp(u)*total;
  for(let i=0;i<lengths.length;i++){if(d<=lengths[i]||i===lengths.length-1){const k=lengths[i]?d/lengths[i]:0;return[mix(points[i][0],points[i+1][0],k),mix(points[i][1],points[i+1][1],k)];}d-=lengths[i];}
 }
 function bezier(a,b,c,d,u){const v=1-u;return[0,1].map(k=>v*v*v*a[k]+3*v*v*u*b[k]+3*v*u*u*c[k]+u*u*u*d[k]);}
 function seeded(seed,index=0){let v=(Math.imul(seed|0,1664525)+Math.imul(index+1,1013904223))>>>0;v^=v>>>16;v=Math.imul(v,0x45d9f3b)>>>0;return(v>>>0)/4294967296;}
 const loop=(t,period,offset=0)=>((t-offset)%period+period)%period;
 function extendUI(base){
  const c=base.c,ui={...base};
  ui.layer=(options,draw)=>{c.save();c.translate(options.x||0,options.y||0);if(options.rotate)c.rotate(options.rotate);const scale=options.scale??1;c.scale(scale,scale);c.globalAlpha*=options.opacity??1;try{draw();}finally{c.restore();}};
  ui.glow=(x,y,r,color,strength=.3)=>{c.save();c.globalAlpha*=strength;const g=c.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,color);g.addColorStop(1,color+'00');c.fillStyle=g;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();c.restore();};
  ui.arrow=(points,color,width=2,reveal=1)=>{const end=pointAt(points,reveal),shown=[];let full=0;for(let i=1;i<points.length;i++)full+=Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);let length=0;shown.push(points[0]);for(let i=1;i<points.length;i++){length+=Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);if(length>=full*reveal){shown.push(end);break;}shown.push(points[i]);}base.line(shown,color,width);const before=pointAt(points,Math.max(0,reveal-.02)),angle=Math.atan2(end[1]-before[1],end[0]-before[0]);base.line([[end[0]-8*Math.cos(angle-.5),end[1]-8*Math.sin(angle-.5)],end,[end[0]-8*Math.cos(angle+.5),end[1]-8*Math.sin(angle+.5)]],color,width);};
  ui.packet=(points,t,options={})=>{
   const {start=0,duration=.65,repeat=0,color=base.C.blue,radius=4,trail=5,feedback=true}=options;
   if(t<start)return;const local=repeat>0?loop(t,repeat,start):t-start,u=local/duration;
   if(u>=0&&u<=1){for(let k=trail;k>=0;k--){const a=u-k*.035;if(a<0)continue;const p=pointAt(points,a);base.dot(p[0],p[1],radius*(1-k/(trail+1)*.65),color,(1-k/(trail+1))*.8);}const p=pointAt(points,u);ui.glow(p[0],p[1],radius*3.2,color,.35);base.dot(p[0],p[1],radius,color);}
   if(feedback&&u>1&&local<duration+.3){const p=points.at(-1);base.flash(p[0],p[1],(local-duration)/.3,color);}
  };
  ui.stream=(points,t,options={})=>{const {count=3,stagger=.18,period=1.2,...rest}=options;for(let k=0;k<count;k++)ui.packet(points,t,{...rest,start:(rest.start||0)+k*stagger,repeat:period});};
  ui.chip=(text,x,y,w,h,color,options={})=>{if(options.glow)ui.glow(x,y,Math.max(w,h)*.7,color,options.glow);base.box(x-w/2,y-h/2,w,h,color,options.fill||'#122234',options.radius??7,options.strokeWidth??1.5);if(text)base.text(text,x,y+(options.fontSize||23)*.34,options.fontSize||23,options.textColor||base.C.text,'center',options.weight||400);};
  ui.typeText=(text,x,y,t,options={})=>{const {start=0,duration=1,fontSize=24,color=base.C.text,align='left'}=options;const n=Math.floor(clamp((t-start)/Math.max(.01,duration))*Array.from(text).length);if(t>=start)base.text(Array.from(text).slice(0,n).join(''),x,y,fontSize,color,align);};
  ui.matrix=(values,x,y,options={})=>{const {cell=24,gap=2,color=base.C.blue,numbers=false,active=-1,max=1}=options;values.forEach((row,i)=>row.forEach((value,j)=>{const k=i*row.length+j,left=x+j*cell,top=y+i*cell; c.save();c.globalAlpha*=.16+.7*clamp(Math.abs(value)/max);base.box(left+gap/2,top+gap/2,cell-gap,cell-gap,color,color,2,0);c.restore();if(k===active)base.box(left,top,cell,cell,base.C.text,'#00000000',2,2);if(numbers)base.text(Number(value).toFixed(options.decimals??0),left+cell/2,top+cell*.74,options.fontSize||20,base.C.text);}));};
  ui.bars=(values,x,y,w,h,options={})=>{const {max=1,color=base.C.blue,labels=[],gap=12}=options,bh=(h-gap*(values.length-1))/values.length;values.forEach((v,i)=>{base.box(x,y+i*(bh+gap),w,bh,base.C.edge,'#0b1421',3,1);base.box(x,y+i*(bh+gap),Math.max(.5,w*clamp(v/max)),bh,color,color,3,0);if(labels[i])base.text(labels[i],x-8,y+i*(bh+gap)+bh*.8,options.fontSize||21,base.C.muted,'right');});};
  ui.scissors=(x,y,angle,u,color=base.C.text)=>{ui.layer({x,y,rotate:angle},()=>{const spread=mix(.72,.08,clamp(u));for(const sign of[-1,1]){const a=sign*spread,hx=-22*Math.cos(a),hy=-22*Math.sin(a);c.beginPath();c.ellipse(hx,hy,7,5,a,0,Math.PI*2);c.strokeStyle=color;c.lineWidth=2.8;c.stroke();base.line([[hx+6*Math.cos(a),hy+6*Math.sin(a)],[0,0],[25*Math.cos(a),25*Math.sin(a)]],color,3.4);}base.dot(0,0,3,base.C.red);});};
  return ui;
 }
 return {version:2,clamp,mix,easing,progress,pointAt,bezier,seeded,loop,extendUI};
}
