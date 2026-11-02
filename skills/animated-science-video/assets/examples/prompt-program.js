function createScene(api) {
  const colors=['#7dd3fc','#c4b5fd','#fde68a','#6ee7b7'];
  const light='#edf4ff',muted='#a3b3c8',edge='#31445f';
  const mix=api.mix,progress=api.progress;
  const materials=[['指令','仅输出含税金额'],['资料','退货后按净额计税'],['示例','200退20 → 189元'],['问题','480退60，税率5%']];
  const words=['应付','441','元'];
  const logits=[[1.8,.9,.2],[2.6,.7,.1],[2.2,1.0,.3]];
  function softmax(values){const top=Math.max(...values),v=values.map(x=>Math.exp(x-top)),sum=v.reduce((a,b)=>a+b,0);return v.map(x=>x/sum);}
  function send(ui,points,t,color,options={}){ui.line(points,color,1.6,.4);ui.stream(points,t,{duration:.65,period:1.15,count:5,stagger:.18,color,radius:4.8,trail:8,...options});}
  function ring(ui,x,y,t,color){const phase=api.loop(t,.9)/.9;ui.flash(x,y,phase,color);ui.glow(x,y,22,color,.15);}
  function context(ui,x,y,t){
    const local=api.loop(t,5.2),u=progress(local,.25,1.45,'inOutCubic');
    ui.box(x+9,y+16,392,260,edge,'#0c1524',12,1.5);
    ui.text('角色与材料 → 上下文序列',x+205,y+42,22,light,'center',600);
    materials.forEach((m,i)=>{
      const f=progress(local,.25+i*.18,1.05,'inOutCubic')*(1-progress(local,4.6,.6,'inOutCubic'));
      const xx=x+26+52*(1-f),yy=y+60+i*51,w=mix(260,358,f),color=colors[i];
      ui.glow(xx+w/2,yy+22,50,color,.06+.16*Math.sin(f*Math.PI));
      ui.box(xx,yy,w,45,color,'#142235',7,1.8);
      if(f<.45){ui.text(m[0],xx+12,yy+20,20,color,'left',600);ui.text(m[1],xx+12,yy+40,18,light,'left');}
      else {ui.text(m[0],xx+12,yy+29,22,color,'left',600);ui.text(m[1],xx+78,yy+29,20,light,'left');}
    });
    const path=[[x+205,y+277],[x+205,y+314]];send(ui,path,t,colors[0]);
    ui.chip('冻结 LLM',x+205,y+337,190,39,colors[0],{fontSize:25,fill:'#142235'});
    ring(ui,x+304,y+337,t,colors[0]);
  }
  function examples(ui,x,y,t){
    const local=api.loop(t,5.2),p=progress(local,.4,1.3,'inOutCubic')*(1-progress(local,4.6,.6,'inOutCubic')),queryY=y+54;
    ui.chip('新题：480退60，5%',x+205,queryY,346,43,colors[1],{fontSize:24,fill:'#142235'});
    const rows=[{q:'200退20',a:'189',rank:0,color:colors[2]},{q:'100无退货',a:'105',rank:1,color:colors[1]}];
    rows.forEach((r,i)=>{
      const yy=y+109+mix(1-i,r.rank,p)*66;
      ui.c.save();if(i===0)ui.c.globalAlpha*=p<.5?1-progress(p,0,.15,'smooth'):progress(p,.85,.15,'smooth');
      ui.box(x+26,yy,358,53,r.color,'#142235',8,1.6);
      ui.text(r.q,x+42,yy+34,24,light,'left');ui.text('→',x+217,yy+34,26,r.color);ui.text(r.a,x+298,yy+34,27,r.color,'center',600);
      const scan=(api.loop(t,1.7)/1.7)*332;
      ui.line([[x+38+scan,yy+7],[x+38+scan,yy+46]],r.color,2,.45);
      ui.c.restore();
    });
    const route=[[x+365,y+157],[x+397,y+157],[x+397,y+266],[x+205,y+266],[x+205,y+302]];
    send(ui,route,t,colors[1],{duration:1.05,period:1.7,count:5});
    ui.chip('沿用输入 → 输出格式',x+205,y+326,328,43,colors[1],{fontSize:24,fill:'#142235'});
    ring(ui,x+205,y+297,t,colors[1]);
  }
  function nextToken(ui,x,y,t){
    const cycle=api.loop(t,7.8),index=Math.min(2,Math.floor(cycle/2.6)),local=api.loop(cycle,2.6),f=progress(local,.1,.7,'smooth');
    ui.chip('上下文 + 已生成 Token',x+205,y+35,365,42,colors[2],{fontSize:24,fill:'#142235'});
    send(ui,[[x+205,y+59],[x+205,y+95]],t,colors[2],{period:.9,count:4,stagger:.15});
    ui.chip('冻结 LLM',x+205,y+122,206,45,colors[2],{fontSize:26,fill:'#142235'});
    const current=softmax(logits[index]),previous=softmax(logits[(index+2)%3]),values=current.map((v,i)=>mix(previous[i],v,f));
    ui.text('下一 Token 概率（示意）',x+26,y+174,21,muted,'left');
    const labels=[words[index],'其他','其他'];
    values.forEach((v,i)=>{
      const yy=y+187+i*37;ui.box(x+26,yy,234,25,edge,'#0c1524',4,1);
      ui.box(x+26,yy,Math.max(2,234*v),25,i===0?colors[2]:edge,i===0?colors[2]:edge,4,0);
      ui.text(labels[i],x+278,yy+21,20,i===0?light:muted,'left');ui.text(Math.round(v*100)+'%',x+383,yy+21,18,muted,'right');
    });
    const start=[x+315,y+201],end=[x+60+index*117,y+333];
    const a=progress(local,1.1,1.0,'smooth'),pos=api.bezier(start,[x+420,y+215],[x+400,y+333],end,a);
    if(local>1.1&&local<2.1){ui.glow(pos[0],pos[1],28,colors[2],.4);ui.chip(words[index],pos[0],pos[1],84,36,colors[2],{fontSize:23,fill:'#172537'});}
    words.forEach((word,i)=>{ui.chip(i<index||i===index&&local>=2.1?word:'…',x+60+i*117,y+333,94,38,i<=index?colors[2]:edge,{fontSize:24,fill:'#142235'});});
    send(ui,[[x+26,y+333],[x+8,y+333],[x+8,y+35],[x+23,y+35]],t,colors[2],{duration:1.4,period:2.0,count:6,stagger:.2,radius:3.6});
  }
  function structured(ui,x,y,t){
    const local=api.loop(t,8),fields=[['amount','441'],['currency','CNY'],['status','ok']];
    ui.text('Schema 规定字段与类型',x+205,y+28,23,colors[3],'center',600);
    fields.forEach((field,i)=>{
      const yy=y+51+i*57,phase=progress(local,.7+i*.85,.55,'smooth');
      ui.box(x+26,yy,358,44,phase?colors[3]:edge,'#142235',7,1.5);
      ui.text(field[0],x+43,yy+29,23,light,'left',600);
      ui.arrow([[x+195,yy+23],[x+237,yy+23]],colors[3],1.7);
      if(phase>0)ui.typeText(field[1],x+268,yy+29,local,{start:.7+i*.85,duration:.5,fontSize:25,color:colors[3]});
      send(ui,[[x+8,yy+23],[x+25,yy+23]],t,colors[3],{period:1.15,count:3,stagger:.15,radius:3.8});
      if(phase>0&&phase<1)ui.flash(x+350,yy+22,phase,colors[3]);
    });
    ui.box(x+26,y+232,358,117,edge,'#0c1524',10,1.5);
    ui.text('{',x+42,y+253,22,muted,'left');ui.text('}',x+42,y+345,22,muted,'left');
    ui.typeText('"amount": 441,',x+63,y+276,local,{start:1.3,duration:.65,fontSize:22,color:light});
    ui.typeText('"currency": "CNY",',x+63,y+299,local,{start:2.1,duration:.7,fontSize:22,color:light});
    ui.typeText('"status": "ok"',x+63,y+322,local,{start:2.95,duration:.65,fontSize:22,color:light});
    const bad=api.loop(t,2.0)/2.0,xx=x+mix(360,190,bad);ui.dot(xx,y+216,5,'#fb7185',1-bad);ui.line([[x+180,y+206],[x+194,y+220]],'#fb7185',2);ui.line([[x+194,y+206],[x+180,y+220]],'#fb7185',2);ui.text('非法字段',x+95,y+222,18,'#fb7185');
  }
  return {
    stateAt(t,i){return {stage:['角色与材料共同条件化生成','示例在上下文内提供映射','逐 Token 选择，再回填上下文','字段按序填入，非法值被拦截'][i]};},
    paintPanel(ui,x,y,state,i,t,rect){[context,examples,nextToken,structured][i](ui,rect.body.x,rect.body.y,t);},
    checkModels(){return [
      {name:'四类材料进入同一上下文',passed:materials.length===4&&new Set(materials.map(x=>x[0])).size===4},
      {name:'两个示例按相同公式计算',passed:(200-20)*1.05===189&&100*1.05===105},
      {name:'每轮教学概率归一化',passed:logits.every(x=>Math.abs(softmax(x).reduce((a,b)=>a+b,0)-1)<1e-9)},
      {name:'订单金额441满足数值类型',passed:Number.isFinite((480-60)*1.05)&&(480-60)*1.05===441}
    ];}
  };
}
