import {readFile,writeFile,mkdir,rename,rm,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnForJob,throwIfJobCancelled} from './jobExecution';
import {withFileLock} from './durableState';

export const pixelfxRoot=fileURLToPath(new URL('../third_party/pixelfx/',import.meta.url));
export const pixelfxManifestPath='assets/pixelfx.json';
const renderer=fileURLToPath(new URL('../tooling/creative/render-pixelfx.mjs',import.meta.url));
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
export interface PixelEffect {id:string;category:string;name:string;desc:string;tags:string[];size:[number,number];origin:[number,number];duration:number;loop:boolean;fps:number;hasAct:boolean;actor?:number;options?:Record<string,unknown>}
export interface PixelBinding {name:string;id:string;fps:number;seed:number;palette?:string[]}
export interface PixelRender {format:1;id:string;fps:number;frames:number;frameSize:[number,number];pivot:[number,number];loop:boolean;duration:number;pages:Array<{file:string;frames:number;columns:number;width:number;height:number}>;hashes:Record<string,string>}
const synonyms:Record<string,string[]>={
 fire:['火','火焰','火球','燃烧','火炬'],explosions:['爆炸','爆破','烟花','炸弹'],water:['水','水花','瀑布','喷泉'],ice:['冰','冰霜','冻结','雪花'],lightning:['闪电','雷电','雷击','电弧'],scifi:['科幻','护盾','全息','扫描','能量'],melee:['近战','斩击','刀光','剑','连击'],impacts:['受击','打击','碰撞','命中','冲击'],projectiles:['弹道','子弹','导弹','箭','激光'],spawn:['出生','死亡','重生','消失'],arcane:['魔法','法术','传送','符文'],holy:['治疗','圣光','光环','祝福'],shadow:['黑暗','诅咒','黑洞','暗影'],status:['状态','中毒','眩晕','灼烧'],nature:['自然','树叶','藤蔓','地震'],weather:['天气','下雨','下雪','极光','萤火虫'],ui:['界面','升级','倒计时','成就','数字'],pickups:['拾取','金币','宝箱','宝石','收集','奖励'],transitions:['转场','擦除','过渡'],critters:['生物','蝙蝠','蝴蝶','鸟','鱼'],moves:['动作','攻击','招式','蓄力']};
