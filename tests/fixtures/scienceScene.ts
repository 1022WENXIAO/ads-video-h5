import type { ScienceScene } from '../../shared/scienceScene';

export function scienceFixture(panels=6):ScienceScene {
  const names=['直接提问','明确指令','提供上下文','少样本示范','中间步骤','限定格式','角色提示','约束条件'];
  return {
    title:'Prompt如何影响输出',subtitle:'同一道题，比较输入约束',kicker:'大语言模型 / 提示设计',prompt:'共同任务：计算 2 × 4',footerNote:'教学示意，不代表真实推理或性能排名',author:'by轻喵制作',duration:16,bgm:true,
    comparison:'同一任务对比不同提示信息如何约束示例输出。',boundary:'这是固定结果的教学模型，不是真实语言模型推理记录。',basis:['https://arxiv.org/abs/2005.14165'],
    panels:names.slice(0,panels).map((name,i)=>({
      name,english:'',sub:'输入信息约束输出',color:['#7dd3fc','#c4b5fd','#6ee7b7','#fbbf24','#f9a8d4','#fb927e'][i%6],difference:`演示${name}下输入、处理与结果。`,
      nodes:[{id:'input',kind:'box',text:'2 × 4 = ?',x:.5,y:.14,w:.75,h:.2},{id:'data',kind:'token',text:'2×4',x:.32,y:.5,w:.3,h:.2},{id:'output',kind:'box',text:'等待输入',x:.5,y:.86,w:.75,h:.2}],
      steps:[{label:'1 · 相同输入',changes:[]},{label:'2 · 读取并处理',changes:[{nodeId:'data',x:.68,active:true}]},{label:'3 · 结果保留',changes:[{nodeId:'output',text:'8',active:true}]}],
      transfers:[{from:'input',to:'data',step:1},{from:'data',to:'output',step:2}],checks:[{name:'结果为2×4',step:2,nodeId:'output',text:'8',active:true}],
    })),
  };
}
