import {clamp,smooth,mix,weights,quantized,quantScale,keptLinks,teacher,rankA,rankB,rankW,pruneTargets,pruneCutStart,distillStart,rankInput,rankMiddle,rankOutput} from './compression-model.mjs';

// Each mechanism has an observable operation before its result appears.
export function paintCompression(ui,x,y,s,j,t){
 const {c,text,box,line,dot,flash,pulse,node,tint,heat,C}=ui,col=s.color;
 const point=(a,b,u)=>[mix(a[0],b[0],u),mix(a[1],b[1],u)];
 function packet(a,b,start,duration,color=col,r=5){
  if(t>=start&&t<start+duration){const [xx,yy]=point(a,b,(t-start)/duration);dot(xx,yy,r+5,color,.18);dot(xx,yy,r,color);}
  flash(...b,(t-start-duration)/.35,color);
 }
 function cellBorder(cx,cy,w,h,color=col){box(cx-w/2,cy-h/2,w,h,color,'#00000000',3,2.5);}
 function scissors(cx,cy,angle,u){
  c.save();c.translate(cx,cy);c.rotate(angle);
  const spread=mix(.72,.08,smooth(u));
  for(const sign of [-1,1]){
   const a=sign*spread;
   // Two handles and two blades visibly close across the selected edge.
   const hx=-22*Math.cos(a),hy=-22*Math.sin(a);
   c.beginPath();c.ellipse(hx,hy,7,5,a,0,Math.PI*2);c.strokeStyle=C.text;c.lineWidth=2.8;c.stroke();
   line([[hx+6*Math.cos(a),hy+6*Math.sin(a)],[0,0],[25*Math.cos(a),25*Math.sin(a)]],C.text,3.4);
  }
  dot(0,0,3,C.red);c.restore();
 }
 if(j===0){
  text('FP16 小数',x+112,y+126,25,C.muted);text('INT4 整数',x+338,y+126,25,col);
  const left=x+28,right=x+254,top=y+154,cw=42,ch=36;
  for(let a=0;a<4;a++)for(let b=0;b<4;b++){
   const k=a*4+b,cy=top+a*ch+18,lx=left+b*cw+21,rx=right+b*cw+21;
   box(lx-20,cy-17,40,34,C.edge,'#243347',2,1);
   text(weights[a][b].toFixed(2).replace(/^(-?)0/,'$1'),lx,cy+7,22,C.text);
   box(rx-20,cy-17,40,34,k<s.qDone?col:C.edge,k<s.qDone?'#21475e':C.card,2,1);
   if(k<s.qDone)text(quantized[a][b],rx,cy+7,22,col);
   if(k===s.qStep&&t>=1.2&&s.qDone<16){
    cellBorder(lx,cy,42,36);cellBorder(rx,cy,42,36);
    packet([x+203,cy],[x+248,cy],1.2+k*.48,.31);
   }
   flash(rx,cy,(t-(1.2+k*.48+.31))/.28,col);
  }
  line([[x+205,y+226],[x+245,y+226]],col,2,.6);
  if(t>=1.2){const a=Math.floor(s.qStep/4),b=s.qStep%4;
   text(s.qDone===16?'16 个权重完成映射':`${weights[a][b].toFixed(2)} → ${quantized[a][b]}`,x+225,y+334,26,col);
   text(`除以 ${quantScale.toFixed(2)}，再取整`,x+225,y+369,23,C.muted);
  }
  if(t>=8.9){
   text('每个权重：16 bit → 4 bit',x+225,y+414,26,col);
   const u=smooth((t-8.9)/1.35);
   for(let k=0;k<16;k++){
    const xx=x+65+k*20;
    box(xx,y+434,16,15,C.edge,C.card,2,1);
    if(k<4)box(xx,y+434,16,15,col,col,2,1);
    else tint(col,1-u,()=>box(xx,y+434-18*u,16,15,col,col,2,1));
   }
  }
 }else if(j===1){
  text('输入节点',x+75,y+129,22,C.muted);text('下一层',x+375,y+129,22,C.muted);
  const ends=(a,b)=>[[x+75,y+174+a*60],[x+375,y+174+b*60]];
  for(let a=0;a<4;a++)for(let b=0;b<4;b++){
   const [p,q]=ends(a,b),keep=keptLinks[a][b],k=pruneTargets.findIndex(v=>v.a===a&&v.b===b);
   const start=keep?Infinity:pruneCutStart(k),u=t-start;
   const marked=!keep&&t>=3,color=marked?C.red:col;
   const width=keep?3+Math.abs(weights[a][b])*1.8:2.8;
   const cutAt=.32+.055*(k%5),cp=point(p,q,cutAt);
   if(keep||u<.4){line([p,q],color,width,marked?.95:.7);}
   else if(u<1.0){
    const v=smooth((u-.4)/.6),gap=.015+.16*v,drop=25*v;
    const l=point(p,q,Math.max(0,cutAt-gap)),r=point(p,q,Math.min(1,cutAt+gap));
    line([p,[l[0],l[1]+drop]],C.red,width,1-v);
    line([[r[0],r[1]+drop],q],C.red,width,1-v);
   }
   // Packets travel on every connection before pruning; only surviving ones afterwards.
   for(const cycle of [0,1]){
    const at=.6+cycle*1.15+a*.12;
    if(t<3)packet(p,q,at,.76,col,keep?4.4:3.4);
   }
   if(keep)for(let cycle=0;cycle<4;cycle++)packet(p,q,9.65+cycle*1.22+a*.1,.82,col,4.6);
   if(!keep&&u>=-.12&&u<.64){
    // Cover nearby crossings so that the one being cut is unmistakable.
    line([point(p,q,cutAt-.12),point(p,q,cutAt+.12)],C.card,12);
    if(u<.4)line([point(p,q,cutAt-.12),point(p,q,cutAt+.12)],C.red,4);
    scissors(cp[0],cp[1],Math.atan2(q[1]-p[1],q[0]-p[0])+Math.PI/2,clamp(u/.4));
    flash(...cp,(u-.4)/.42,C.red);
   }
  }
  for(let k=0;k<4;k++){
   dot(x+75,y+174+k*60,13,col);dot(x+375,y+174+k*60,13,col);
   const on=t<3||t>=9.65;
   if(on){const base=t<3?.6:9.65;const d=(t-base-k*.1)%1.22;
    if(d>=0&&d<.25)flash(x+75,y+174+k*60,d/.25,col);
   }
  }
  if(t>=3)text(t<9.65?'红线：|权重| < 0.35':'仅保留较大权重的连接',x+225,y+405,24,t<9.65?C.red:col);
  text(s.removed?`连接数：16 → ${16-s.removed}`:'连接数：16 条',x+225,y+445,28,col);
 }else if(j===2){
  node(x+120,y+170,158,84,'教师模型',0,col,26);
  node(x+338,y+170,132,68,'学生模型',0,col,26);
  text('教师预测',x+120,y+252,23,C.muted);text('学生预测',x+338,y+252,23,C.muted);
  for(let k=0;k<3;k++){
   const yy=y+294+k*40;
   text(['猫','狗','鸟'][k],x+30,yy+7,22,C.muted);
   box(x+60,yy-8,116,16,C.edge,C.card,3,1);box(x+270,yy-8,116,16,C.edge,C.card,3,1);
   box(x+60,yy-8,116*teacher[k],16,col,col,3,1);
   box(x+270,yy-8,116*s.student[k],16,col,col,3,1);
   text(Math.round(100*teacher[k])+'%',x+237,yy+7,21,C.muted,'right');
   text(Math.round(100*s.student[k])+'%',x+436,yy+7,21,col,'right');
  }
  for(let r=0;r<5;r++){
   const at=distillStart(r);
   pulse([[x+120,y+212],[x+120,y+264]],at,at+.3,col);
   pulse([[x+338,y+204],[x+338,y+264]],at,at+.3,col);
   for(let k=0;k<3;k++)flash(x+120,y+294+k*40,(t-at-.3)/.35,col);
   pulse([[x+120,y+398],[x+120,y+408],[x+182,y+408],[x+182,y+416]],at+.35,at+.8,col);
   pulse([[x+338,y+398],[x+338,y+408],[x+268,y+408],[x+268,y+416]],at+.35,at+.8,col);
   pulse([[x+380,y+434],[x+442,y+434],[x+442,y+170],[x+404,y+170]],at+.85,at+1.45,C.red);
   flash(x+338,y+170,(t-at-1.45)/.5,col);
   for(let k=0;k<3;k++)flash(x+270+116*s.student[k],y+294+k*40,(t-at-1.45)/.55,col);
  }
  node(x+225,y+434,310,36,t<1.5?'':`比较分布 → 更新学生 · ${clamp(Math.floor((t-1.5)/2.25)+1,1,5)}轮`,1.5,col,22);
 }else{
  text('原矩阵 W',x+96,y+132,23,C.muted);
  text('因子 A',x+235,y+132,23,col);text('因子 B',x+350,y+132,23,col);
  text('6×6',x+96,y+170,25,C.muted);text('6×2',x+235,y+170,25,col);text('2×6',x+350,y+170,25,col);
  const cy=y+249,cell=20;
  heat(rankW,x+96,cy,cell,cell,C.dim);
  if(t>=2){
   text('≈',x+181,y+258,32,col);
   const u=smooth((t-2)/1.25);
   tint(col,u,()=>heat(rankA,x+235,cy,cell,cell,col));
   pulse([[x+151,y+249],[x+209,y+249]],2,2.75,col);
  }
  if(t>=3.3){
   text('×',x+274,y+258,29,C.muted);
   tint(col,smooth((t-3.3)/1.25),()=>heat(rankB,x+350,cy,cell,cell,col));
   pulse([[x+257,y+249],[x+286,y+249]],3.3,4.1,col);
  }
  // A selected row and B column generate one W cell. Completed cells remain lit.
  const done=clamp(Math.floor((t-5)/.15),0,36),active=Math.min(35,done);
  if(t>=5){
   for(let k=0;k<done;k++){
    const a=Math.floor(k/6),b=k%6;
    tint(col,.25+.5*rankW[a][b],()=>box(x+37+b*20,y+190+a*20,18,18,col,col,2,1));
   }
   if(done<36){
    const a=Math.floor(active/6),b=active%6;
    cellBorder(x+235,y+199+a*20,42,20);
    cellBorder(x+300+b*20,cy,20,42);
    cellBorder(x+46+b*20,y+199+a*20,20,20);
    packet([x+215,y+199+a*20],[x+46+b*20,y+199+a*20],5+active*.15,.12,col,3);
   }
  }
  if(t>=4.5)text('36 个参数 → 12 + 12 个',x+225,y+347,26,col);
  if(t>=10.5){
   const nodes=[{cx:72,n:6,v:rankInput,label:'输入 6维'}, {cx:225,n:2,v:rankMiddle,label:'中间 2维'}, {cx:378,n:6,v:rankOutput,label:'输出 6维'}];
   for(const {cx,n,v,label} of nodes){
    text(label,x+cx,y+390,21,C.muted);
    const max=Math.max(...v);
    for(let k=0;k<n;k++)box(x+cx-n*9+k*18,y+405,13,25,C.edge,'#18263a',2,1);
    const ready=cx===72||cx===225&&t>=11.45||cx===378&&t>=12.2;
    if(ready)for(let k=0;k<n;k++)tint(col,.25+.7*v[k]/max,()=>box(x+cx-n*9+k*18,y+405,13,25,col,col,2,1));
   }
   text('B',x+148,y+407,22,col);text('A',x+302,y+407,22,col);
   for(const at of [10.7,12.7]){
    pulse([[x+130,y+425],[x+205,y+425]],at,at+.75,col);
    pulse([[x+245,y+425],[x+320,y+425]],at+.75,at+1.5,col);
   }
  }else if(t>=5)text('A 的一行 × B 的一列 → W 一格',x+225,y+414,22,C.muted);
 }
}

export {compressionState as stateAt} from './compression-model.mjs';
export const expectedPanels=4;
export const paintPanel=paintCompression;
