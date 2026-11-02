import {access,readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {spawnForJob,throwIfJobCancelled} from './jobExecution';
import {creativeHash} from './creativeWorkspace';
import {writeDefoldProject} from './defoldProject';
import type {CreativeProject,CreativeBuild} from '../shared/creativeProject';
export async function defoldEnvironment(){
 const directory=path.join(process.env.QINGJIAN_ENGINE_CACHE||path.join(homedir(),'.cache/qingjian-engines'),'defold/1.14.0');
 let stored:any;try{stored=JSON.parse(await readFile(path.join(directory,'runtime.json'),'utf8'));}catch{}
 const worker=process.env.QINGJIAN_DEFOLD_WORKER;
 const java=process.env.QINGJIAN_JAVA_PATH||stored?.java||(worker?'java':undefined),bob=process.env.QINGJIAN_DEFOLD_BOB||stored?.bob;
 const configured=Boolean(java&&bob&&await Promise.all([worker?access(worker):access(java),access(bob)]).then(()=>true,()=>false));
 const isolated=process.platform==='darwin'||Boolean(process.env.QINGJIAN_DEFOLD_WORKER);
 return {configured,isolated,java,bob,directory,version:'1.14.0',available:configured&&isolated,setup:'node tooling/creative/defold-runtime.mjs install；Linux配置QINGJIAN_DEFOLD_WORKER为受限构建容器启动器。'};
}
export function defoldMacProfile(project:string,runtime:string){project=realpathSync(project);runtime=realpathSync(runtime);const q=JSON.stringify;return `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)(allow ipc-posix-shm*)(allow file-read*)(deny file-read-data (subpath ${q(homedir())}) (subpath "/private/tmp") (subpath "/private/var/folders"))(allow file-read-data (subpath ${q(runtime)}) (subpath ${q(project)}))(allow file-write* (subpath ${q(project)}) (literal "/dev/null"))`;}
async function disablePersistence(index:string){const html=await readFile(index,'utf8');if(!html.includes('QJ_OPAQUE_PREVIEW'))await writeFile(index,html.replace("<script id='engine-setup' type='text/javascript'>","<script id='engine-setup' type='text/javascript'>\n// QJ_OPAQUE_PREVIEW: ephemeral browser storage only.\nModule.persistentStorage=false;"));}
export async function buildDefold(project:CreativeProject,directory:string):Promise<CreativeBuild>{
 throwIfJobCancelled();const environment=await defoldEnvironment();if(!environment.available)throw Error('Defold构建环境未就绪：'+environment.setup);
 const hash=creativeHash(project),root=path.resolve(directory,hash),source=path.join(root,'source'),output=path.join(root,'web');
 try{const existing=JSON.parse(await readFile(path.join(root,'build.json'),'utf8'));await access(path.join(existing.directory,existing.entry));await disablePersistence(path.join(existing.directory,existing.entry));return existing;}catch{}
 await Promise.all([mkdir(source,{recursive:true}),mkdir(output,{recursive:true}),mkdir(path.join(source,'.tmp'),{recursive:true}),mkdir(path.join(source,'.home'),{recursive:true})]);await writeDefoldProject(project,source);
 const args=['-Xmx512m','-XX:ActiveProcessorCount=2','-Djava.io.tmpdir='+path.join(source,'.tmp'),'-Duser.home='+path.join(source,'.home'),'-jar',environment.bob!,'--root',source,'--platform','wasm-web','--architectures','wasm-web','--variant','debug','--archive','--bundle-output',output,'build','bundle'];
 const command=process.platform==='darwin'?'/usr/bin/sandbox-exec':process.env.QINGJIAN_DEFOLD_WORKER!;
 const commandArgs=process.platform==='darwin'?['-p',defoldMacProfile(root,environment.directory),environment.java!,...args]:[environment.java!,...args];
 let logs='';await new Promise<void>((resolve,reject)=>{const child=spawnForJob(command,commandArgs,{cwd:source,env:{QINGJIAN_DEFOLD_WORKER_IMAGE:process.env.QINGJIAN_DEFOLD_WORKER_IMAGE,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',TMPDIR:path.join(source,'.tmp')},stdio:['ignore','pipe','pipe']});let overflow=false;const add=(b:Buffer)=>{logs+=b.toString();if(logs.length>1500000){overflow=true;child.kill('SIGKILL');}};child.stdout!.on('data',add);child.stderr!.on('data',add);const timer=setTimeout(()=>child.kill('SIGKILL'),180000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',(code,signal)=>{clearTimeout(timer);if(code===0&&!overflow)resolve();else reject(Error((overflow?'构建日志超过限制。\n':`Defold构建失败（${signal||code}）：\n`)+logs.slice(-16000)));});});
 const find=async(dir:string,depth=0):Promise<string|undefined>=>{if(depth>4)return;for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isFile()&&entry.name==='index.html')return path.join(dir,entry.name);if(entry.isDirectory()){const f=await find(path.join(dir,entry.name),depth+1);if(f)return f;}}};
 const index=await find(output);if(!index)throw Error('Defold没有生成HTML5入口。');
 await disablePersistence(index);
 const result:CreativeBuild={projectHash:hash,engine:'defold',engineVersion:environment.version,directory:path.dirname(index),entry:path.basename(index),logs:logs.replaceAll(root,'[build]').replaceAll(environment.directory,'[engine]').slice(-20000),builtAt:new Date().toISOString()};await writeFile(path.join(root,'build.json'),JSON.stringify(result,null,2));return result;
}
