import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkCreativeProject} from './creativeWorkspace';
import type {CreativeProject} from '../shared/creativeProject';
import {writePixelResources} from './pixelfxDefold';
const assets=fileURLToPath(new URL('../skills/defold-game/assets/',import.meta.url));
export async function defoldStarter(title='Token Catcher'):Promise<Omit<CreativeProject,'revision'|'updatedAt'>>{
 const [game,ambient]=await Promise.all(['game','ambient'].map(n=>readFile(path.join(assets,'nodes',n+'.gui_script'),'utf8')));
 return {format:1,kind:'defold',title,entry:'nodes/game.gui_script',files:[{path:'nodes/game.gui_script',content:game},{path:'nodes/ambient.gui_script',content:ambient}],nodes:[{id:'ambient',name:'背景动画',kind:'animation',file:'nodes/ambient.gui_script',enabled:true},{id:'game',name:'接取游戏场景',kind:'game',file:'nodes/game.gui_script',enabled:true}]};
}
export async function writeDefoldProject(project:CreativeProject,directory:string,options:{pixelfxCacheDirectory?:string}={}){
 checkCreativeProject(project);if(project.kind!=='defold'||project.nodes.some(n=>!(/\.(gui_script|script|go)$/.test(n.file))||n.kind==='canvas'))throw Error('Defold节点须引用.gui_script、.script或.go，类型为game或animation。');
 // Fixed build resources prevent model-supplied native extensions and build hooks.
 if(project.files.some(f=>!/^((nodes|lib)\/[a-zA-Z0-9_/-]+\.(gui_script|script|lua)|assets\/[a-zA-Z0-9_/-]+\.(json|go|sprite|atlas|particlefx|collisionobject|material|vp|fp))$/.test(f.path)))throw Error('Defold只开放nodes脚本、lib模块及assets文本资源；工程配置由构建器生成。');
 await mkdir(directory,{recursive:true});for(const f of project.files){await mkdir(path.dirname(path.join(directory,f.path)),{recursive:true});await writeFile(path.join(directory,f.path),f.content,{mode:0o600});}
 const pixel=await writePixelResources(project,directory,options.pixelfxCacheDirectory||path.join(path.dirname(directory),'.pixelfx-cache'));
 const enabled=project.nodes.filter(n=>n.enabled);if(!enabled.some(n=>n.kind==='game'))throw Error('至少需要一个启用的游戏场景节点。');
 let collection='name: "main"\n';
 for(const node of enabled){
  if(node.file.endsWith('.go')){collection+=`instances { id: "${node.id}" prototype: "/${node.file}" position { x: 0 y: 0 z: 0 } rotation { x: 0 y: 0 z: 0 w: 1 } }\n`;continue;}
  const gui=node.file.endsWith('.gui_script');
  if(gui)await writeFile(path.join(directory,node.id+'.gui'),`script: "/${node.file}"\nfonts { name: "default" font: "/builtins/fonts/default.font" }\n${pixel.textures}material: "/builtins/materials/gui.material"\nadjust_reference: ADJUST_REFERENCE_PARENT\nmax_nodes: 2048\n`);
  const data=`components { id: "${gui?'gui':'script'}" component: "/${gui?node.id+'.gui':node.file}" position { x: 0 y: 0 z: 0 } rotation { x: 0 y: 0 z: 0 w: 1 } }`;
  collection+=`embedded_instances { id: "${node.id}" data: ${JSON.stringify(data)} position { x: 0 y: 0 z: 0 } rotation { x: 0 y: 0 z: 0 w: 1 } }\n`;
 }
 await writeFile(path.join(directory,'main.collection'),collection);
 const hasJson=project.files.some(f=>f.path.startsWith('assets/')&&f.path.endsWith('.json'));
 await writeFile(path.join(directory,'game.project'),`[project]\ntitle = CreativeGame\n${hasJson?'custom_resources = /assets\n':''}[bootstrap]\nmain_collection = /main.collectionc\n[display]\nwidth = 960\nheight = 640\n[render]\nclear_color_red = 0.025\nclear_color_green = 0.045\nclear_color_blue = 0.08\n${pixel.bindings.length?'[graphics]\ndefault_texture_min_filter = nearest\ndefault_texture_mag_filter = nearest\n':''}[input]\ngame_binding = /game.input_bindingc\n[html5]\nscale_mode = fit\n`);
 const bindings=new Map([['KEY_LEFT','left'],['KEY_RIGHT','right'],['KEY_A','left'],['KEY_D','right'],['KEY_UP','up'],['KEY_W','up'],['KEY_DOWN','down'],['KEY_S','down'],['KEY_SPACE','jump'],['KEY_R','restart']]);
 const custom=project.files.find(f=>f.path==='assets/input.json');if(custom){const config=JSON.parse(custom.content);if(!Array.isArray(config.keys)||config.keys.length>32||config.keys.some((b:any)=>!b||!/^KEY_[A-Z0-9_]+$/.test(b.key)||!/^[-a-zA-Z0-9_]{1,32}$/.test(b.action)||['KEY_LEFT','KEY_RIGHT','KEY_R'].includes(b.key)))throw Error('assets/input.json需要至多32个{key,action}绑定；保留左右键与R的基础试玩操作。');for(const b of config.keys)bindings.set(b.key,b.action);}
 await writeFile(path.join(directory,'game.input_binding'),[...bindings].map(([key,action])=>`key_trigger { input: ${key} action: "${action}" }`).join('\n')+'\nmouse_trigger { input: MOUSE_BUTTON_1 action: "touch" }\n');
 await writeFile(path.join(directory,'creative-project.json'),JSON.stringify(project,null,2));
 return pixel;
}

export function defoldHudDiagnostics(project:CreativeProject){
 return project.files.flatMap(file=>file.content.split('\n').flatMap((line,index)=>{
  if(!/\b(label|gui\.new_text_node|gui\.set_text)\s*\(/.test(line))return [];
  let quote='',literal='',hasHan=false;for(let i=0;i<line.length;i++){const ch=line[i];if(quote){if(ch==='\\'){literal+=line[++i]||'';continue;}if(ch===quote){hasHan ||= /[\u3400-\u9fff]/.test(literal);quote='';literal='';}else literal+=ch;}else{if(ch==='-'&&line[i+1]==='-')break;if(ch==='"'||ch==="'")quote=ch;}}
  return hasHan?[{file:file.path,line:index+1,severity:'error' as const,message:'默认字体不含中文字形，请将HUD提示改为英文；代码注释可保持中文。'}]:[];
 }));
}
