import CreativeGamePreview from '../../../src/CreativeGamePreview';
import { useCallback, useEffect, useState } from 'react';
import { Download, Layers3, Play, Square } from 'lucide-react';
import type { AdminVideoTemplate, TemplateTestRun } from '../../../shared/videoTemplates';
import { api,apiPath } from './api';
import { WorkflowTrace } from '../../../src/WorkflowTrace';
import './templates.css';

const active=(r:TemplateTestRun)=>['queued','running','stopping'].includes(r.status);
const statusName:Record<TemplateTestRun['status'],string>={queued:'排队中',running:'制作中',stopping:'停止中',cancelled:'已停止',succeeded:'制作完成',failed:'失败'};
function TestVideo({token,run}:{token:string;run:TemplateTestRun}) {
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='';
    void fetchAsset(token,run.id,'video',controller.signal).then(blob=>{if(!controller.signal.aborted){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'预览加载失败。');});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[token,run.id]);
  return error?<p role="alert">{error}</p>:url?<video src={url} controls loop playsInline preload="metadata" aria-label="模板测试成片"/>:<p>正在加载成片…</p>;
}
async function fetchAsset(token:string,id:string,kind:string,signal?:AbortSignal) {
  const {apiPath}=await import('./api');
  const response=await fetch(apiPath(`/api/admin/template-tests/${encodeURIComponent(id)}/assets/${kind}`),{headers:{Authorization:`Bearer ${token}`},signal});
  if(!response.ok)throw new Error('测试文件读取失败，请刷新登录或稍后重试。');
  return response.blob();
}
export default function TemplateAdmin({token,models}:{token:string;models:Array<{id:string;name:string;kind:string;enabled:boolean;hasApiKey:boolean}>}) {
  const [templates,setTemplates]=useState<AdminVideoTemplate[]>([]),[runs,setRuns]=useState<TemplateTestRun[]>([]);
  const [modelId,setModelId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState('');
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const result=await api<{runs:TemplateTestRun[]}>('/api/admin/template-tests',token,{signal});setRuns(result.runs);
  },[token]);
  useEffect(()=>{const c=new AbortController();void Promise.all([api<{templates:AdminVideoTemplate[]}>('/api/admin/templates',token,{signal:c.signal}),refresh(c.signal)]).then(([data])=>setTemplates(data.templates)).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[token,refresh]);
  const running=runs.some(active);
  useEffect(()=>{
    if(!running)return;const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{try{await refresh(c.signal);}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'测试状态读取失败。');}finally{if(!c.signal.aborted)timer=setTimeout(()=>void tick(),1500);}};
    timer=setTimeout(()=>void tick(),1500);return()=>{c.abort();clearTimeout(timer);};
  },[running,refresh]);
  async function start(t:AdminVideoTemplate,caseId:string){
    setBusy(true);setError('');
    try{const {run}=await api<{run:TemplateTestRun}>(`/api/admin/templates/${t.id}/tests/${caseId}/run`,token,{method:'POST',body:JSON.stringify(modelId?{modelId}:{})});setRuns(v=>[run,...v]);setSelected(run.id);}
    catch(e){setError(e instanceof Error?e.message:'启动失败。');}finally{setBusy(false);}
  }
  async function stop(run:TemplateTestRun){setBusy(true);setError('');try{await api(`/api/admin/template-tests/${run.id}/stop`,token,{method:'POST'});await refresh();}catch(e){setError(e instanceof Error?e.message:'停止失败。');}finally{setBusy(false);}}
  async function download(run:TemplateTestRun,kind:string,name:string){setError('');try{const blob=await fetchAsset(token,run.id,kind),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(e instanceof Error?e.message:'下载失败。');}}
  const current=runs.find(r=>r.id===selected)||runs[0];
  return <section className="template-admin">
    <div className="admin-heading"><div><h1>视频模板</h1><p>在对话中 @ 模板，按照制作规则生成视频或交互游戏。</p></div><Layers3 size={28}/></div>
    {error?<div className="admin-alert" role="alert">{error}</div>:null}
    <div className="template-admin-grid"><div className="template-catalog">{templates.map(t=><article className="template-admin-card" key={t.id}>
      <div className="template-card-heading"><Layers3 size={21}/><h2>{t.name}</h2><small>v{t.version}</small></div><p>{t.description}</p>
      <div className="template-facts"><span>{t.defaults.width} × {t.defaults.height}</span><span>{t.defaults.fps} fps</span>{t.output==='game'?<span>游戏场景 · 动画节点</span>:<><span>{t.defaults.panels}图同屏</span><span>无口播 · 循环配乐</span></>}</div>
      <details><summary>查看 Skill 制作规则</summary><pre>{t.instructions}</pre><small>规则版本 {t.skillHash.slice(0,12)}</small></details>
      <div className="template-test-case"><h3>预置测试</h3><label>测试模型<select aria-label="模板测试模型" value={modelId} onChange={e=>setModelId(e.target.value)} disabled={busy||running}><option value="">当前默认文本模型</option>{models.filter(m=>m.kind==='text'&&m.enabled&&m.hasApiKey).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      {t.testCases.map(test=><div key={test.id}><strong>{test.name}</strong><blockquote>{test.prompt}</blockquote><button className="admin-primary" disabled={busy||running} onClick={()=>void start(t,test.id)}><Play size={15}/>{running?'测试正在运行':'一键运行测试'}</button></div>)}
      <small>运行完整制作流程，将调用已配置的模型；生成结果仅管理员可见。</small></div>
    </article>)}{!templates.length?<p>正在加载模板…</p>:null}<p className="template-coming">更多模板正在制作中</p></div>
    <div className="template-test-results"><h2>测试运行记录</h2>{!runs.length?<div className="template-run-empty">运行预置案例后，可在这里查看制作进度、成片与工程。</div>:<>
      <select aria-label="选择模板测试记录" value={current?.id||''} onChange={e=>setSelected(e.target.value)}>{runs.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('zh-CN')} · {statusName[r.status]}</option>)}</select>
      {current?<article className="template-run"><div className="template-run-heading"><strong>{statusName[current.status]}</strong>{active(current)?<button disabled={busy||current.status==='stopping'} onClick={()=>void stop(current)}><Square size={13}/>停止</button>:null}</div><p>{current.prompt}</p><small>{current.stage||'等待处理'} · {current.progress||0}%</small><progress max="100" value={current.progress||0}/>{current.error?<p className="admin-alert" role="alert">{current.error}</p>:null}
        {current.artifact?<>{current.artifact.kind==='game'?<CreativeGamePreview endpoint={apiPath(`/api/admin/template-tests/${current.id}/assets/preview`)} token={token}/>:<TestVideo key={current.id} token={token} run={current}/>}<p>{current.artifact.technicalPassed?'技术检查通过 · 待人工审阅':'待技术检查'}</p>{current.artifact.motion?<p>连续帧动效：平均变化面积 {current.artifact.motion.meanChangedAreaPct.toFixed(2)}% · 活动帧 {current.artifact.motion.activeFramePct.toFixed(1)}% · {current.artifact.animationMode==='code'?'可编程场景，源码已打包':'基础场景'}</p>:null}<div className="template-downloads">{[...(current.artifact.kind==='game'?[]:[['video','成片.mp4','成片']]),['cover',current.artifact.kind==='game'?'封面.jpg':'封面.png','封面'],['project','可编辑工程.zip','工程'],['report','检查记录.json','记录']].map(([kind,name,label])=><button key={kind} onClick={()=>void download(current,kind,name)}><Download size={13}/>{label}</button>)}</div></>:null}
        {current.workflow?.length?<WorkflowTrace events={current.workflow}/>:null}
      </article>:null}</>}
    </div></div>
  </section>;
}
