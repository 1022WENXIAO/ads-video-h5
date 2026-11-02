// Trusted compiler only; authored modules are never imported or executed by Node.
export function buildCanvasModules(project,ts){
 const files=project.files.filter(f=>/\.[jt]s$/.test(f.path));
 if(files.length===1&&project.entry.endsWith('.js')&&!project.nodes.some(n=>n.enabled))return files[0].content;
 const normalize=s=>{const parts=[];for(const p of s.split('/')){if(p==='..'){if(!parts.length)throw Error('Module escapes project');parts.pop();}else if(p&&p!=='.')parts.push(p);}return parts.join('/');};
 const compiled={};
 for(const f of files){let source=f.content;if(f.path===project.entry)source+='\n;if(typeof createScene==="function")exports.createScene=createScene;';
  let output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},fileName:f.path}).outputText;
  output=output.replace(/require\(["']([^"']+)["']\)/g,(_all,ref)=>{if(!ref.startsWith('.'))throw Error('Only local imports are allowed: '+ref);const folder=f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')+1):'',target=normalize(folder+ref),resolved=[target,target+'.js',target+'.ts',target+'/index.js',target+'/index.ts'].find(p=>files.some(f=>f.path===p));if(!resolved)throw Error('Missing local module: '+ref);return `require(${JSON.stringify(resolved)})`;});compiled[f.path]=output;
 }
 const factories=Object.entries(compiled).map(([file,body])=>JSON.stringify(file)+':function(exports,require){\n'+body+'\n}').join(',\n'),nodes=project.nodes.filter(n=>n.enabled).map(n=>n.file);
 return `function createScene(api){const factories={${factories}},cache={};function require(id){if(cache[id])return cache[id];if(!factories[id])throw Error('Unknown local module: '+id);const exports={};cache[id]=exports;factories[id](exports,require);return exports;}const base=require(${JSON.stringify(project.entry)}).createScene(api);const nodes=${JSON.stringify(nodes)}.map(file=>require(file).createNode(api));return {...base,paintPanel(ui,...args){base.paintPanel(ui,...args);for(const node of nodes){const transform=node.sample?.(args[4],args[3])||{};ui.layer(transform,()=>node.paint(ui,...args));}},checkModels(cfg){return [...base.checkModels(cfg),...nodes.flatMap(n=>n.checkModels?.(cfg)||[])];}};}`;
}
