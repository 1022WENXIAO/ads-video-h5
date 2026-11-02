import { Type } from 'typebox';

const short = (maxLength: number) => Type.String({ minLength:1, maxLength });
const coordinate = Type.Number({ minimum:0, maximum:1 });
const node = Type.Object({
  id: short(32), kind: Type.Union([Type.Literal('box'),Type.Literal('token')]), text: short(24),
  x: coordinate, y: coordinate, w: Type.Number({minimum:.12,maximum:.8}), h:Type.Number({minimum:.1,maximum:.26}),
  visible: Type.Optional(Type.Boolean()), active: Type.Optional(Type.Boolean()),
}, {additionalProperties:false});
const change = Type.Object({ nodeId:short(32), x:Type.Optional(coordinate), y:Type.Optional(coordinate), text:Type.Optional(short(24)), visible:Type.Optional(Type.Boolean()), active:Type.Optional(Type.Boolean()) },{additionalProperties:false});
const check = Type.Object({ name:short(80), step:Type.Integer({minimum:0,maximum:5}), nodeId:short(32), text:Type.Optional(short(24)), visible:Type.Optional(Type.Boolean()), active:Type.Optional(Type.Boolean()) },{additionalProperties:false});
export const scienceSceneSchema = Type.Object({
  title:short(14), subtitle:short(28), kicker:short(28), prompt:short(30), footerNote:short(28),
  author:short(24), duration:Type.Integer({minimum:8,maximum:64}), bgm:Type.Boolean(),
  comparison:short(500), boundary:short(2000), basis:Type.Array(short(1000),{minItems:1,maxItems:12}),
  panels:Type.Array(Type.Object({
    name:short(8), english:Type.String({maxLength:10}), sub:short(18), color:Type.String({pattern:'^#[a-fA-F0-9]{6}$'}), difference:short(500),
    nodes:Type.Array(node,{minItems:3,maxItems:10}),
    steps:Type.Array(Type.Object({label:short(16), changes:Type.Array(change,{maxItems:10})},{additionalProperties:false}),{minItems:3,maxItems:6}),
    transfers:Type.Array(Type.Object({from:short(32),to:short(32),step:Type.Integer({minimum:1,maximum:5})},{additionalProperties:false}),{minItems:1,maxItems:8}),
    checks:Type.Array(check,{minItems:1,maxItems:6}),
  },{additionalProperties:false}),{minItems:4,maxItems:8}),
},{additionalProperties:false});

import type { ScienceScene } from '../shared/scienceScene';
export type { ScienceScene } from '../shared/scienceScene';

