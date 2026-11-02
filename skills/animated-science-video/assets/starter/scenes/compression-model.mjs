export const W=1080,H=1920,PERIOD=16;
export const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
export const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
export const mix=(a,b,u)=>a+(b-a)*u;
export const sum=a=>a.reduce((s,v)=>s+v,0);
export const softmax=a=>{const m=Math.max(...a),p=a.map(v=>Math.exp(v-m)),z=sum(p);return p.map(v=>v/z);};
export const dot=(a,b)=>sum(a.map((v,i)=>v*b[i]));
export const mv=(A,x)=>A.map(row=>dot(row,x));
export const transpose=A=>A[0].map((_,j)=>A.map(row=>row[j]));
export const outer=(a,b)=>a.map(v=>b.map(w=>v*w));
export const mm=(A,B)=>A.map(row=>transpose(B).map(col=>dot(row,col)));
export const weights=[[-.83,.42,.17,.61],[.13,-.72,.51,.08],[.91,.28,-.36,.19],[-.11,.67,.04,-.54]];
export const quantScale=Math.max(...weights.flat().map(Math.abs))/7;
export const quantized=weights.map(row=>row.map(v=>Math.round(v/quantScale)));
export const keptLinks=weights.map(row=>row.map(v=>Math.abs(v)>=.35));
export const teacher=[.7,.2,.1];
export const distillSteps=[softmax([0,.3,.1])];
let dl=[0,.3,.1];for(let k=0;k<5;k++){const p=softmax(dl);dl=dl.map((v,i)=>v-.9*(p[i]-teacher[i]));distillSteps.push(softmax(dl));}
export const rankA=[[.8,.1],[.6,.3],[.4,.5],[.2,.7],[.1,.9],[.5,.4]],rankB=[[.8,.1,.6,.2,.7,.4],[.1,.9,.2,.8,.3,.5]],rankW=mm(rankA,rankB);
export const pruneTargets=weights.flatMap((row,a)=>row.flatMap((w,b)=>Math.abs(w)<.35?[{a,b,w}]:[]));
export const pruneCutStart=k=>4+k*.68;
export const distillStart=k=>1.5+k*2.25;
export const rankInput=[.2,.8,.4,.6,.3,.9];
export const rankMiddle=mv(rankB,rankInput),rankOutput=mv(rankA,rankMiddle);
export function compressionState(t,j){
 const qStep=clamp(Math.floor((t-1.2)/.48),0,15),qDone=clamp(Math.floor((t-1.2-.31)/.48)+1,0,16);
 const removed=pruneTargets.filter((_,k)=>t>=pruneCutStart(k)+.4).length;
 const r=clamp(Math.floor((t-(distillStart(0)+1.45))/2.25)+1,0,5);
 const updateAt=distillStart(Math.max(0,r-1))+1.45;
 const fraction=r?smooth((t-updateAt)/.55):0;
 const before=distillSteps[Math.max(0,r-1)],after=distillSteps[r];
 const stages=[
  t<1.2?'1 · 每个小数占 16 bit':qDone<16?'2 · 逐项映射到整数刻度':t<10.5?'3 · 存储位宽缩到 4 bit':'3 · 用更少位数表示权重',
  t<3?'1 · 数据沿 16 条连接传输':t<4?'2 · 标红本例的小权重连接':removed<7?'2 · 剪断 → 断线退去':'3 · 只沿剩余 9 条连接传输',
  t<1.5?'1 · 同一样本，两种预测分布':r<5?'2 · 比较分布，再更新学生':'3 · 学生预测逐步接近教师',
  t<2?'1 · 原矩阵有 36 个参数':t<5?'2 · 分解成两张小矩阵':t<10.8?'2 · 行与列相乘，重建对应值':'3 · 先经 B，再经 A 完成计算'
 ];
 return {qStep,qDone,removed,student:before.map((v,i)=>mix(v,after[i],fraction)),round:r,stage:stages[j]};
}
