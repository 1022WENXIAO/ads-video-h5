import type {ScienceScene} from '../shared/scienceScene';
import type {CreativeProject} from '../shared/creativeProject';
import {compileCanvasProject} from './creativeCompiler';
export function scienceWorkspaceInput(scene:ScienceScene):Omit<CreativeProject,'revision'|'updatedAt'>{
 if(!scene.program)throw Error('需要可编程场景。');const {source,files,entry,nodes,selfCheck,...metaProgram}=scene.program;
 const meta={...scene,program:metaProgram};
 return {format:1,kind:'canvas',title:scene.title,entry:entry||'scene.authored.js',files:[...(files||[{path:'scene.authored.js',content:source}]),{path:'animation.meta.json',content:JSON.stringify(meta,null,2)}],nodes:nodes||[]};
}
export function scienceFromWorkspace(project:CreativeProject):ScienceScene{
 const meta=project.files.find(f=>f.path==='animation.meta.json');if(!meta)throw Error('动画元数据animation.meta.json不存在。');const config=JSON.parse(meta.content) as ScienceScene;
 const files=project.files.filter(f=>f.path!=='animation.meta.json');return {...config,program:{...config.program!,source:compileCanvasProject({...project,files}),files,entry:project.entry,nodes:project.nodes}};
}