/** Semantic validation is independent of provider JSON-schema enforcement. */
export function validateScienceScene(raw: ScienceScene, allowedUrls: Set<string>): ScienceScene {
  const text = (s:unknown,max:number) => typeof s==='string' && s.trim().length>0 && s.length<=max;
  if(raw&&Array.isArray(raw.basis)){
    raw={...raw,basis:raw.basis.map(value=>{
      if(typeof value!=='string')return value;
      if(allowedUrls.has(value.trim()))return value.trim();
      const urls=value.match(/https:\/\/[^\s<>"'，。；）)]+/g)||[];
      return urls.length===1&&allowedUrls.has(urls[0])?urls[0]:value;
    })};
    if(raw.basis.some(url=>!allowedUrls.has(url)))throw new Error('basis必须使用本次实际读取的来源URL，不能编造或只填写论文名。可用URL：'+JSON.stringify([...allowedUrls]));
  }
  if (!raw || !Number.isInteger(raw.duration) || raw.duration<8 || raw.duration>64 || typeof raw.bgm!=='boolean' || !text(raw.title,14) || !text(raw.subtitle,28) || !text(raw.kicker,28) || !text(raw.prompt,30) || !text(raw.footerNote,28) || !text(raw.author,24) || !text(raw.comparison,500) || !text(raw.boundary,2000) || !Array.isArray(raw.basis) || !raw.basis.length || raw.basis.length>12 || raw.basis.some(u=>!allowedUrls.has(u)) || !Array.isArray(raw.panels) || raw.panels.length<4 || raw.panels.length>8) throw new Error('模板模型格式无效；需要4–8图、8–64秒与实际核实的来源URL。');
  for (const p of raw.panels) {
    if (!p || !text(p.name,8) || typeof p.english!=='string' || p.english.length>10 || !text(p.sub,18) || !text(p.difference,500) || !/^#[a-f0-9]{6}$/i.test(p.color) || !Array.isArray(p.nodes) || p.nodes.length<3 || p.nodes.length>10 || !Array.isArray(p.steps) || p.steps.length<3 || p.steps.length>6 || !Array.isArray(p.transfers) || !p.transfers.length || p.transfers.length>8 || !Array.isArray(p.checks) || !p.checks.length || p.checks.length>6) throw new Error('每图需要3–10个节点、3–6步过程、数据传输和结果断言。');
    const ids = new Set(p.nodes.map(n=>n.id));
    if (ids.size!==p.nodes.length) throw new Error(`${p.name}节点ID重复。`);
    for (const n of p.nodes) if (!text(n.id,32) || !text(n.text,24) || !['box','token'].includes(n.kind) || ![n.x,n.y,n.w,n.h].every(Number.isFinite) || n.w<.12 || n.w>.8 || n.h<.1 || n.h>.26 || n.x<n.w/2 || n.x>1-n.w/2 || n.y<n.h/2 || n.y>1-n.h/2 || n.visible!==undefined&&typeof n.visible!=='boolean' || n.active!==undefined&&typeof n.active!=='boolean') throw new Error(`${p.name}节点${n.id}超出面板或文字过长（最多24字）；中心x/y须为各自半宽/半高至1减半宽/半高。`);
    let operation = false;
    const current = p.nodes.map(n=>({...n,visible:n.visible??true,active:n.active??false}));
    p.steps.forEach((s,i) => {
      if (!text(s.label,16) || !Array.isArray(s.changes) || s.changes.length>10) throw new Error(`${p.name}步骤无效。`);
      for (const c of s.changes) {
        const n = current.find(n=>n.id===c.nodeId);
        if (!n || !Object.keys(c).some(k=>k!=='nodeId') || Object.keys(c).some(k=>!['nodeId','x','y','text','visible','active'].includes(k)) || c.text!==undefined&&!text(c.text,24) || ['visible','active'].some(k=>c[k as 'visible']!==undefined&&typeof c[k as 'visible']!=='boolean')) throw new Error(`${p.name}状态更新无效。`);
        for (const axis of ['x','y'] as const) if (c[axis]!==undefined && (!Number.isFinite(c[axis]) || c[axis]!<n[axis==='x'?'w':'h']/2 || c[axis]!>1-n[axis==='x'?'w':'h']/2)) throw new Error(`${p.name}移动越界。`);
        if (i>0 && (['x','y','text','visible'] as const).some(k=>c[k]!==undefined && c[k]!==n[k])) operation=true;
        Object.assign(n,c);
      }
      const visible=current.filter(n=>n.visible);
      for(const n of visible){
        if(/JSON/i.test(p.english+' '+p.sub+' '+p.difference)&&/^\s*\{.*\}\s*$/.test(n.text))try{JSON.parse(n.text);}catch{throw new Error(`${p.name}步骤${i}节点${n.id}显示了非法JSON：${n.text}。字段名和字符串值须有双引号，修复对应steps的changes及checks文本。`);}
        for(const other of visible){
          if(other.id===n.id)continue;
          const overlapX=Math.min(n.x+n.w/2,other.x+other.w/2)-Math.max(n.x-n.w/2,other.x-other.w/2),overlapY=Math.min(n.y+n.h/2,other.y+other.h/2)-Math.max(n.y-n.h/2,other.y-other.h/2);
          if(overlapX>0&&overlapY>0&&overlapX*overlapY>Math.min(n.w*n.h,other.w*other.h)*.12)throw new Error(`${p.name}步骤${i}节点${n.id}与${other.id}重叠，请调整nodes/changes中的x/y/w/h或可见性。`);
        }
      }
      for (const check of p.checks.filter(c=>c.step===i)) {
        const n = current.find(n=>n.id===check.nodeId);
        if (!n || !text(check.name,80) || !['text','visible','active'].some(k=>check[k as 'text']!==undefined) || (['text','visible','active'] as const).some(k=>check[k]!==undefined&&check[k]!==n[k])) throw new Error(`${p.name}结果断言未通过：${check.name}；步骤从0起。检查${JSON.stringify(check)}；该步完成后的实际状态${JSON.stringify(n)}`);
      }
    });
    if (!operation) throw new Error(`${p.name}缺少可见操作，不能只闪光。`);
    const invalidTransfer=p.transfers.find(t=>!ids.has(t.from)||!ids.has(t.to)||t.from===t.to||!Number.isInteger(t.step)||t.step<1||t.step>=p.steps.length);
    if(invalidTransfer)throw new Error(`${p.name}传输引用无效：${JSON.stringify(invalidTransfer)}；step允许1–${p.steps.length-1}（steps数组下标），节点ID：${[...ids].join(',')}。`);
    if(p.checks.some(c=>!Number.isInteger(c.step)||c.step<0||c.step>=p.steps.length)||!p.checks.some(c=>c.step===p.steps.length-1))throw new Error(`${p.name}需有step=${p.steps.length-1}的最终结果检查；step从0起。`);
  }
  return structuredClone(raw);
}

export function patchScienceScene(candidate:ScienceScene,patches:Array<{path:string;jsonValue:string}>):ScienceScene {
  if(!Array.isArray(patches)||!patches.length||patches.length>24)throw new Error('每次修复需要1–24项字段修改。');
  const result=structuredClone(candidate);
  for(const patch of patches){
    if(typeof patch.path!=='string'||typeof patch.jsonValue!=='string'||patch.jsonValue.length>20000||!/^\/(?:title|subtitle|kicker|prompt|footerNote|author|duration|bgm|comparison|boundary|basis|panels)(?:\/[a-zA-Z0-9_-]+)*$/.test(patch.path))throw new Error('修复路径无效。');
    const parts=patch.path.slice(1).split('/');if(parts.some(p=>['__proto__','constructor','prototype'].includes(p)))throw new Error('修复路径无效。');
    let target:any=result;
    for(const key of parts.slice(0,-1)){if(!target||typeof target!=='object'||!Object.hasOwn(target,key))throw new Error('修复路径不存在：'+patch.path);target=target[key];}
    const key=parts.at(-1)!;if(!target||typeof target!=='object'||Array.isArray(target)&&(!/^\d+$/.test(key)||Number(key)>=target.length))throw new Error('修复路径不存在：'+patch.path);
    try{target[key]=JSON.parse(patch.jsonValue);}catch{throw new Error('jsonValue需要有效JSON，例如数值3写成"3"，文字写成JSON字符串。');}
  }
  return result;
}
