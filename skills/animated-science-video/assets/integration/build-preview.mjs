import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildCanvasModules} from './module-builder.mjs';
import {buildScienceDocument} from './project-builder.mjs';
export async function buildPreview(directory=process.cwd()){
 const config=JSON.parse(await readFile(path.join(directory,'config.json'),'utf8'));
 if(config.program?.files){
  const files=await Promise.all(config.program.files.map(async f=>{const target=path.resolve(directory,'source',f.path);if(!target.startsWith(path.resolve(directory,'source')+path.sep))throw Error('Invalid source path');return {path:f.path,content:await readFile(target,'utf8')};}));
  const ts=(await import('typescript')).default;config.program.files=files;config.program.source=buildCanvasModules({files,entry:config.program.entry||'scene.authored.js',nodes:config.program.nodes||[]},ts);await writeFile(path.join(directory,'scene.authored.js'),config.program.source);
 }else if(config.program)config.program.source=await readFile(path.join(directory,'scene.authored.js'),'utf8');
 if(config.program?.selfCheck){const receipt=config.program.selfCheck;delete config.program.selfCheck;const hash=createHash('sha256').update(JSON.stringify(config)).digest('hex');if(hash===receipt.sceneHash)config.program.selfCheck=receipt;}
 await writeFile(path.join(directory,'config.json'),JSON.stringify(config,null,2));
 const names=['renderer','scene','motion-api','reference-effects','motion-metrics'];
 const contents=await Promise.all(names.map(name=>readFile(path.join(directory,name+'.mjs'),'utf8')));
 const parts=Object.fromEntries(['renderer','scene','motion','reference','metrics'].map((key,i)=>[key,contents[i]]));
 const html=buildScienceDocument(parts,config);await writeFile(path.join(directory,'index.html'),html);return {html,config};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildPreview();
