import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {CreativeProject} from '../shared/creativeProject';
import {pixelBindings,renderPixelEffect,pixelfxLibrary,pixelfxRoot} from './pixelfx';

const helper=fileURLToPath(new URL('../skills/defold-game/assets/pixelfx.lua',import.meta.url));
export async function writePixelResources(project:CreativeProject,directory:string,cacheDirectory:string){
 const bindings=await pixelBindings(project.files);if(!bindings.length)return {textures:'',bindings:[]};
 if(project.files.some(f=>/^lib\/pixelfx(?:_data)?\.lua$/.test(f.path)||f.path.startsWith('assets/pixelfx/')))throw Error('内置pixelfx资源路径已被自定义文件占用，请重命名这些文件。');
 const textures:string[]=[],lua:string[]=[],records:any[]=[];let textureBytes=0;
 const power=(n:number)=>2**Math.ceil(Math.log2(n));
 for(const binding of bindings){
  const cached=await renderPixelEffect(binding,cacheDirectory),r=cached.render,folder=path.join(directory,'assets/pixelfx',binding.name);await mkdir(folder,{recursive:true});
  const pages=[];
  for(let i=0;i<r.pages.length;i++){
   const p=r.pages[i];textureBytes+=power(p.width)*power(p.height)*4;if(textureBytes>192*1024*1024)throw Error('导入特效纹理超过192MiB，请降低fps、减少特效或复用同一binding。');
   await copyFile(path.join(cached.directory,p.file),path.join(folder,p.file));
   const resource=`/assets/pixelfx/${binding.name}/page-${i}.tilesource`,texture=`px_${binding.name}_${i}`;
   await writeFile(path.join(directory,resource.slice(1)),`image: "/assets/pixelfx/${binding.name}/${p.file}"\ntile_width: ${r.frameSize[0]}\ntile_height: ${r.frameSize[1]}\ntile_margin: 0\ntile_spacing: 0\nextrude_borders: 0\ninner_padding: 0\nanimations { id: "play" start_tile: 1 end_tile: ${p.frames} playback: PLAYBACK_LOOP_FORWARD fps: ${r.fps} }\n`);
   textures.push(`textures { name: "${texture}" texture: "${resource}" }`);pages.push(`{texture=${JSON.stringify(texture)},frames=${p.frames}}`);
  }
  lua.push(`[${JSON.stringify(binding.name)}]={w=${r.frameSize[0]},h=${r.frameSize[1]},ox=${r.pivot[0]},oy=${r.pivot[1]},frames=${r.frames},fps=${r.fps},loop=${r.loop},pages={${pages.join(',')}}}`);
  records.push({...binding,cacheKey:cached.key,frames:r.frames,pages:r.pages,hashes:r.hashes,pivot:r.pivot});
 }
 await mkdir(path.join(directory,'lib'),{recursive:true});await copyFile(helper,path.join(directory,'lib/pixelfx.lua'));await writeFile(path.join(directory,'lib/pixelfx_data.lua'),'return {\n'+lua.join(',\n')+'\n}\n');
 const licenses=path.join(directory,'pixelfx-licenses');await mkdir(licenses,{recursive:true});
 for(const file of ['LICENSE','NOTICE.md'])await copyFile(path.join(pixelfxRoot,file),path.join(licenses,file));
 const library=await pixelfxLibrary();await writeFile(path.join(directory,'pixelfx-assets.json'),JSON.stringify({library,bindings:records,textureBytes},null,2));
 return {textures:textures.join('\n')+'\n',bindings:records};
}
export const pixelLuaReference=async()=>readFile(helper,'utf8');