async function registry(){const lock=JSON.parse(await readFile(path.join(pixelfxRoot,'vendor.lock.json'),'utf8')),bytes=await readFile(path.join(pixelfxRoot,'catalog.json'));if(digest(bytes)!==lock.files.find((f:any)=>f.path==='catalog.json')?.sha256)throw Error('pixelfx目录摘要不符，请恢复受信资源。');return {lock,catalog:JSON.parse(bytes.toString()) as {effects:PixelEffect[];categories:Array<{id:string;name:string;blurb:string}>}};}
export async function pixelfxLibrary(){const {lock,catalog}=await registry();return {repository:lock.repository,commit:lock.commit,license:lock.license,count:catalog.effects.length,categories:catalog.categories.map(c=>({...c,keywords:synonyms[c.id]||[]})),defaultFps:15};}
export async function findPixelEffects(query:string,limit=6){
 if(typeof query!=='string'||query.length>200||!Number.isInteger(limit)||limit<1||limit>12)throw Error('特效查询最多200字，返回1–12条。');
 const {catalog}=await registry(),q=query.trim().toLowerCase(),tokens=q.split(/[\s,，;；]+/).filter(Boolean);
 const translated=Object.entries(synonyms).filter(([,terms])=>terms.some(term=>q.includes(term))).map(([cat])=>cat);
 const words:Record<string,string>={'金币':'coin','收集':'collect','拾取':'pickup','新星':'nova','冰霜':'frost','火球':'fireball','爆炸':'explosion','斩击':'slash','刀光':'slash','治疗':'heal','传送':'portal','护盾':'shield','闪电':'lightning','雷击':'strike','下雨':'rain','下雪':'snow','宝箱':'chest','升级':'level'};
 const expanded=[...tokens,...Object.entries(words).filter(([word])=>q.includes(word)).map(([,word])=>word)];
 const scored=catalog.effects.map(e=>{const text=[e.id,e.name,e.desc,...e.tags].join(' ').toLowerCase();let score=0;for(const token of expanded)if(text.includes(token))score+=e.id.includes(token)?8:2;if(q===e.id)score+=100;for(const cat of translated)if(e.category===cat)score+=5;return {e,score};}).filter(v=>!q||v.score>0).sort((a,b)=>b.score-a.score||a.e.id.localeCompare(b.e.id));
 return {total:scored.length,effects:scored.slice(0,limit).map(({e})=>({id:e.id,name:e.name,description:e.desc,category:e.category,tags:e.tags,size:e.size,duration:e.duration,loop:e.loop,containsCharacter:Boolean(e.actor),hasAct:e.hasAct})),next:'read_pixelfx_effect查看用法；preview_pixelfx_effect查看真实帧；use_pixelfx_effect按ID导入，无需重写特效代码。'};
}
export async function pixelEffect(id:string){const {catalog}=await registry(),e=catalog.effects.find(e=>e.id===id);if(!e)throw Error('未找到pixelfx特效，请先检索目录中的准确ID。');return e;}
export async function normalizePixelBinding(raw:any):Promise<PixelBinding>{
 if(!raw||typeof raw.name!=='string'||!/^[-a-z][a-z0-9_]{0,31}$/.test(raw.name)||raw.name.startsWith('-'))throw Error('特效名称须为小写字母开头，最多32个字母、数字或下划线。');
 const e=await pixelEffect(raw.id);const fps=raw.fps??15,seed=raw.seed??4;
 if(!Number.isInteger(fps)||fps<6||fps>30||!Number.isInteger(seed)||seed<0||seed>2147483647)throw Error('特效fps须为6–30的整数，seed须为非负整数。');
 if(raw.palette!==undefined&&(!Array.isArray(raw.palette)||raw.palette.length<2||raw.palette.length>16||raw.palette.some((c:unknown)=>typeof c!=='string'||!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(c))))throw Error('配色须为2–16个#RGB或#RRGGBB颜色。');
 if(Math.round(e.duration*fps)*e.size[0]*e.size[1]>36_000_000)throw Error('特效资源过大，请降低fps或选择较小特效。');
 return {name:raw.name,id:e.id,fps,seed,...(raw.palette?{palette:[...raw.palette]}:{})};
}
export async function pixelBindings(files:Array<{path:string;content:string}>){
 const file=files.find(f=>f.path===pixelfxManifestPath);if(!file)return [];
 let data:any;try{data=JSON.parse(file.content);}catch{throw Error('assets/pixelfx.json不是有效JSON。');}
 if(data.version!==1||!Array.isArray(data.effects)||data.effects.length>8)throw Error('pixelfx清单需要version:1和至多8个effects。');
 const effects=await Promise.all(data.effects.map(normalizePixelBinding)),names=new Set();for(const e of effects){if(names.has(e.name))throw Error('pixelfx名称重复。');names.add(e.name);}return effects;
}
export async function pixelfxSourceFingerprint(){
 const raw=await readFile(path.join(pixelfxRoot,'vendor.lock.json')),lock=JSON.parse(raw.toString());
 for(const f of lock.files){if(!/^(?:src\/|tools\/lib\/|LICENSE$|NOTICE\.md$|package\.json$|catalog\.json$)/.test(f.path)||f.path.split('/').includes('..'))throw Error('pixelfx资源锁路径无效。');const target=path.join(pixelfxRoot,f.path);if((await lstat(target)).isSymbolicLink()||digest(await readFile(target))!==f.sha256)throw Error('pixelfx受信源码已改变：'+f.path);}
 return digest(Buffer.concat([raw,await readFile(renderer),await readFile(fileURLToPath(new URL('./pixelfxDefold.ts',import.meta.url))),await readFile(fileURLToPath(new URL('../skills/defold-game/assets/pixelfx.lua',import.meta.url)))]));
}
async function readCached(folder:string,key:string,binding:PixelBinding){
 if(await realpath(folder)!==folder)throw Error('特效缓存目录不能是符号链接。');
 const info=JSON.parse(await readFile(path.join(folder,'render.json'),'utf8')) as PixelRender&{key:string};if(info.key!==key||!Array.isArray(info.pages)||!info.pages.length||info.pages.length>16)throw Error('特效缓存无效。');
 const source=await pixelEffect(binding.id),frames=Math.max(1,Math.round(source.duration*binding.fps)+(source.loop?0:1));
 if(info.id!==binding.id||info.fps!==binding.fps||info.frames!==frames||info.loop!==source.loop||JSON.stringify(info.frameSize)!==JSON.stringify(source.size)||JSON.stringify(info.pivot)!==JSON.stringify(source.origin)||info.duration!==frames/binding.fps)throw Error('特效缓存元数据不符。');
 if(info.pages.reduce((n,p)=>n+p.frames,0)!==frames||info.pages.some((p,i)=>p.file!==`page-${i}.png`||!Number.isInteger(p.frames)||p.frames<1||!Number.isInteger(p.columns)||p.columns<1||p.width!==p.columns*source.size[0]||p.height!==Math.ceil(p.frames/p.columns)*source.size[1]||p.width>2048||p.height>2048))throw Error('特效缓存分页无效。');
 for(const [file,hash]of Object.entries(info.hashes)){if(!/^(?:page-\d+|contact)\.png$/.test(file)||(await lstat(path.join(folder,file))).isSymbolicLink()||digest(await readFile(path.join(folder,file)))!==hash)throw Error('特效缓存摘要不符。');}
 if(!info.hashes['contact.png']||info.pages.some(p=>!/^page-\d+\.png$/.test(p.file)||!info.hashes[p.file]))throw Error('特效缓存缺少实际帧资源。');
 return info;
}
export async function renderPixelEffect(raw:PixelBinding,cacheDirectory:string){
 const binding=await normalizePixelBinding(raw),fingerprint=await pixelfxSourceFingerprint(),key=digest(JSON.stringify({fingerprint,id:binding.id,fps:binding.fps,seed:binding.seed,palette:binding.palette}));
 await mkdir(cacheDirectory,{recursive:true});const cache=await realpath(cacheDirectory),folder=path.join(cache,key);
 return withFileLock(folder,async()=>{
  throwIfJobCancelled();try{return {directory:folder,key,cacheHit:true,render:await readCached(folder,key,binding)};}catch{}
  const temp=path.join(cache,key+'.'+randomUUID()+'.tmp');await mkdir(temp);
  try{
   const input=path.join(temp,'input.json');await writeFile(input,JSON.stringify(binding),{mode:0o600});
   await new Promise<void>((resolve,reject)=>{const child=spawnForJob(process.execPath,['--max-old-space-size=256',renderer,input,temp],{inheritEnv:false,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','ignore','pipe']});let logs='';child.stderr!.on('data',(b:Buffer)=>logs=(logs+b.toString()).slice(-4000));const timer=setTimeout(()=>child.kill('SIGKILL'),45000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('pixelfx导出失败：'+logs));});});
   const info=JSON.parse(await readFile(path.join(temp,'render.json'),'utf8'));info.key=key;await writeFile(path.join(temp,'render.json'),JSON.stringify(info,null,2));await rm(input);await readCached(temp,key,binding);
   // Only replace this content-addressed entry; unrelated cache variants stay intact.
   await rm(folder,{recursive:true,force:true});await rename(temp,folder);
   return {directory:folder,key,cacheHit:false,render:await readCached(folder,key,binding)};
  }finally{await rm(temp,{recursive:true,force:true});}
 });
}
