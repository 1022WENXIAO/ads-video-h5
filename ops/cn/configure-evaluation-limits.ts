import {createHash,randomUUID} from 'node:crypto';
import {chmod,chown,mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {validateReleaseEvaluationSettings} from '../../server/releaseEvaluations';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** Offline configuration only. The activation caller holds the deployment
 * lock and stops the service before this atomic settings write. Historical
 * attempts, their frozen deadlines and every acceptance result are immutable. */
export async function configureEvaluationCaseLimit(file:string,seconds:number,backupDirectory:string){
  if(!Number.isInteger(seconds)||seconds<60||seconds>3600)throw new Error('单例验收时限必须为60–3600秒。');
  const original=await readFile(file),metadata=await stat(file),state=JSON.parse(original.toString());
  if(state.version!==1||!Array.isArray(state.releases)||!state.settings)throw new Error('发布验收配置结构无效，保留原件。');
  const settings={...state.settings,maxCaseSeconds:seconds};validateReleaseEvaluationSettings(settings);
  if(state.settings.maxCaseSeconds===seconds)return{changed:false,maxCaseSeconds:seconds};
  const next={...state,settings},recordsHash=hash(JSON.stringify(state.releases));
  await mkdir(backupDirectory,{recursive:true,mode:0o700});
  const backup=path.join(backupDirectory,'release-evaluation-before-'+Date.now()+'-'+randomUUID()+'.json');
  await writeFile(backup,original,{mode:0o600,flag:'wx'});
  const temporary=file+'.settings-'+randomUUID();
  await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});
  await chown(temporary,metadata.uid,metadata.gid);await chmod(temporary,0o600);
  if(hash(await readFile(file))!==hash(original))throw new Error('配置被其他写入改变，未覆盖；备份与临时文件保留。');
  await rename(temporary,file);
  const actual=JSON.parse(await readFile(file,'utf8'));
  if(hash(JSON.stringify(actual.releases))!==recordsHash)throw new Error('历史验收记录校验失败，备份保留。');
  return{changed:true,before:state.settings.maxCaseSeconds,maxCaseSeconds:seconds,maxSuiteSeconds:settings.maxSuiteSeconds,backup,backupSha256:hash(original),recordsSha256:recordsHash};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.getuid?.()!==0)throw new Error('仅允许服务器管理员在受控部署中配置。');
  const active=execFileSync('systemctl',['show','qingjian-cn.service','-p','ActiveState','--value'],{encoding:'utf8'}).trim();
  if(active!=='inactive')throw new Error('必须先停止轻剪服务，避免覆盖正在写入的验收记录。');
  console.log(JSON.stringify(await configureEvaluationCaseLimit('/data/qingjian/evaluations/releases.json',Number(process.argv[2]),'/opt/qingjian-cn/operator-evidence/evaluation-settings-backups')));
}
