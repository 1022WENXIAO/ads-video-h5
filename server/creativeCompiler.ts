import ts from 'typescript';
import {buildCanvasModules} from '../skills/animated-science-video/assets/integration/module-builder.mjs';
import type {CreativeDiagnostic,CreativeProject} from '../shared/creativeProject';
import {checkCreativeProject} from './creativeWorkspace';
export function creativeScriptDiagnostics(project:CreativeProject):CreativeDiagnostic[]{
 const base='/qingjian-project/',files=new Map(project.files.filter(f=>/\.[jt]s$/.test(f.path)).map(f=>[base+f.path,f.content]));
 const options:ts.CompilerOptions={allowJs:true,checkJs:true,noEmit:true,strict:false,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts']};
 const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host);host.readFile=f=>files.get(f)??read(f);host.fileExists=f=>files.has(f)||exists(f);host.directoryExists=d=>d.startsWith(base.slice(0,-1))||ts.sys.directoryExists(d);
 host.getSourceFile=(f,lang)=>{const text=host.readFile(f);return text===undefined?undefined:ts.createSourceFile(f,text,lang,true);};
 const program=ts.createProgram([...files.keys()],options,host);
 return ts.getPreEmitDiagnostics(program).filter(d=>d.file?.fileName.startsWith(base)).slice(0,40).map(d=>({file:d.file!.fileName.slice(base.length),line:d.file!.getLineAndCharacterOfPosition(d.start||0).line+1,message:ts.flattenDiagnosticMessageText(d.messageText,' '),severity:'error'}));
}
export function compileCanvasProject(project:CreativeProject):string{
 checkCreativeProject(project);if(project.kind==='defold')throw new Error('Defold工程由原生构建器编译。');return buildCanvasModules(project,ts);
}
