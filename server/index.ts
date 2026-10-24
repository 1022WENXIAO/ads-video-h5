import express, { type ErrorRequestHandler, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import {createJsonStateWriter} from './jsonStateWriter';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings, AppState, Artifact, ChatMessage, Job, JobKind, MediaItem, Session } from '../src/types';
import { answerForSessionWithPi, createImagePromptWithPi, createMusicQueryWithPi, createNarrationWithPi, createPlanWithPi, detectImage, detectShots, probeAudio, probeVideo, renderPlan as renderBasePlan, runFFmpeg } from './core';
import { writePresetBgm } from './bgm';
import { download24bitAudio, downloadPixabayAudio, getPixabayTrackDetail, MusicSourceError, musicSearchLinks, pixabayAudioUrl, search24bitMusic, searchPixabayMusic } from './music';
import { getDefaultTextModelId, getModelConfig, getTextFallbackConfigs, listPublicModels } from './modelRegistry';
import { generateAudio, generateImage, ProviderError } from './providers';
import { mountAdminRoutes } from './adminRoutes';
import { createAdminAuth } from './adminAuth';
import { mountFrontendRoutes } from './frontendRoutes';
import { createAuth, userOf, type PublicUser } from './auth';
import { createOssStorage, type AssetCategory } from './ossStorage';
import { createEffectStore, type EffectValues } from './htmlEffects';
import { classify, shouldUpdatePlan, excludesBgm, narrativeRequest } from './intents';
import { createAudioUnderstanding } from './audioUnderstanding';
import { recheckAuthorizedSource } from './sourceAsrAuthorization';
import { reviewRender as reviewBaseRender } from './renderReview';
import { artifactReviewRequestedAt } from './reviewTime';
import { renderReviewSummary, reviewNeedsContentRepair } from './reviewResults';
import { withReviewAssets } from './reviewAssets';
import { recordVoiceRejection, reportsVoiceMismatch } from './audioQuality';
import { planHash, recoverPublishedPlan } from './renderTimeline';
import { runEditorialWorkflow } from './editorialWorkflow';
import { runNarrativeWorkflow, voiceReferenceAuthorized } from './narrativeWorkflow';
import { inspectScene, verifySceneQuotes } from './sceneUnderstanding';
import { mapLimited } from './taskPool';
import { MAX_MEDIA_UPLOAD_BYTES } from '../src/uploadLimits';
import { uploadMediaType } from './nativeUpload';
import { updateReply, recordWorkflowReply } from './replies';
import { runLessonWorkflow } from './lessonWorkflow';
import { sessionSources } from './sourceSelection';
import { researchHotTopics } from './hotResearch';
import { wantsScheduleManagement } from './scheduleIntent';
import { jobDelay, JobCancelledError, throwIfJobCancelled, getJobTransportDiagnostics, jobErrorDiagnostics, withoutJobSignal } from './jobExecution';
import { beginJobAttempt, finishJobAttempt, jobFailureMessage, publicJob } from './jobAttempts';
import { executionFailure } from './executionErrors';
import { createJobRunner, restoreInterruptedJobs } from './jobRunner';
import { createEvaluations, evaluationFileHash, evaluationImplementation, EvaluationError } from './evaluations';
import { privateEvaluationStorage, isEvaluationOwner } from './evaluationIsolation';
import { withModelSnapshot, snapshotModels, type ModelSnapshot } from './modelContext';
import { mountAvatarRoutes } from './avatarRoutes';
import { excludesAvatar, generateAuthorSprite, planAuthorAvatar, usesAvatar } from './avatarWorkflow';
import { createToolTrace } from './toolTrace';
import { isActiveJob } from '../src/jobStatus';
import { planCreationRoute } from './creativeRequest';
import { mountVoiceInputRoutes } from './voiceInput';
import { createCredits, CreditError } from './credits';
import { withCreditUsage } from './creditUsage';
import { mountCreditRoutes, mountCreditAdminRoutes } from './creditRoutes';
import { createReleaseEvaluations } from './releaseEvaluations';
import { loadApplicationState } from './stateLoading';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.QINGJIAN_DATA_DIR ? path.resolve(process.env.QINGJIAN_DATA_DIR) : path.join(root, 'data');
const ossEnvFile = path.join(dataDir, 'oss.env');
if (existsSync(ossEnvFile)) process.loadEnvFile(ossEnvFile);
const resendEnvFile = path.join(dataDir, 'resend.env');
if (existsSync(resendEnvFile)) process.loadEnvFile(resendEnvFile);
const oss = privateEvaluationStorage(createOssStorage());
const mediaDir = path.join(dataDir, 'media');
const artifactDir = path.join(dataDir, 'artifacts');
const exportDir = path.join(dataDir, 'exports');
const tmpDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'app-state.json');
const port = Number(process.env.PORT || 8787);
const publicBase = `/${(process.env.PUBLIC_BASE_PATH || '').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
const publicUrl = (url: string) => `${publicBase}${url}`;
const assetUrl = (ownerId: string, category: AssetCategory, id: string, fallback: string) => oss?.publicUrl(ownerId, category, id) || publicUrl(fallback);
await Promise.all([mediaDir, artifactDir, exportDir, tmpDir].map((dir) => mkdir(dir, { recursive: true })));
const effects = createEffectStore(dataDir, oss);
await effects.init();
const audioUnderstanding = createAudioUnderstanding(dataDir);

interface StoredState {
  activeSessionId: string;
  sessions: Session[];
  media: MediaItem[];
  artifacts: Artifact[];
  jobs: Job[];
  settings: Omit<AppSettings, 'defaultModelId'>;
  artifactFiles: Record<string, string>;
  narrationBySession: Record<string, string>;
  bgmBySession: Record<string, string>;
  profiles: Record<string, { activeSessionId: string; settings: AppSettings }>;
}
const now = () => new Date().toISOString();
function newSession(modelId: string | null): Session {
  const timestamp = now();
  return { id: randomUUID(), title: '新会话', modelId, createdAt: timestamp, updatedAt: timestamp, messages: [], plan: null };
}
const firstSession = newSession(await getDefaultTextModelId());
const emptyState = (): StoredState => ({ activeSessionId: firstSession.id, sessions: [firstSession], media: [], artifacts: [], jobs: [], settings: { language: 'zh-CN', chatBackground: null }, artifactFiles: {}, narrationBySession: {}, bgmBySession: {}, profiles: {} });
let state: StoredState = await loadApplicationState(stateFile, emptyState);
function normalizePlanSummary(plan: NonNullable<Session['plan']>): NonNullable<Session['plan']> {
  const core = plan.summary.split(/[；;]/).filter((part) => !/(封面|cover|thumbnail|poster)/i.test(part)).join('；').replace(/[。.!！\s；;]+$/, '') || '已整理剪辑方案';
  const coverName = state.media.find((item) => item.id === plan.coverMediaId && item.kind === 'image')?.name;
  return { ...plan, summary: `${core}${coverName ? `；封面：${coverName}` : ''}。`.slice(0, 160) };
}
if (!Array.isArray(state.sessions) || !state.sessions.length) state.sessions = [firstSession];
state.narrationBySession ||= {};
state.bgmBySession ||= {};
state.profiles ||= {};
for (const session of state.sessions) if (session.plan) session.plan = normalizePlanSummary(session.plan);
// Published plans are immutable render evidence; display cleanup must not
// change their hashes when the service restarts.
for (const artifact of state.artifacts) if (artifact.plan) artifact.plan = recoverPublishedPlan(artifact.plan, artifact.planHash);
if (!state.sessions.some((session) => session.id === state.activeSessionId)) state.activeSessionId = state.sessions[0].id;
restoreInterruptedJobs(state.jobs, now());
const jobRunner = createJobRunner();
const evaluationJobModels = new Map<string, ModelSnapshot>();
const persistState=createJsonStateWriter(stateFile,()=>state);
function saveState(): Promise<void> { throwIfJobCancelled(); return persistState(); }
await saveState();
const owned = (item: { ownerId?: string }, ownerId: string) => item.ownerId === ownerId;
const getSession = (id: string, ownerId?: string) => state.sessions.find((session) => session.id === id && (!ownerId || owned(session, ownerId)));
async function profileOf(user: PublicUser) {
  let profile = state.profiles[user.id];
  if (!profile) {
    const defaultModelId = await getDefaultTextModelId();
    profile = state.profiles[user.id];
    if (!profile) {
      const session = { ...newSession(defaultModelId), ownerId: user.id };
      state.sessions.unshift(session);
      profile = { activeSessionId: session.id, settings: { defaultModelId, language: 'zh-CN', chatBackground: null } };
      state.profiles[user.id] = profile;
      await saveState();
    }
  }
  return profile;
}
const shortName = (name: string) => path.basename(name).replace(/[\u0000-\u001f/\\]/g, '').slice(0, 120) || '素材';
const extFor = (mime: string) => mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime === 'audio/mpeg' ? 'mp3' : mime === 'audio/wav' || mime === 'audio/x-wav' ? 'wav' : mime === 'audio/ogg' ? 'ogg' : 'bin';

async function publicState(user: PublicUser): Promise<AppState> {
  const [models, profile, wallet] = await Promise.all([listPublicModels(), profileOf(user), credits.snapshot(user.id)]);
  const textConfig = await getModelConfig('text', getSession(profile.activeSessionId, user.id)?.modelId);
  return { credits: wallet, activeSessionId: profile.activeSessionId, sessions: state.sessions.filter((item) => owned(item, user.id)), media: state.media.filter((item) => owned(item, user.id)).map((item) => ({ ...item, url: item.character ? publicUrl(item.url) : assetUrl(user.id, 'media', item.id, item.url), shots: item.shots?.map((shot, index) => ({ ...shot, thumbnailUrl: assetUrl(user.id, 'shots', `${item.id}-${index}`, shot.thumbnailUrl) })) })), artifacts: state.artifacts.filter((item) => owned(item, user.id)).map((item) => ({ ...item, url: assetUrl(user.id, item.kind === 'video' ? 'exports' : 'artifacts', item.id, item.url), downloadUrl: publicUrl(item.downloadUrl), ...(item.coverUrl ? { coverUrl: assetUrl(user.id, 'covers', item.id, item.coverUrl) } : {}) })), jobs: state.jobs.filter((item) => owned(item, user.id)).map(publicJob), settings: profile.settings, models, mode: textConfig ? 'pi' : 'unconfigured' };
}

function addReply(session: Session, job: Job, text: string, artifactId?: string) {
  return updateReply(session, job, text, 'final', 'final', artifactId);
}
async function addArtifact(session: Session, job: Job, kind: Artifact['kind'], name: string, bytes: Buffer, mimeType: string, text?: string, duration?: number): Promise<Artifact> {
  throwIfJobCancelled();
  const id = randomUUID();
  const filename = `${id}.${extFor(mimeType)}`;
  const artifactPath = path.join(artifactDir, filename);
  const mediaId = randomUUID();
  const mediaPath = path.join(mediaDir, mediaId);
  try {
    await writeFile(artifactPath, bytes, { mode: 0o600 });
    await copyFile(artifactPath, mediaPath);
    await oss?.put(session.ownerId!, 'artifacts', id, artifactPath, mimeType);
    await oss?.put(session.ownerId!, 'media', mediaId, mediaPath, mimeType);
    throwIfJobCancelled();
  } catch (error) {
    await Promise.all([rm(artifactPath, { force: true }), rm(mediaPath, { force: true })]);
    if (oss) await Promise.allSettled([oss.remove(session.ownerId!, 'artifacts', id), oss.remove(session.ownerId!, 'media', mediaId)]);
    throw error;
  }
  const version = state.artifacts.filter((item) => item.sessionId === session.id && item.kind === kind).length + 1;
  const artifact: Artifact = { id, ownerId: session.ownerId, sessionId: session.id, messageId: job.messageId, kind, name, url: `/api/artifacts/${id}`, downloadUrl: `/api/download/${id}`, createdAt: now(), version, ...(text ? { text } : {}), ...(duration ? { duration } : {}) };
  state.artifacts.push(artifact); state.artifactFiles[id] = filename;
  artifact.mediaId = mediaId;
  state.media.push({ id: mediaId, ownerId: session.ownerId, name, mimeType, kind, ...(duration ? { duration } : {}), url: `/api/media/${mediaId}`, createdAt: now(), origin: 'generated' });
  return artifact;
}
async function performJob(job: Job): Promise<void> {
  const session = getSession(job.sessionId);
  const message = session?.messages.find((item) => item.id === job.messageId);
  if (!session || !message || session.ownerId !== job.ownerId) throw new Error('会话或消息已不存在，无法处理此任务。');
  const media = state.media.filter((item) => item.ownerId === job.ownerId);
  const prompt = message.text;
  if(session.plan&&reportsVoiceMismatch(prompt)){recordVoiceRejection(session.plan,media,prompt);await saveState();}
  const history = session.messages.filter((item) => item.createdAt <= message.createdAt);
  const attached = (message.attachmentIds || []).map((id) => media.find((item) => item.id === id)).filter((item): item is MediaItem => Boolean(item));
  const sourceProgress = new Map<string, number>();
  const updateSourceProgress = (sourceId: string, value: number) => {
    sourceProgress.set(sourceId,value);
    const source=media.find(m=>m.id===sourceId);
    updateReply(session,job,value>=100?`「${source?.name||'素材'}」的音频分析已完成。`:`正在听取「${source?.name||'素材'}」，整理原话与时间码。`,'commentary',`audio-${sourceId}`);
    if(job.kind === 'understanding') {
      const items=selectedSources().filter((m)=>m.kind!=='image');
      job.progress=Math.round(items.reduce((sum,m)=>sum+(sourceProgress.get(m.id)??(m.analysis?100:0)),0)/Math.max(1,items.length));
      job.stage=`理解原声 · ${items.filter((m)=>(sourceProgress.get(m.id)||0)>=100||m.analysis).length}/${items.length} 段已完成`;
    } else job.progress=Math.max(job.progress||0,Math.min(35,5+Math.round(value*.25)));
  };
  const analyzeAudio = async (sourceId: string) => {
    const item = media.find((m) => m.id === sourceId && m.kind !== 'image');
    if (!item) throw new Error('音频理解素材不存在或无权限。');
    const file = path.join(mediaDir, item.id);
    await oss?.ensure(job.ownerId!, 'media', item.id, file);
    item.analysis = await audioUnderstanding.analyze(item, file, async (value) => { updateSourceProgress(item.id,value); await saveState(); });
    updateSourceProgress(item.id,100);
    item.hasAudio = item.analysis.status !== 'no-audio'; await saveState(); return item.analysis;
  };
  const recheckSource = async (sourceId:string,reason:Parameters<typeof recheckAuthorizedSource>[0]['reason']) => {
    throwIfJobCancelled();
    const source=media.find(item=>item.id===sourceId&&item.ownerId===job.ownerId&&item.kind!=='image');
    if(!job.ownerId||!source||!state.media.includes(source))throw new Error('原声复听素材不存在或无权限。');
    const file=path.join(mediaDir,source.id);
    await oss?.ensure(job.ownerId,'media',source.id,file);
    const checked=await recheckAuthorizedSource({ownerId:job.ownerId,sourceId,media:()=>state.media,file,reason,
      recheck:(item,input,why)=>audioUnderstanding.recheck(item,input,why,async value=>{updateSourceProgress(item.id,value);await saveState();})});
    throwIfJobCancelled();if(checked.item!==source||!state.media.includes(source))throw new Error('原声复听期间素材记录已变化，不能采用旧记录。');
    checked.assertCurrent();
    checked.item.analysis=checked.analysis;checked.item.hasAudio=true;
    updateSourceProgress(checked.item.id,100);await saveState();return checked.analysis;
  };
  const selectedSources = () => sessionSources(prompt,media,attached,session.plan,history);
  const workflowProgress = async (events:NonNullable<Job['workflow']>) => {
    throwIfJobCancelled();
    job.workflow=structuredClone([...(job.workflow||[]).filter(e=>!events.some(v=>v.callId&&v.callId===e.callId)),...events]);recordWorkflowReply(session,job,events);
    job.stage=[...events].reverse().find(e=>e.status==='running')?.stage||events.at(-1)?.stage;
    job.progress=Math.max(job.progress||0,Math.min(88,10+events.filter(e=>e.status==='succeeded').length*2));await saveState();
  };
  const basicProgress = workflowProgress;
  if(job.kind==='avatar') {
    const source=media.find(m=>m.id===job.avatarSourceId&&m.character?.role==='reference');
    if(!source)throw new Error('形象原图不存在。');
    const imageConfig=await getModelConfig('image');if(!imageConfig)throw new Error('图片模型尚未配置。');
    const compiled=await generateAuthorSprite(await readFile(path.join(mediaDir,source.id)),imageConfig,basicProgress);
    throwIfJobCancelled();const id=randomUUID(),file=path.join(mediaDir,id);
    try{await writeFile(file,compiled.bytes,{mode:0o600});throwIfJobCancelled();}
    catch(error){await rm(file,{force:true});throw error;}
    state.media.push({id,ownerId:job.ownerId,name:source.name+' · 动画',mimeType:'image/png',kind:'image',url:`/api/media/${id}`,createdAt:now(),origin:'generated',character:{role:'sprite',referenceMediaId:source.id,sprite:compiled.sprite}});
    addReply(session,job,`「${source.name}」的 8 帧透明动画已生成并保存到作者形象，默认 6 fps 循环。设为默认作者后，后续视频会使用这个动画。`);
    await saveState();return;
  }
  let avatarPlacement:NonNullable<Session['plan']>['avatars']|undefined;
  let avatarPlanned=false;
  const avatarModeAtStart=session.plan?.authorAvatarMode;
  const avatarTrace=createToolTrace(basicProgress);
  if(job.kind==='plan'&&session.plan&&(excludesAvatar(prompt)||usesAvatar(prompt))){
    const next=structuredClone(session.plan);
    const selected=attached.find(m=>m.character?.role==='sprite')||media.find(m=>m.id===job.authorAvatarId&&m.character?.role==='sprite');
    if(usesAvatar(prompt)&&!selected)throw new Error('请先在作者形象中设定默认动画。');
    const config=await getModelConfig('text',session.modelId);if(!config)throw new Error('作者形象编排需要文本模型。');
    await planAuthorAvatar(next,selected,media,prompt,config,basicProgress);
    next.version=(session.plan.version||0)+1;session.plan=next;
    addReply(session,job,excludesAvatar(prompt)?'已从当前方案移除作者形象，发送“生成成片”可导出。':'已在当前方案加入作者动画，发送“生成成片”可导出。');await saveState();return;
  }
  const reviewRender:typeof reviewBaseRender=(file,next,items,request,_providedPublisher,trustedRequestedAt=Date.parse(message.createdAt))=>withReviewAssets(oss,job.ownerId!,publish=>{
    const run=()=>reviewBaseRender(file,next,items,request,publish,trustedRequestedAt);
    return next.avatars?.length||job.kind==='review'
      ?avatarTrace.run(next.avatars?.length?'review_author_video':'review_existing_video',next.avatars?.length?'检查作者动画、画面与声音':'检查已有成片与声音',{planHash:planHash(next)},run)
      :run();
  });
  const renderPlan:typeof renderBasePlan=async(next,items,dir,out,narration,bgm)=>{
    if(job.kind!=='review'){
      next.authorAvatarMode ??= avatarModeAtStart;
      const selected=attached.find(m=>m.character?.role==='sprite')||media.find(m=>m.id===job.authorAvatarId&&m.character?.role==='sprite');
      if(usesAvatar(prompt)&&!selected)throw new Error('请先在作者形象中设定默认动画。');
      if(!avatarPlanned){
        const config=selected&&await getModelConfig('text',session.modelId);
        if(selected&&!config)throw new Error('作者形象编排需要文本模型。');
        if(config)await planAuthorAvatar(next,selected,media,prompt,config,basicProgress);
        else next.avatars=[];
        avatarPlacement=next.avatars;avatarPlanned=true;
      }
      next.avatars=avatarPlacement?.map(t=>({...t,end:next.targetSeconds}))||[];
      await saveState();
    }
    return next.avatars?.length
      ?avatarTrace.run('render_author_video','渲染作者动画与主视频',{planHash:planHash(next),avatars:next.avatars},()=>renderBasePlan(next,items,dir,out,narration,bgm))
      :renderBasePlan(next,items,dir,out,narration,bgm);
  };
  const prepareSpeech = async () => {
    if (/字幕|精剪|重复|去重|完整句|观点|口播|原声|论证|结论|精彩|钩子|subtitle|caption|fine.cut/i.test(prompt)) {
      for (const item of selectedSources().filter((m) => m.kind === 'video')) await analyzeAudio(item.id);
    }
  };
  if (job.kind === 'understanding') {
    const items = selectedSources().filter((m) => m.kind !== 'image');
    if (!items.length) throw new Error('请先添加或附加要转写的音频或视频素材。');
    const failures: string[]=[];
    const replies = await mapLimited(items,2,async (item) => {
      let result;
      try { result = await analyzeAudio(item.id); }
      catch(error) { const detail=`「${item.name}」${error instanceof Error ? error.message : '音频理解失败'}`;failures.push(detail);job.workflow=[...(job.workflow||[]),{tool:'analyze_audio',stage:`理解原声 ${item.name}`,status:'failed',at:now(),detail}];await saveState();return detail; }
      return `「${item.name}」${result.status === 'no-audio' ? '没有音轨，未调用模型。' : `已保存${result.sentences.length}句原话、${result.sentences.reduce((n,s) => n+s.words.length,0)}个字词时间码及${result.pauses.length}处低音量停顿。\n${result.transcript.slice(0, 1800)}`}`;
    });
    if(failures.length) throw new Error(`音频理解有${failures.length}段待重试，成功素材已保存。${failures.join('；')}`);
    updateReply(session,job,replies.join('\n\n'),'commentary','transcript-details');
    addReply(session,job,`已完成 ${items.length} 段素材的音频理解，逐字稿可在素材库查看和下载。时间码为模型估计。`); return;
  }
  if (job.kind === 'review') {
    const artifact = [...state.artifacts].reverse().find((a) => a.sessionId === session.id && a.kind === 'video' && a.plan);
    if (!artifact?.plan) throw new Error('请先生成成片再进行审查。');
    const file = path.join(exportDir, `${artifact.id}.mp4`); await oss?.ensure(job.ownerId!, 'exports', artifact.id, file);
    const originalRequest=session.messages.find((m)=>m.id===artifact.messageId)?.text||'';
    const requestedAt=artifactReviewRequestedAt(artifact,session.messages);
    artifact.requestedAt??=new Date(requestedAt).toISOString();
    recordVoiceRejection(artifact.plan,media,prompt);await saveState();
    artifact.review = await reviewRender(file, artifact.plan, media, originalRequest+'\n本次补充审查：'+prompt,undefined,requestedAt);
    const issues=artifact.review.checks.filter(c=>!c.passed);
    if(issues.length)updateReply(session,job,issues.map(c=>`${c.name}：${c.detail}`).join('\n\n'),'commentary','review-details');
    addReply(session, job, `${renderReviewSummary(artifact.review)}。成片可继续预览、下载，详细结果见处理过程与作品审查。`, artifact.id); return;
  }

  if (job.kind === 'effect') {
    const available = effects.list().filter((item) => item.enabled);
    const effect = available.find((item) => prompt.includes(item.name)) || available.find((item) => /SOP|步骤|流程推进/i.test(prompt) && item.id === 'sop-flow') || available.find((item) => /因果|返工|人力消耗/.test(prompt) && item.id === 'cause-chain') || available.find((item) => /趋势|增长|柱状/.test(prompt) && item.id === 'data-growth') || available.find((item) => /成果|产出/.test(prompt) && item.id === 'result-reveal') || available.find((item) => /照片|图片|推镜/.test(prompt) && item.id === 'photo-drift') || available.find((item) => /结尾|收束|字幕/.test(prompt) && item.id === 'story-outro') || available[0];
    if (!effect) throw new Error('特效库暂无可用模板，请联系管理员启用。');
    const title = /(?:标题|文案)[：:]?\s*[“「\"]([^”」\"]{1,60})[”」\"]/.exec(prompt)?.[1] || /[“「\"]([^”」\"]{1,60})[”」\"]/.exec(prompt)?.[1];
    const subtitle = /(?:副标题|说明)[：:]?\s*[“「\"]([^”」\"]{1,120})[”」\"]/.exec(prompt)?.[1];
    const visual = attached.find((item) => !item.character && (item.kind === 'image' || item.kind === 'video'));
    const values: Partial<EffectValues> = { ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}) };
    updateReply(session,job,`已选择「${effect.name}」，正在制作 HTML 动效画面。`,'commentary','effect-design');await saveState();
    if (visual) await oss?.ensure(job.ownerId!, 'media', visual.id, path.join(mediaDir, visual.id));
    const render = await effects.render(effect, values, visual ? { file: path.join(mediaDir, visual.id), kind: visual.kind as 'image' | 'video', mimeType: visual.mimeType } : undefined);
    job.progress = 15; await saveState();
    while (render.status === 'queued' || render.status === 'running') {
      await jobDelay(500);
      job.progress = Math.min(90, (job.progress || 15) + 1);
    }
    if (render.status !== 'succeeded' || !render.file) throw new Error(render.error || '特效渲染失败。');
    updateReply(session,job,'HTML 动效已渲染，正在保存视频和预览文件。','commentary','effect-save');await saveState();
    let id: string = randomUUID(); const mediaId = randomUUID();
    const mediaFile = path.join(mediaDir, mediaId);
    const raw:MediaItem={id:mediaId,ownerId:job.ownerId,name:effect.name+' · HTML 画面',mimeType:'video/mp4',kind:'video',duration:effect.duration,url:`/api/media/${mediaId}`,createdAt:now(),origin:'generated'};
    const effectPlan:NonNullable<Session['plan']>={format:effect.width===effect.height?'1:1':effect.width>effect.height?'16:9':'9:16',targetSeconds:effect.duration,summary:effect.name,clips:[{sourceId:mediaId,start:0,end:effect.duration}]};
    let destination=path.join(exportDir,`${id}.mp4`),effectReview:Artifact['review'];
    const withAuthor=Boolean(job.authorAvatarId||attached.some(m=>m.character?.role==='sprite'));
    try {
      await copyFile(render.file,mediaFile);
      if(withAuthor){
        const available=[...media,raw],result=await renderPlan(effectPlan,available,mediaDir,exportDir);
        id=result.id;destination=result.file;
        effectReview=await reviewRender(destination,effectPlan,available,prompt);
        session.plan=effectPlan;
      }else await copyFile(render.file,destination);
      await oss?.put(job.ownerId!, 'exports', id, destination, 'video/mp4');
      await oss?.put(job.ownerId!, 'media', mediaId, mediaFile, 'video/mp4');
      throwIfJobCancelled();
    } catch (error) {
      await Promise.all([rm(destination, { force: true }), rm(mediaFile, { force: true })]);
      if (oss) await Promise.allSettled([oss.remove(job.ownerId!, 'exports', id), oss.remove(job.ownerId!, 'media', mediaId)]);
      throw error;
    }
    const version = state.artifacts.filter((item) => item.sessionId === session.id && item.kind === 'video').length + 1;
    state.artifacts.push({ id, ownerId: job.ownerId, sessionId: session.id, messageId: message.id, kind: 'video', name: `${effect.name}-v${version}.mp4`, url: `/api/artifacts/${id}`, downloadUrl: `/api/download/${id}`, createdAt: now(), version, duration: effect.duration, format:effectPlan.format, mediaId,...(withAuthor?{plan:structuredClone(effectPlan),planHash:planHash(effectPlan),review:effectReview,workflow:structuredClone(job.workflow)}:{}) });
    state.media.push(raw);
    job.artifactId = id;
    addReply(session, job, `已用「${effect.name}」生成 ${effect.duration} 秒 HTML 动效视频，可预览、下载，也已加入素材库用于后续剪辑。`, id);
    return;
  }
  if (job.kind === 'music') {
    if (/https:\/\/cdn\.pixabay\.com\//i.test(prompt)) {
      const url = pixabayAudioUrl(prompt);
      if (!url) throw new Error('请提供 Pixabay 官方 CDN 的 MP3 下载地址。');
      const downloaded = await downloadPixabayAudio(url);
      job.progress = 55; await saveState();
      const id = randomUUID();
      const file = path.join(mediaDir, id);
      try {
        await writeFile(file, downloaded.bytes, { mode: 0o600 });
        const duration = await probeAudio(file);
        await oss?.put(job.ownerId!, 'media', id, file, 'audio/mpeg');
        state.media.push({ id, ownerId: job.ownerId, name: downloaded.name, mimeType: 'audio/mpeg', kind: 'audio', duration, url: `/api/media/${id}`, createdAt: now(), origin: 'imported', sourceUrl: url.toString() });
        state.bgmBySession[session.id] = id;
      } catch (error) { await rm(file, { force: true }); throw error; }
      addReply(session, job, `已下载并导入「${downloaded.name}」，试听请到素材库；这首音乐已作为当前对话的 BGM。发送“生成成片”即可混音导出。发布前请核对 Pixabay 许可与曲目限制。`);
      return;
    }
    const textConfig = await getModelConfig('text', session.modelId);
    if (!textConfig) throw new Error('文本模型尚未配置，请在管理后台设置 API Key 后重试。');
    const query = await createMusicQueryWithPi(prompt, textConfig, history);
    const result = musicSearchLinks(query);
    addReply(session, job, `已整理 BGM 搜索词「${result.query}」。在下方打开原站试听和下载；下载后添加音频素材，并说“把这段音频作为 BGM”。24bit 曲目的使用权需逐首确认。`);
    const reply = session.messages.find((item) => item.role === 'assistant' && item.jobId === job.id);
    if (reply) reply.musicSearch = result;
    return;
  }
  const creationRoute=(job.kind==='plan'||job.kind==='export')?await planCreationRoute({prompt,history,sourceCount:selectedSources().filter(m=>m.kind!=='audio').length,hasPlan:Boolean(session.plan),lesson:session.lessonDraft||session.plan?.lesson,kind:job.kind},async()=>{
    const config=await getModelConfig('text',session.modelId);if(!config)throw new Error('文本模型尚未配置。');return config;
  },basicProgress):undefined;
  if(creationRoute&&creationRoute.mode!=='editing')job.kind=creationRoute.export?'export':'plan';
  if(creationRoute?.mode==='conversation'){
    if(creationRoute.clarification){addReply(session,job,creationRoute.clarification);return;}
    const config=await getModelConfig('text',session.modelId);if(!config)throw new Error('文本模型尚未配置。');
    addReply(session,job,await answerForSessionWithPi({prompt,config,media,history,plan:session.plan,attached,progress:basicProgress,onSection:async(id,text)=>{updateReply(session,job,text,'commentary',id);await saveState();}}));return;
  }
  if(creationRoute?.requiresFootage&&!selectedSources().some(m=>m.kind==='video'||m.kind==='image'))throw new Error('本次要求保留原片、真人或原话，但尚未选定源素材。请添加要剪辑的原片；如果要从零制作主题图解，请说明可自行设计画面。');
  if(creationRoute?.mode==='research'){
    const config=await getModelConfig('text',session.modelId);if(!config)throw new Error('文本模型尚未配置。');
    const result=await researchHotTopics(config,prompt,workflowProgress);
    const directory=path.join(dataDir,'hot-research');await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,job.id+'.json'),JSON.stringify(result,null,2),{mode:0o600});
    const brief=result.current!;
    addReply(session,job,brief.topics.length?`已查证 ${brief.topics.length} 个可制作选题，新闻窗口为近 ${brief.windowHours} 小时。展开选题可看钩子、图解建议与原文依据；指定标题并说“制作热点视频”即可继续。`:'本次没有找到时效与交叉来源同时满足的选题。已保留实际榜单与来源缺口，暂不能据此制作今日热点视频。');
    const reply=session.messages.find(m=>m.role==='assistant'&&m.jobId===job.id);if(reply)reply.research={brief,references:result.references};return;
  }
  if(job.kind==='export'&&session.plan?.lesson&&!session.plan.lesson.hotResearch&&!shouldUpdatePlan(prompt,true)){
    const plan=structuredClone(session.plan),result=await renderPlan(plan,media,mediaDir,exportDir);
    const review=await reviewRender(result.file,plan,media,prompt+'，字幕和声音一致性检查');
    await oss?.put(job.ownerId!,'exports',result.id,result.file,'video/mp4');
    session.plan=plan;
    const version=state.artifacts.filter(a=>a.sessionId===session.id&&a.kind==='video').length+1;
    state.artifacts.push({id:result.id,ownerId:job.ownerId,sessionId:session.id,messageId:message.id,kind:'video',name:`轻剪教学视频-v${version}.mp4`,url:`/api/artifacts/${result.id}`,downloadUrl:`/api/download/${result.id}`,createdAt:now(),version,duration:plan.targetSeconds,format:plan.format,plan:structuredClone(plan),workflow:structuredClone(job.workflow||[]),review,planHash:planHash(plan),hasNarration:true,hasBgm:false});
    job.artifactId=result.id;
    addReply(session,job,`教学视频 v${version} 已重新导出：${plan.lesson!.title}，${plan.targetSeconds.toFixed(1)}秒。沿用当前已审查的图解与旁白，${renderReviewSummary(review)}。可预览、下载。`,result.id);return;
  }
  const lessonPrompt=creationRoute?.lessonPrompt;
  if(lessonPrompt&&(job.kind==='export'||job.kind==='plan')){
    const config=await getModelConfig('text',session.modelId);
    if(!config)throw new Error('文本模型尚未配置。');
    const workflow=await runLessonWorkflow({prompt:lessonPrompt,requestedAt:Date.parse(message.createdAt),config,audioConfig:await getModelConfig('audio'),media,dataDir,mediaDir,ownerId:job.ownerId!,checkpointKey:job.id,export:job.kind==='export',
      analyze:(item,file,options)=>audioUnderstanding.analyze(item,file,undefined,options),
      register:async item=>{throwIfJobCancelled();await oss?.put(job.ownerId!,'media',item.id,path.join(mediaDir,item.id),item.mimeType);throwIfJobCancelled();state.media.push(item);await saveState();},
      persist:async next=>{throwIfJobCancelled();session.plan=next;await saveState();},saveDraft:async next=>{throwIfJobCancelled();session.lessonDraft=structuredClone(next);await saveState();},progress:workflowProgress,stage:async stage=>{throwIfJobCancelled();job.stage=stage;await saveState();},
      render:(next,bgm)=>renderPlan(next,media,mediaDir,exportDir,undefined,bgm),review:(file,next)=>reviewRender(file,next,media,lessonPrompt+'，字幕和声音一致性检查',undefined,Date.parse(message.createdAt))});
    if(job.kind==='plan'){
      const r=workflow.report;
      addReply(session,job,`${r.hotResearch?'新闻脚本':'教学脚本'}已整理：${r.title}，${r.chapters.length}章，约${r.requestedSeconds}秒。事实审查${r.factReview?.score}/100。\n${r.chapters.map((c,i)=>`${i+1}. ${c.title}：${c.goal}`).join('\n')}\n发送“生成成片”即可制作。`);return;
    }
    const plan=workflow.plan!,result=workflow.rendered!,review=workflow.review!;
    await oss?.put(job.ownerId!,'exports',result.id,result.file,'video/mp4');
    const version=state.artifacts.filter(a=>a.sessionId===session.id&&a.kind==='video').length+1;
    state.artifacts.push({id:result.id,requestedAt:message.createdAt,ownerId:job.ownerId,sessionId:session.id,messageId:message.id,kind:'video',name:`轻剪${plan.lesson?.hotResearch?'新闻资讯':'教学'}视频-v${version}.mp4`,url:`/api/artifacts/${result.id}`,downloadUrl:`/api/download/${result.id}`,createdAt:now(),version,duration:plan.targetSeconds,format:plan.format,plan:structuredClone(plan),workflow:structuredClone(job.workflow||workflow.events),review,planHash:planHash(plan),hasNarration:true,hasBgm:Boolean(plan.lesson?.presentation?.bgm)});
    job.artifactId=result.id;
    addReply(session,job,`${plan.lesson?.hotResearch?'新闻资讯视频':'教学视频'} v${version} 已生成：${plan.lesson!.title}，${plan.clips.length}章，${plan.targetSeconds.toFixed(1)}秒。${plan.lesson?.hotResearch?'已核验近期报道，完成新闻图解、播报旁白'+(plan.lesson.presentation?.bgm?'与氛围配乐':''):'采用图解画面与统一旁白'}，${renderReviewSummary(review)}。可预览、下载，并展开${plan.lesson?.hotResearch?'新闻':'教学'}脚本和制作记录查看依据。`,result.id);return;
  }
  const coverIntent = /(?:用|把|将|设置|设为|作为|指定|采用|use|set|make).{0,24}(?:封面|cover|thumbnail|poster)|(?:封面|cover|thumbnail|poster).{0,24}(?:设为|作为|使用|用作|as|for)/i.test(prompt);
  const removeCover = /(?:不要|移除|去掉|取消|remove|without|clear).{0,12}(?:封面|cover|thumbnail|poster)/i.test(prompt);
  const withCover = (plan: Session['plan']): NonNullable<Session['plan']> => {
    if (!plan) throw new Error('剪辑方案不存在。');
    if (removeCover) return normalizePlanSummary({ ...plan, coverMediaId: undefined });
    if (!coverIntent) return normalizePlanSummary({ ...plan, coverMediaId: session.plan?.coverMediaId });
    const attachedImage = attached.find((item) => item.kind === 'image');
    const recentImage = [...state.artifacts].reverse().find((item) => item.sessionId === session.id && item.kind === 'image' && item.mediaId);
    const candidate = attachedImage || media.find((item) => item.id === recentImage?.mediaId) || [...media].reverse().find((item) => item.kind === 'image');
    if (!candidate) throw new Error('请先添加一张图片，再指定它作为封面。');
    return normalizePlanSummary({ ...plan, coverMediaId: candidate.id });
  };
  const removeNarration = /(不要|移除|去掉|关闭).{0,8}(口播|配音|旁白|音频)|(?:remove|mute|disable|without).{0,24}(?:narration|voiceover|voice-over|audio)/i.test(prompt);
  const bgmIntent = /(?:bgm|背景音乐|配乐|background music)/i.test(prompt);
  const preserveOriginal = /原声|原音|original audio|不要.{0,8}(?:配音|旁白)|不用.{0,8}(?:配音|旁白)/i.test(prompt);
  if (preserveOriginal) delete state.narrationBySession[session.id];
  const reconstructionPrompt = narrativeRequest(prompt, history, Boolean(session.plan?.reconstruction));
  const reconstruction = Boolean(reconstructionPrompt);
  const selectNarration = !reconstruction && !preserveOriginal && !bgmIntent && /(把|将|用|带|带上|含|包含|加上|加入|合入|配上).{0,12}(口播|配音|旁白|音频)|(?:口播|配音|旁白|音频).{0,12}(加入|合入|配上)|(?:add|include|mix|with).{0,24}(?:narration|voiceover|voice-over|audio)/i.test(prompt);
  const removeBgm = excludesBgm(prompt);
  if (removeBgm) delete state.bgmBySession[session.id];
  else if (bgmIntent) state.bgmBySession[session.id] = /(?:内置|默认|preset).{0,10}(?:bgm|背景音乐|配乐)|(?:bgm|背景音乐|配乐).{0,10}(?:内置|默认|preset)/i.test(prompt)
    ? 'preset' : attached.find((item) => item.kind === 'audio')?.id || state.bgmBySession[session.id] || 'preset';
  if (removeNarration) delete state.narrationBySession[session.id];
  if (selectNarration && !removeNarration && (job.kind === 'plan' || job.kind === 'export')) {
    const attachedAudio = attached.find((item) => item.kind === 'audio');
    const latestAudio = attachedAudio
      ? state.artifacts.find((item) => item.kind === 'audio' && item.mediaId === attachedAudio.id)
      : [...state.artifacts].reverse().find((item) => item.sessionId === session.id && item.kind === 'audio');
    if (!latestAudio) throw new Error('当前对话还没有口播音频，请先通过对话生成口播。');
    state.narrationBySession[session.id] = latestAudio.id;
  }
  if (job.kind === 'plan' && (removeNarration || selectNarration || bgmIntent) && !/(?:剪|分镜|片段|拼接|调整|时长|画幅|比例|排序|制作视频)/.test(prompt)) {
    addReply(session, job, bgmIntent ? (removeBgm ? '已从后续成片中移除背景音乐。' : `已为后续成片选择${state.bgmBySession[session.id] === 'preset' ? '内置轻快配乐' : '所选音频'}，发送“生成成片”即可导出。`) : removeNarration ? '已从后续成片中移除口播音轨。' : '已将现有口播加入成片方案，发送“生成成片”即可导出。');
    return;
  }
  if (job.kind === 'plan' && (coverIntent || removeCover) && !/(剪|片段|时长|画幅|比例|排序|调整|修改|拼接|trim|clip|duration|aspect|ratio|reorder|edit)/i.test(prompt)) {
    if (!session.plan) {
      addReply(session, job, '请先通过对话生成剪辑方案，再指定封面图片。');
      return;
    }
    session.plan = { ...withCover(session.plan), version: (session.plan?.version || 0) + 1 };
    addReply(session, job, removeCover ? '已从后续成片中移除封面。' : '已把所选图片设为当前方案的封面，发送“生成成片”即可导出。');
    return;
  }
  const useEditorial = /精剪|叙事|选句|分镜.*原话|程序化剪辑/.test(prompt) || Boolean(session.plan?.editorial);
  const editorialOptions = async () => {
    const config = await getModelConfig('text', session.modelId);
    if (!config) throw new Error('文本模型尚未配置。');
    const sources = selectedSources().filter((m) => m.kind === 'video');
    if (!sources.length) throw new Error('精剪需要视频素材。');
    return { prompt, config, sources, media, decorate: withCover, previous: session.plan, preserveSelection: Boolean(session.plan?.editorial && /保留当前(?:的)?(?:四段)?(?:分镜|片段)|只(?:修改|修复|调整)字幕/.test(prompt) && !/重新选句|更换|替换|改选/.test(prompt)), transcribe: analyzeAudio, recheckSource, verifySelection: (scenes: Parameters<typeof verifySceneQuotes>[0]) => verifySceneQuotes(scenes,sources,path.join(dataDir,'sentence-audit')), inspect: async (scene: Parameters<typeof inspectScene>[0]) => { await oss?.ensure(job.ownerId!, 'media', scene.sourceId, path.join(mediaDir, scene.sourceId)); return inspectScene(scene, mediaDir, path.join(dataDir, 'scene-understanding')); }, persist: async (plan: NonNullable<Session['plan']>) => { session.plan = plan; await saveState(); }, progress: basicProgress };
  };
  const narrativeOptions = async (exportVideo: boolean, bgmFile?: string): Promise<Parameters<typeof runNarrativeWorkflow>[0]> => {
    const config = await getModelConfig('text', session.modelId);
    if (!config) throw new Error('文本模型尚未配置。');
    // Reconstruct from the original inputs, never mistake generated scenes
    // from the previous revision for a person's recorded testimony.
    const sourceIds = session.plan?.reconstruction ? session.plan.reconstruction.sourceIds || [...new Set(session.plan.reconstruction.beats.flatMap(b => b.evidence ? [b.evidence.sourceId] : []))] : [];
    const sources = (attached.length ? attached : sourceIds.length ? media.filter(m => sourceIds.includes(m.id)) : selectedSources()).filter(m => m.kind === 'video' && !m.generation);
    if (!sources.length) throw new Error('重构知识短片需要真人视频素材。');
    return { prompt: reconstructionPrompt!, config, audioConfig: await getModelConfig('audio'), sources, media, previous: session.plan, mediaDir, dataDir, ownerId: job.ownerId!, export: exportVideo, checkpointKey: job.id,
      originalOnly: !/补充|联网|新增台词|重写台词/.test(reconstructionPrompt!) || /不(?:要)?(?:重新)?(?:生成|合成)配音|只用原话/.test(reconstructionPrompt!),
      voiceAuthorized: voiceReferenceAuthorized(history),
      transcribe: analyzeAudio, verifySelection: scenes => verifySceneQuotes(scenes,sources,path.join(dataDir,'sentence-audit')),
      register: async item => { throwIfJobCancelled();await oss?.put(job.ownerId!, 'media', item.id, path.join(mediaDir,item.id),item.mimeType);throwIfJobCancelled();state.media.push(item);await saveState(); },
      persist: async next => {throwIfJobCancelled();session.plan=next;await saveState();},
      progress: basicProgress,
      render: next => renderPlan(next,media,mediaDir,exportDir,undefined,bgmFile),review: (file,next) => reviewRender(file,next,media,reconstructionPrompt+'，同步字幕') };
  };
  if (job.kind === 'export') {
    if (!reconstruction && !useEditorial && shouldUpdatePlan(prompt, Boolean(session.plan))) {
      await prepareSpeech();
      const editable = selectedSources().filter((item) => item.kind === 'video' || item.kind === 'image');
      if (!editable.length) throw new Error('请先添加视频或图片素材，再说“生成成片”。');
      const textConfig = await getModelConfig('text', session.modelId);
      if (!textConfig) throw new Error('文本模型尚未配置，请在管理后台设置 API Key 后重试。');
      const plan = withCover(await createPlanWithPi(prompt, textConfig, editable, history, session.plan, attached, analyzeAudio, basicProgress));
      session.plan = { ...plan, version: (session.plan?.version || 0) + 1 };
      job.progress = 8; await saveState();
    } else if (coverIntent || removeCover) {
      session.plan = { ...withCover(session.plan), version: (session.plan?.version || 0) + 1 };
    }
    job.progress = 10; await saveState();
    const narrationId = reconstruction ? undefined : state.narrationBySession[session.id];
    const narrationFile = narrationId && state.artifactFiles[narrationId] ? path.join(artifactDir, state.artifactFiles[narrationId]) : undefined;
    const bgmId = reconstruction && !/(?:加入|配上|使用).{0,8}(?:BGM|背景音乐|配乐)/i.test(prompt) ? undefined : state.bgmBySession[session.id];
    const bgmFile = bgmId === 'preset' ? path.join(dataDir, 'preset-bgm.wav') : bgmId && media.some((item) => item.id === bgmId && item.kind === 'audio') ? path.join(mediaDir, bgmId) : undefined;
    if (bgmId && !bgmFile) throw new Error('背景音乐素材已被移除，请重新选择。');
    if (bgmId === 'preset') await writePresetBgm(bgmFile!);
    let plan = session.plan!;
    let result: Awaited<ReturnType<typeof renderPlan>>;
    let review: Awaited<ReturnType<typeof reviewRender>>;
    if (reconstruction && (shouldUpdatePlan(prompt, Boolean(session.plan)) || !session.plan?.reconstruction)) {
      const workflow = await runNarrativeWorkflow(await narrativeOptions(true, bgmFile));
      plan=session.plan=workflow.plan;result=workflow.rendered!;review=workflow.review!;
    } else if (useEditorial && !reconstruction) {
      const workflow = await runEditorialWorkflow({ ...(await editorialOptions()), export: true, reuse: !shouldUpdatePlan(prompt, Boolean(session.plan)),
        render: async (next) => {
          for (const clip of next.clips) await oss?.ensure(job.ownerId!, 'media', clip.sourceId, path.join(mediaDir, clip.sourceId));
          if (narrationId && narrationFile) await oss?.ensure(job.ownerId!, 'artifacts', narrationId, narrationFile);
          if (bgmId && bgmId !== 'preset' && bgmFile) await oss?.ensure(job.ownerId!, 'media', bgmId, bgmFile);
          return renderPlan(next, media, mediaDir, exportDir, narrationFile, bgmFile);
        }, review: (file, next) => reviewRender(file, next, media, prompt) });
      plan = session.plan = workflow.plan; result = workflow.rendered!; review = workflow.review!;
    } else {
    const traceModels = await Promise.all([getModelConfig('text', session.modelId),getModelConfig('understanding')]);
    const exportTrace = createToolTrace(basicProgress,traceModels.flatMap(model=>model?.apiKey?[model.apiKey]:[]));
    for (const clip of plan.clips) await oss?.ensure(job.ownerId!, 'media', clip.sourceId, path.join(mediaDir, clip.sourceId));
    if (narrationId && narrationFile) await oss?.ensure(job.ownerId!, 'artifacts', narrationId, narrationFile);
    if (bgmId && bgmId !== 'preset' && bgmFile) await oss?.ensure(job.ownerId!, 'media', bgmId, bgmFile);
    if (plan.coverMediaId) await oss?.ensure(job.ownerId!, 'media', plan.coverMediaId, path.join(mediaDir, plan.coverMediaId));
    updateReply(session,job,'方案已确认，正在渲染画面、字幕和声音。','commentary','basic-render');await saveState();
    result = await exportTrace.run('render_video','合成剪辑成片',{planHash:planHash(plan),clips:plan.clips.length,seconds:plan.targetSeconds},()=>renderPlan(plan, media, mediaDir, exportDir, narrationFile, bgmFile));
    job.progress = 90; await saveState();
    updateReply(session,job,'成片已渲染，正在检查画面、字幕和声音。','commentary','basic-review');await saveState();
    review = await exportTrace.run('review_video','独立检查成片',{artifactId:result.id,planHash:planHash(plan)},()=>reviewRender(result.file, plan, media, prompt));
    const correctable = review.status === 'needs-review' && review.checks.some((c) => !c.passed && ['实际时长', '字幕执行', '字幕原话', '字幕时间映射', '覆盖层执行', '对比关键词覆盖', '推镜执行', '转场执行', '响度归一化执行', '完整句子', '人声响度', '分段人声响度一致性', '段落衔接音量跳变', '段内音量稳定性', '声音峰值与削波', '成片语义审查'].includes(c.name) && c.detail !== '未完成，不能视为通过');
    if (correctable) {
      const textConfig = await getModelConfig('text', session.modelId);
      if (textConfig) {
        try {
          const findings = review.checks.filter((c) => !c.passed).map((c) => `${c.name}：${c.detail}`).join('；');
          const repairedBase = withCover(await exportTrace.run('repair_edit','根据成片检查返修剪辑',{findings},()=>createPlanWithPi(`${prompt}\n成片审查发现：${findings}。请修复上述问题，保留其他已有设置，不编造素材。`, textConfig, selectedSources().filter((m) => m.kind !== 'audio'), history, plan, attached, analyzeAudio, basicProgress)));
          const repaired = { ...repairedBase, version: (plan.version || 0) + 1 };
          for (const clip of repaired.clips) await oss?.ensure(job.ownerId!, 'media', clip.sourceId, path.join(mediaDir, clip.sourceId));
          const repairedResult = await exportTrace.run('render_video','合成返修成片',{planHash:planHash(repaired),clips:repaired.clips.length,seconds:repaired.targetSeconds},()=>renderPlan(repaired, media, mediaDir, exportDir, narrationFile, bgmFile));
          const repairedReview = await exportTrace.run('review_video','复查返修成片',{artifactId:repairedResult.id,planHash:planHash(repaired)},()=>reviewRender(repairedResult.file, repaired, media, prompt));
          // Keep the first result if the attempted repair made its checks worse.
          if (repairedReview.score >= review.score && repairedReview.checks.filter((c) => !c.passed).length <= review.checks.filter((c) => !c.passed).length) {
            plan = repaired; session.plan = plan;
            result = repairedResult; review = repairedReview; if (review.semantic) review.semantic.repaired = true;
          }
        } catch { throwIfJobCancelled();review.limitations.push('自动返修未完成，保留原成片及审查问题，可继续修改。'); }
      }
    }
    }
    const id = result.id;
    const cover = plan.coverMediaId ? media.find((item) => item.id === plan.coverMediaId && item.kind === 'image') : undefined;
    if (plan.coverMediaId && !cover) throw new Error('封面图片素材已被移除，请重新指定。');
    if (cover) await copyFile(path.join(mediaDir, cover.id), path.join(exportDir, `${id}-cover.${extFor(cover.mimeType)}`));
    try {
      await oss?.put(job.ownerId!, 'exports', id, result.file, 'video/mp4');
      if (cover) await oss?.put(job.ownerId!, 'covers', id, path.join(exportDir, `${id}-cover.${extFor(cover.mimeType)}`), cover.mimeType);
    } catch (error) {
      if (oss) await Promise.allSettled([oss.remove(job.ownerId!, 'exports', id), oss.remove(job.ownerId!, 'covers', id)]);
      throw error;
    }
    const version = state.artifacts.filter((item) => item.sessionId === session.id && item.kind === 'video').length + 1;
    const artifact: Artifact = { id, ownerId: job.ownerId, sessionId: session.id, messageId: message.id, kind: 'video', name: `轻剪成片-v${version}.mp4`, url: `/api/artifacts/${id}`, downloadUrl: `/api/download/${id}`, createdAt: now(), version, duration: plan.targetSeconds, format: plan.format, plan: structuredClone(plan), workflow: job.workflow ? structuredClone(job.workflow) : undefined, review, planHash: planHash(plan), hasNarration: Boolean(narrationFile || plan.reconstruction?.beats.some(b=>b.mode==='generated')), hasBgm: Boolean(bgmFile), ...(cover ? { coverUrl: `/api/artifacts/${id}/cover`, coverMimeType: cover.mimeType } : {}) };
    state.artifacts.push(artifact); job.artifactId = id;
    addReply(session, job, `成片 v${version} 已生成，${renderReviewSummary(review)}，可以预览并下载。${narrationFile ? '已合入口播音频。' : ''}${bgmFile ? '已合入背景音乐。' : ''}`, id);
    return;
  }
  const textConfig = await getModelConfig('text', session.modelId);
  if (!textConfig) throw new Error('文本模型尚未配置，请在管理后台设置 API Key 后重试。');
  if (job.kind === 'image') {
    const imageConfig = await getModelConfig('image');
    if (!imageConfig) throw new Error('图片模型尚未配置，请在管理后台设置 API Key 后重试。');
    const imagePrompt = await createImagePromptWithPi(prompt, textConfig, history);
    job.progress = 35; await saveState();
    const referenceItem = attached.find((item) => item.kind === 'image');
    if (referenceItem) await oss?.ensure(job.ownerId!, 'media', referenceItem.id, path.join(mediaDir, referenceItem.id));
    const reference = referenceItem ? { bytes: await readFile(path.join(mediaDir, referenceItem.id)), mimeType: referenceItem.mimeType } : undefined;
    const result = await generateImage(imagePrompt, imageConfig, reference);
    const artifact = await addArtifact(session, job, 'image', `轻剪图片-${new Date().toISOString().slice(0, 10)}.${extFor(result.mimeType)}`, result.bytes, result.mimeType);
    job.artifactId = artifact.id; addReply(session, job, '图片已生成。你可以预览、下载，或继续通过对话调整。', artifact.id);
    return;
  }
  if (job.kind === 'audio') {
    const narration = await createNarrationWithPi(prompt, textConfig, history);
    updateReply(session,job,`口播文案：\n${narration}`,'commentary','narration-script');
    updateReply(session,job,'文案已准备，正在合成音频。','commentary','narration-render');
    job.progress = 35; await saveState();
    const audioConfig = await getModelConfig('audio');
    if (!audioConfig) throw new Error('音频模型尚未配置，请在管理后台设置 API Key 后重试。');
    const result = await generateAudio(narration, audioConfig);
    const artifact = await addArtifact(session, job, 'audio', `轻剪口播-${new Date().toISOString().slice(0, 10)}.${extFor(result.mimeType)}`, result.bytes, result.mimeType, narration, result.durationSec);
    job.artifactId = artifact.id; addReply(session, job, '口播音频已生成，可试听和下载。完整文案见处理过程。', artifact.id);
    return;
  }
  const editable = selectedSources().filter((item) => item.kind === 'video' || item.kind === 'image');
  const isEditRequest = /(剪|字幕|缩放|转场|分镜|镜头|片段|分割|裁|时长|比例|画幅|排序|节奏|拼接|视频|调整|修改|做一个)|(?:trim|split|cut|clip|duration|aspect|ratio|reorder|pace|edit|video)/i.test(prompt);
  if ((isEditRequest || reconstruction) && editable.length) {
    let plan: NonNullable<Session['plan']>;
    if (reconstruction) {
      const workflow = await runNarrativeWorkflow(await narrativeOptions(false));
      plan = workflow.plan; session.plan = plan;
    } else if (useEditorial) {
      const workflow = await runEditorialWorkflow({ ...(await editorialOptions()), export: false, render: async () => { throw new Error('本次仅生成方案。'); }, review: (file, next) => reviewRender(file, next, media, prompt) });
      plan = workflow.plan; session.plan = plan;
    } else {
      await prepareSpeech();
      plan = withCover(await createPlanWithPi(prompt, textConfig, editable, history, session.plan, attached, analyzeAudio, basicProgress));
      session.plan = { ...plan, version: (session.plan?.version || 0) + 1 };
    }
    addReply(session, job, `${plan.summary} 已整理 ${plan.clips.length} 个片段，合计约 ${plan.targetSeconds} 秒。${bgmIntent ? '已加入背景音乐。' : ''}继续告诉我怎么调整，或发送“生成成片”。`);
  } else addReply(session, job, await answerForSessionWithPi({prompt,config:textConfig,media,history,plan:session.plan,attached,progress:basicProgress,onSection:async(id,text)=>{updateReply(session,job,text,'commentary',id);await saveState();}}));
}
let processing = false;
async function processQueue() {
  return withoutJobSignal(async () => {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const job = state.jobs.find((item) => item.status === 'queued');
      if (!job) break;
      const attempt = beginJobAttempt(job, runtimeImplementation.revision, now());
      let transport: NonNullable<NonNullable<Job['attempts']>[number]['transport']> = [];
      let modelSecrets: string[] = [];
      job.status = 'running'; job.updatedAt = now(); job.progress = 5; job.error = undefined;
      const activeSession=getSession(job.sessionId);
      if(activeSession)updateReply(activeSession,job,'收到请求，正在理解制作要求并规划执行步骤。','commentary','start');
      await saveState();
      try {
        await jobRunner.run(job, async () => {
          try {
          let models = evaluationJobModels.get(job.id);
          if (isEvaluationOwner(job.ownerId) && !models) throw new EvaluationError('评测模型快照已中断，请重新运行评测。');
          if (!models) {
            const [text, image, audio, understanding] = await Promise.all([getModelConfig('text', activeSession?.modelId), getModelConfig('image'), getModelConfig('audio'), getModelConfig('understanding')]);
            models = { text, image, audio, understanding, textFallbacks: await getTextFallbackConfigs(text) };
          }
          job.textModel = models.text ? { id: models.text.id, name: models.text.name, modelId: models.text.modelId } : undefined;
          modelSecrets = snapshotModels(models).flatMap(model => model?.apiKey ? [model.apiKey] : []);
          await saveState();
          if (!isEvaluationOwner(job.ownerId) && !auth.listUsers().some(user => user.id === job.ownerId)) throw new CreditError('任务所属账户不存在，无法记录积分用量。', 'CREDIT_OWNER_MISSING', 409);
          const execute = () => withModelSnapshot(models!, () => performJob(job));
          return await (isEvaluationOwner(job.ownerId) ? execute() : withCreditUsage(credits, job.ownerId!, job.creditTaskId ?? job.id, execute));
          } finally { transport = getJobTransportDiagnostics(); }
        });
        job.status = 'succeeded'; job.progress = 100;
      }
      catch (error) {
        if (error instanceof JobCancelledError || job.stopRequestedAt) {
          job.status = 'cancelled'; job.cancelledAt = now(); job.progress = undefined; job.error = undefined; job.stage = '已停止运行';
          const session = getSession(job.sessionId);
          if (session) addReply(session, job, '已停止运行。已完成的步骤和生成结果已保留。');
        } else {
          job.status = 'failed'; job.progress = undefined;
          job.failure = executionFailure(error, modelSecrets);
          job.stage = job.failure.origin?.stage || job.stage;
          transport = transport.length ? transport : jobErrorDiagnostics(error);
          job.error = jobFailureMessage(error, job.stage, modelSecrets);
          console.error(JSON.stringify({ event: 'job.failed', jobId: job.id, attemptId: attempt.id, revision: attempt.revision, kind: job.kind, stage: job.stage, model: job.textModel, failure: job.failure, transport }));
          const session = getSession(job.sessionId);
          if (session) addReply(session, job, `本次处理未完成：${job.error}`);
        }
      }
      job.updatedAt = now();
      finishJobAttempt(job, job.updatedAt, transport, job.failure);
      if (job.status !== 'failed') console.info(JSON.stringify({ event: 'job.finished', jobId: job.id, attemptId: attempt.id, revision: attempt.revision, status: job.status, kind: job.kind, artifactId: job.artifactId, durationMs: Date.parse(job.updatedAt) - Date.parse(attempt.startedAt), recoveredRequests: transport.filter(d => d.outcome === 'recovered').length }));
      evaluationJobModels.delete(job.id);
      const session = getSession(job.sessionId); if (session) session.updatedAt = now();
      await saveState();
    }
  } finally { processing = false; }
  });
}

async function enqueueAgentMessage(session: Session, text: string, attachmentIds: string[], voiceTicket?: string): Promise<Job> {
  const creditTaskId = isEvaluationOwner(session.ownerId) ? undefined : await credits.admit(session.ownerId!, text, voiceTicket);
  const createdAt = now();
  const message: ChatMessage = { id: randomUUID(), role: 'user', text, createdAt, attachmentIds };
  const job: Job = { id: randomUUID(), ownerId: session.ownerId, sessionId: session.id, messageId: message.id, kind: classify(text), status: 'queued', createdAt, updatedAt: createdAt, progress: 0 };
  job.creditTaskId = creditTaskId;
  // Freeze the selected asset when the request is accepted, so a UI switch
  // during a long render cannot change this job's author identity.
  job.authorAvatarId=state.profiles[session.ownerId!]?.settings.authorAvatarId||null;
  message.jobId = job.id;
  session.messages.push(message);
  if (session.title === '新对话' || session.title === '新会话') session.title = text.slice(0, 24);
  session.updatedAt = createdAt;
  state.jobs.push(job);
  return job;
}
const runtimeImplementation = await evaluationImplementation(root);
const evaluations = createEvaluations({
  dataDir,
  implementation: runtimeImplementation,
  models: async preferred => {
    const [text, audio, understanding, image] = await Promise.all([getModelConfig('text', preferred), getModelConfig('audio'), getModelConfig('understanding'), getModelConfig('image')]);
    return { text, audio, understanding, image, textFallbacks: await getTextFallbackConfigs(text) };
  },
  stop: async runId => {
    for (const session of state.sessions.filter(s => s.ownerId?.startsWith(`evaluation:${runId}:`))) jobRunner.stopSession(state.jobs, session.ownerId!, session.id, now());
    await persistState();
  },
  artifactFile: (runId, resultId, artifactId) => {
    const artifact = state.artifacts.find(a => a.id === artifactId && a.ownerId === `evaluation:${runId}:${resultId}`);
    return artifact ? artifactFile(artifact) || undefined : undefined;
  },
  execute: async (test, context) => {
    const ownerId = `evaluation:${context.runId}:${context.resultId}`, session = { ...newSession(context.models.text!.id), ownerId, title: `评测 · ${test.name}` };
    const sources: MediaItem[] = [];
    for (const fixture of context.fixtures) {
      if (context.signal.aborted) throw new EvaluationError('评测已停止。');
      if (await evaluationFileHash(fixture.file) !== fixture.sha256) throw new EvaluationError('评测素材哈希已改变，请重新上传并绑定。');
      const id = randomUUID(); await copyFile(fixture.file, path.join(mediaDir, id));
      sources.push({ id, ownerId, name: fixture.name, kind: 'video', mimeType: 'video/mp4', duration: fixture.duration, hasAudio: fixture.hasAudio, shots: fixture.shots.map(s => ({ ...s, thumbnailUrl: '' })), url: `/api/media/${id}`, origin: 'upload', createdAt: now() });
    }
    state.sessions.push(session); state.media.push(...sources); await saveState();
    const sourceIds = sources.map(m => m.id), jobs: Job[] = [];
    const onAbort = () => { jobRunner.stopSession(state.jobs, ownerId, session.id, now()); void persistState().catch(() => undefined); };
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (const text of test.messages) {
        if (context.signal.aborted) throw new EvaluationError('评测已停止。');
        if (wantsScheduleManagement(text)) throw new EvaluationError('视频评测不执行定时任务管理，请填写研究、剪辑或视频制作指令。');
        const job = await enqueueAgentMessage(session, text, sourceIds); jobs.push(job); evaluationJobModels.set(job.id, context.models);
        await saveState(); await context.progress({ jobs }); void processQueue();
        while (['queued','running','stopping'].includes(job.status)) {
          if (context.signal.aborted) onAbort();
          await new Promise(resolve => setTimeout(resolve, 1000)); await context.progress({ jobs });
        }
        if (job.status !== 'succeeded') throw new EvaluationError(job.error || '评测执行已停止。');
      }
      const last = jobs.at(-1), artifact = state.artifacts.find(a => a.id === last?.artifactId && a.ownerId === ownerId && a.kind === 'video');
      const file = artifact && artifactFile(artifact);
      if (!artifact || !file) throw new EvaluationError('最后一轮指令未生成视频，不能视为完成评测。');
      return { artifact: structuredClone(artifact), file, media: state.media.filter(m => m.ownerId === ownerId), sourceIds, workflow: jobs.flatMap(j => j.workflow || []) };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      const unfinished = jobs.some(job => ['queued','running','stopping'].includes(job.status));
      if (unfinished) jobRunner.stopSession(state.jobs, ownerId, session.id, now());
      for (const job of jobs) evaluationJobModels.delete(job.id);
      if (unfinished) await persistState();
    }
  },
});
await evaluations.init();
const releaseEvaluations = createReleaseEvaluations({ dataDir, implementation: runtimeImplementation, evaluations, onError: error => console.error(JSON.stringify({ event: 'release-evaluation.error', failure: executionFailure(error) })) });
try { await releaseEvaluations.init(); }
catch (error) { console.error(JSON.stringify({ event: 'release-evaluation.init-failed', failure: executionFailure(error) })); }

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
const auth = createAuth(dataDir, publicBase);
await auth.load();
const credits = createCredits(dataDir);
await credits.load(auth.listUsers());
const adminAuth = createAdminAuth(dataDir);
await adminAuth.load();
adminAuth.mount(app);
mountAdminRoutes(app, effects, adminAuth, publicBase, evaluations, releaseEvaluations);
mountCreditAdminRoutes(app, credits, adminAuth, auth.listUsers);
app.get('/api/effects', (_request, response) => response.json({ effects: effects.list().filter((item) => item.enabled).map(({ id, name, description, duration, width, height }) => ({ id, name, description, duration, width, height })) }));
app.get('/api/effects/assets/:id', async (request, response) => {
  const asset = effects.getAsset(request.params.id);
  if (!asset) return response.status(404).json({ error: '素材不存在。' });
  try { response.type(asset.mimeType).sendFile(await effects.ensureAsset(asset)); }
  catch { response.status(404).json({ error: '素材文件不存在。' }); }
});
auth.mount(app, credits.readiness, user => credits.snapshot(user.id));
mountCreditRoutes(app, credits);
mountVoiceInputRoutes(app, tmpDir, undefined, credits);
mountAvatarRoutes(app,{
  media:()=>state.media,mediaDir,tmpDir,save:saveState,publicState,
  settings:async user=>(await profileOf(user)).settings,session:getSession,
  async generate(session,source){
    const busy=state.jobs.find(j=>j.ownerId===session.ownerId&&j.kind==='avatar'&&j.avatarSourceId===source.id&&['queued','running','stopping'].includes(j.status));
    if(busy)return;
    const creditTaskId = await credits.admit(session.ownerId!);
    const timestamp=now(),message:ChatMessage={id:randomUUID(),role:'user',text:`为「${source.name}」生成透明作者动画`,createdAt:timestamp,attachmentIds:[source.id]};
    const job:Job={id:randomUUID(),ownerId:session.ownerId,sessionId:session.id,messageId:message.id,kind:'avatar',avatarSourceId:source.id,status:'queued',createdAt:timestamp,updatedAt:timestamp,progress:0};
    job.creditTaskId = creditTaskId;
    message.jobId=job.id;session.messages.push(message);state.jobs.push(job);session.updatedAt=timestamp;
  },process:()=>void processQueue(),
});
const upload = multer({ storage: multer.diskStorage({ destination: tmpDir, filename: (_request, _file, done) => done(null, randomUUID()) }), limits: { fileSize: MAX_MEDIA_UPLOAD_BYTES, files: 6 }, fileFilter: (_request, file, done) => done(null, file.mimetype === 'application/octet-stream' || file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) });
function musicErrorResponse(response: Response, error: unknown) {
  if (error instanceof MusicSourceError) {
    const clientError = error.code.startsWith('INVALID_');
    response.status(clientError ? 400 : 502).json({ error: error.message, code: error.code, source: error.source, ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) });
    return;
  }
  response.status(502).json({ error: error instanceof Error ? error.message : '音乐站点请求失败。', code: 'UPSTREAM_REQUEST_FAILED' });
}
app.post('/api/music/search', async (request, response) => {
  const source = request.body?.source;
  try {
    if (source === 'pixabay') {
      if (request.body?.page !== undefined && Number(request.body.page) !== 1) return response.status(400).json({ error: 'Pixabay 当前搜索页只支持第 1 页。', code: 'INVALID_PAGE' });
      return response.json(await searchPixabayMusic(request.body?.query));
    }
    if (source === '24bit') return response.json(await search24bitMusic(request.body?.query, request.body?.page));
    return response.status(400).json({ error: 'source 仅支持 pixabay 或 24bit。', code: 'INVALID_SOURCE' });
  } catch (error) { musicErrorResponse(response, error); }
});
app.post('/api/music/pixabay/detail', async (request, response) => {
  try { response.json(await getPixabayTrackDetail(request.body?.detailUrl)); }
  catch (error) { musicErrorResponse(response, error); }
});
app.post('/api/music/pixabay/download', async (request, response) => {
  try {
    const url = typeof request.body?.url === 'string' ? pixabayAudioUrl(request.body.url) : null;
    if (!url) return response.status(400).json({ error: '只支持 Pixabay 官方 CDN 音乐 MP3 地址。', code: 'INVALID_TRACK_URL' });
    const file = await downloadPixabayAudio(url);
    response.type('audio/mpeg').attachment(file.name).send(file.bytes);
  } catch (error) { musicErrorResponse(response, error); }
});
app.post('/api/music/24bit/download', async (request, response) => {
  try {
    const file = await download24bitAudio(request.body?.track, request.body?.audioUrl, request.body?.detailUrl);
    response.type(file.mimeType).attachment(file.name).send(file.bytes);
  } catch (error) { musicErrorResponse(response, error); }
});
app.get('/api/state', async (request, response) => response.json(await publicState(userOf(request))));
app.post('/api/sessions', async (request, response) => { const user = userOf(request); const profile = await profileOf(user); const session = { ...newSession(profile.settings.defaultModelId), ownerId: user.id }; state.sessions.unshift(session); profile.activeSessionId = session.id; await saveState(); response.json(await publicState(user)); });
app.post('/api/sessions/:id/activate', async (request, response) => { const user = userOf(request); if (!getSession(request.params.id, user.id)) return response.status(404).json({ error: '对话不存在。' }); (await profileOf(user)).activeSessionId = request.params.id; await saveState(); response.json(await publicState(user)); });
app.patch('/api/sessions/:id/model', async (request, response) => {
  const user = userOf(request);
  const session = getSession(request.params.id, user.id);
  if (!session) return response.status(404).json({ error: '对话不存在。' });
  const id = request.body?.modelId;
  if (typeof id !== 'string' || !id || !(await getModelConfig('text', id))) return response.status(400).json({ error: '请选择已启用且配置了密钥的文本模型。' });
  if (state.jobs.some(job => job.sessionId === session.id && isActiveJob(job))) return response.status(409).json({ error: '请等当前任务完成或停止后再切换模型。' });
  session.modelId = id;
  session.updatedAt = now();
  await saveState();
  response.json(await publicState(user));
});
app.post('/api/sessions/:id/stop', async (request, response) => {
  const user = userOf(request);
  const session = getSession(request.params.id, user.id);
  if (!session) return response.status(404).json({ error: '对话不存在。' });
  const stopped = jobRunner.stopSession(state.jobs, user.id, session.id, now());
  for (const job of stopped) if (job.status === 'cancelled') addReply(session, job, '已停止运行。');
  if (stopped.length) session.updatedAt = now();
  await saveState();
  response.json(await publicState(user));
});
app.post('/api/chat', async (request, response) => {
  const user = userOf(request);
  const session = getSession(String(request.body?.sessionId || ''), user.id);
  if (!session) return response.status(404).json({ error: '对话不存在，请刷新后重试。' });
  const text = typeof request.body?.message === 'string' ? request.body.message.trim().slice(0, 2000) : '';
  if (!text) return response.status(400).json({ error: '请输入想让轻剪完成的内容。' });
  const attachments = Array.isArray(request.body?.attachmentIds) ? request.body.attachmentIds : [];
  if (attachments.length > 6 || attachments.some((id: unknown) => typeof id !== 'string' || !state.media.some((item) => item.id === id && owned(item, user.id)))) return response.status(400).json({ error: '附件不存在或一次添加过多。' });
  if (request.body?.voiceTicket !== undefined && (typeof request.body.voiceTicket !== 'string' || request.body.voiceTicket.length > 100)) return response.status(400).json({ error: '语音指令凭证格式无效。' });
  await enqueueAgentMessage(session, text, attachments, request.body?.voiceTicket);
  await saveState(); response.json(await publicState(user)); void processQueue();
});
app.post('/api/media', upload.array('files', 6), async (request, response) => {
  const user = userOf(request);
  const files = (request.files || []) as Express.Multer.File[];
  if (!files.length) return response.status(400).json({ error: '请选择视频、图片或音频文件。' });
  const moved: string[] = [];
  const stored: string[] = [];
  const items: MediaItem[] = [];
  let staged = false;
  try {
    for (const file of files) {
      let mimeType = await uploadMediaType(file.path, file.mimetype); let duration: number | undefined; let hasAudio: boolean | undefined; let kind: MediaItem['kind'];
      if (mimeType.startsWith('image/')) { const detected = detectImage(await readFile(file.path)); if (!detected) throw new Error('图片格式仅支持 PNG、JPEG 或 WebP。'); mimeType = detected; }
      else if (mimeType.startsWith('video/')) { const probed = await probeVideo(file.path); duration = probed.duration; hasAudio = probed.hasAudio; }
      else if (mimeType.startsWith('audio/')) { if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg'].includes(mimeType)) throw new Error('音频仅支持 MP3、WAV 或 OGG。'); duration = await probeAudio(file.path); }
      else throw new Error('仅支持视频、图片和音频素材。');
      kind = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image';
      const shots = kind === 'video' ? await detectShots(file.path, duration!, file.filename) : undefined;
      if (shots?.length) {
        for (const [index, shot] of shots.entries()) {
          const thumbnail = path.join(mediaDir, `${file.filename}-shot-${index}.jpg`);
          await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String((shot.start + shot.end) / 2), '-i', file.path, '-frames:v', '1', '-vf', 'scale=320:-2', thumbnail], 30_000);
          moved.push(thumbnail);
        }
      }
      const target = path.join(mediaDir, file.filename); await rename(file.path, target); moved.push(target);
      await oss?.put(user.id, 'media', file.filename, target, mimeType);
      if (oss) stored.push(file.filename);
      if (shots?.length) {
        for (const [index] of shots.entries()) {
          await oss?.put(user.id, 'shots', `${file.filename}-${index}`, path.join(mediaDir, `${file.filename}-shot-${index}.jpg`), 'image/jpeg');
          if (oss) stored.push(`shots/${file.filename}-${index}`);
        }
      }
      items.push({ id: file.filename, ownerId: user.id, name: shortName(file.originalname), mimeType, kind, ...(duration ? { duration } : {}), ...(hasAudio !== undefined ? { hasAudio } : {}), ...(shots ? { shots } : {}), url: `/api/media/${file.filename}`, createdAt: now(), origin: 'upload' });
    }
    state.media.push(...items);
    staged = true;
    await saveState();
  } catch (error) {
    if (staged) {
      const uploadedIds = new Set(items.map(item => item.id));
      state.media = state.media.filter(item => !uploadedIds.has(item.id));
      // A concurrent save may already have captured the tentative records.
      // Queue the rollback snapshot, preserving the original storage error.
      await persistState().catch(() => undefined);
    }
    await Promise.all([...files.map((file) => file.path), ...moved].map((file) => rm(file, { force: true })));
    if (oss) await Promise.allSettled(stored.map((id) => id.startsWith('shots/') ? oss.remove(user.id, 'shots', id.slice(6)) : oss.remove(user.id, 'media', id)));
    response.status(400).json({ error: error instanceof Error ? error.message : '素材解析或存储失败。' });
    return;
  }
  // Response-building errors after commit must not delete persisted media.
  response.json({ ...await publicState(user), uploadedMediaIds: items.map(item => item.id) });
});
app.post('/api/media/:id/analyze', async (request, response) => {
  const user = userOf(request); const item = state.media.find((m) => m.id === request.params.id && owned(m, user.id));
  const session = getSession(String(request.body?.sessionId || ''), user.id);
  if (!item || !session) return response.status(404).json({ error: '素材或会话不存在。' });
  if (item.kind === 'image') return response.status(400).json({ error: '请选择音频或视频素材。' });
  const busy = state.jobs.find((j) => j.ownerId === user.id && j.kind === 'understanding' && ['queued','running'].includes(j.status) && state.sessions.some((s) => s.messages.some((m) => m.jobId === j.id && m.attachmentIds?.includes(item.id))));
  if (busy) return response.status(202).json(await publicState(user));
  const creditTaskId = await credits.admit(user.id);
  const timestamp = now(); const id = randomUUID();
  const message: ChatMessage = { id, role: 'user', text: `转写「${item.name}」的原声音频`, createdAt: timestamp, attachmentIds: [item.id] };
  const job: Job = { id: randomUUID(), ownerId: user.id, sessionId: session.id, messageId: id, kind: 'understanding', status: 'queued', createdAt: timestamp, updatedAt: timestamp, progress: 0 };
  job.creditTaskId = creditTaskId;
  message.jobId = job.id; session.messages.push(message); session.updatedAt = timestamp; state.jobs.push(job);
  await saveState(); response.status(202).json(await publicState(user)); void processQueue();
});
app.get('/api/media/:id/transcript', async (request, response) => {
  const item = state.media.find((m) => m.id === request.params.id && owned(m, userOf(request).id));
  if (!item?.analysis) return response.status(404).json({ error: '逐字稿尚未完成，请先分析素材。' });
  response.attachment(`${shortName(item.name)}-transcript.json`).json(item.analysis);
});
app.delete('/api/media/:id', async (request, response) => {
  const user = userOf(request);
  const item = state.media.find((media) => media.id === request.params.id && owned(media, user.id));
  if (!item) return response.status(404).json({ error: '素材不存在。' });
  state.media = state.media.filter((media) => media.id !== item.id);
  const profile=await profileOf(user);
  if(profile.settings.authorAvatarId===item.id)profile.settings.authorAvatarId=null;
  for (const session of state.sessions) if (owned(session, user.id) && (session.plan?.clips.some((clip) => clip.sourceId === item.id) || session.plan?.coverMediaId === item.id)) session.plan = null;
  for (const artifact of state.artifacts) if (owned(artifact, user.id) && artifact.mediaId === item.id) artifact.mediaId = undefined;
  await saveState(); await rm(path.join(mediaDir, item.id), { force: true }); await audioUnderstanding.remove(item.id);
  try { await oss?.remove(user.id, 'media', item.id); } catch { console.error('OSS media cleanup failed for', item.id); }
  for (const [index] of (item.shots || []).entries()) {
    await rm(path.join(mediaDir, `${item.id}-shot-${index}.jpg`), { force: true });
    try { await oss?.remove(user.id, 'shots', `${item.id}-${index}`); } catch { console.error('OSS shot cleanup failed for', item.id, index); }
  }
  response.json(await publicState(user));
});
app.get('/api/media/:id', async (request, response) => {
  const item = state.media.find((media) => media.id === request.params.id && owned(media, userOf(request).id));
  if (!item) return response.status(404).json({ error: '素材不存在。' });
  const file = path.join(mediaDir, item.id);
  try { await oss?.ensure(userOf(request).id, 'media', item.id, file); response.type(item.mimeType).sendFile(file); }
  catch { response.status(502).json({ error: '素材暂时无法从对象存储读取。' }); }
});
app.get('/api/media/:id/shots/:index', async (request, response) => {
  const item = state.media.find((media) => media.id === request.params.id && media.kind === 'video' && owned(media, userOf(request).id));
  const index = Number(request.params.index);
  if (!item?.shots?.[index] || !Number.isInteger(index)) return response.status(404).json({ error: '镜头不存在。' });
  const shot = item.shots[index];
  const thumbnail = path.join(mediaDir, `${item.id}-shot-${index}.jpg`);
  try {
    if (oss && await oss.exists(userOf(request).id, 'shots', `${item.id}-${index}`)) await oss.ensure(userOf(request).id, 'shots', `${item.id}-${index}`, thumbnail);
    else {
      await oss?.ensure(userOf(request).id, 'media', item.id, path.join(mediaDir, item.id));
      await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String((shot.start + shot.end) / 2), '-i', path.join(mediaDir, item.id), '-frames:v', '1', '-vf', 'scale=320:-2', thumbnail], 30_000);
      await oss?.put(userOf(request).id, 'shots', `${item.id}-${index}`, thumbnail, 'image/jpeg');
    }
    response.type('image/jpeg').sendFile(thumbnail);
  } catch { response.status(500).json({ error: '缩略图生成失败。' }); }
});
app.get('/api/jobs/:id', (request, response) => { const job = state.jobs.find((item) => item.id === request.params.id && owned(item, userOf(request).id)); if (!job) return response.status(404).json({ error: '任务不存在。' }); response.json(publicJob(job)); });
app.get('/api/jobs/:id/attempts/:attemptId', (request, response) => {
  const job = state.jobs.find(item => item.id === request.params.id && owned(item, userOf(request).id));
  const attempt = job?.attempts?.find(item => item.id === request.params.attemptId);
  if (!attempt) return response.status(404).json({ error: '本次执行记录不存在。' });
  response.json({ attempt });
});
app.post('/api/jobs/:id/retry', async (request, response) => {
  const user = userOf(request);
  const job = state.jobs.find((item) => item.id === request.params.id && owned(item, user.id));
  if (!job) return response.status(404).json({ error: '任务不存在。' });
  const candidate=state.artifacts.find(a=>a.id===job.artifactId&&owned(a,user.id));
  const needsLessonRepair=job.status==='succeeded'&&candidate?.plan?.lesson&&candidate.review?.status==='needs-review';
  if (job.status !== 'failed'&&!needsLessonRepair) return response.status(409).json({ error: '只有失败的任务或未通过审查的教学成片可以重试。' });
  job.creditTaskId = await credits.admit(user.id);
  // An unavailable auditor has no content correction to make. Recheck the
  // existing artifact instead of restarting today's research and rendering.
  if(needsLessonRepair&&candidate?.review)job.kind=reviewNeedsContentRepair(candidate.review)?'export':'review';
  job.status = 'queued'; job.error = undefined; job.progress = 0; job.updatedAt = now();
  const session = getSession(job.sessionId);
  if(session)session.messages=session.messages.filter(m=>!(m.role==='assistant'&&m.jobId===job.id));
  await saveState(); response.json(await publicState(user)); void processQueue();
});
function artifactFile(artifact: Artifact) { if (artifact.kind === 'video') return path.join(exportDir, `${artifact.id}.mp4`); const filename = state.artifactFiles[artifact.id]; return filename ? path.join(artifactDir, path.basename(filename)) : null; }
app.get('/api/artifacts/:id/edit-report', (request, response) => {
  const artifact = state.artifacts.find((item) => item.id === request.params.id && owned(item, userOf(request).id));
  if (!artifact?.plan) return response.status(404).json({ error: '剪辑记录不存在。' });
  response.setHeader('Content-Disposition', `attachment; filename=edit-report-${artifact.id}.json`);
  response.json({ artifactId: artifact.id, planHash: artifact.planHash, plan: artifact.plan, workflow: artifact.workflow, review: artifact.review });
});
app.get('/api/artifacts/:id/cover', async (request, response) => {
  const artifact = state.artifacts.find((item) => item.id === request.params.id && item.kind === 'video' && owned(item, userOf(request).id));
  if (!artifact?.coverMimeType) return response.status(404).json({ error: '封面不存在。' });
  const file = path.join(exportDir, `${artifact.id}-cover.${extFor(artifact.coverMimeType)}`);
  try { await oss?.ensure(userOf(request).id, 'covers', artifact.id, file); response.type(artifact.coverMimeType).sendFile(file); }
  catch { response.status(502).json({ error: '封面暂时无法读取。' }); }
});
app.get('/api/artifacts/:id', async (request, response) => { const artifact = state.artifacts.find((item) => item.id === request.params.id && owned(item, userOf(request).id)); const file = artifact && artifactFile(artifact); if (!artifact || !file) return response.status(404).json({ error: '产物不存在。' }); try { await oss?.ensure(userOf(request).id, artifact.kind === 'video' ? 'exports' : 'artifacts', artifact.id, file); response.sendFile(file); } catch { response.status(502).json({ error: '产物暂时无法读取。' }); } });
app.get('/api/download/:id', async (request, response) => { const artifact = state.artifacts.find((item) => item.id === request.params.id && owned(item, userOf(request).id)); const file = artifact && artifactFile(artifact); if (!artifact || !file) return response.status(404).json({ error: '产物不存在。' }); try { await oss?.ensure(userOf(request).id, artifact.kind === 'video' ? 'exports' : 'artifacts', artifact.id, file); response.download(file, artifact.name); } catch { response.status(502).json({ error: '产物暂时无法下载。' }); } });
app.patch('/api/settings', async (request, response) => {
  const user = userOf(request);
  const profile = await profileOf(user);
  const body = request.body as (Partial<AppSettings> & { applyToCurrentSession?: boolean }) | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return response.status(400).json({ error: '设置格式无效。' });
  if ('language' in body && body.language !== 'zh-CN' && body.language !== 'en-US') return response.status(400).json({ error: '不支持的语言。' });
  if ('chatBackground' in body && body.chatBackground !== null && (typeof body.chatBackground !== 'string' || body.chatBackground.length > 500_000)) return response.status(400).json({ error: '对话背景图片无效或过大。' });
  if ('applyToCurrentSession' in body && typeof body.applyToCurrentSession !== 'boolean') return response.status(400).json({ error: '设置格式无效。' });
  if (body.applyToCurrentSession && !('defaultModelId' in body)) return response.status(400).json({ error: '请选择对话模型。' });
  if ('defaultModelId' in body) {
    const id = body.defaultModelId;
    if (id !== null && (typeof id !== 'string' || !(await listPublicModels()).some((model) => model.id === id && model.kind === 'text' && model.enabled))) return response.status(400).json({ error: '对话模型不可用。' });
    if (body.applyToCurrentSession) {
      const session = getSession(profile.activeSessionId, user.id);
      if (!session) return response.status(404).json({ error: '对话不存在。' });
      if (state.jobs.some(job => job.sessionId === session.id && isActiveJob(job))) return response.status(409).json({ error: '请等当前任务完成后再切换。' });
      session.modelId = id!;
      session.updatedAt = now();
    }
    profile.settings.defaultModelId = id!;
  }
  if ('language' in body) profile.settings.language = body.language!;
  if ('chatBackground' in body) profile.settings.chatBackground = body.chatBackground!;
  await saveState(); response.json(await publicState(user));
});
app.use(((error, request, response, _next) => { if (error instanceof CreditError) { response.status(error.status).json({ error: error.message, code: error.code }); return; } if (error instanceof multer.MulterError) { response.status(400).json({ error: request.path.startsWith('/api/avatars') ? (error.code === 'LIMIT_FILE_SIZE' ? '形象图片不能超过 20 MB。' : '每次只能上传一张形象图片。') : error.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过 100 MB，请先压缩。' : '一次最多上传 6 个文件。' }); return; } response.status(500).json({ error: '处理请求时出错，请重试。' }); }) satisfies ErrorRequestHandler);
mountFrontendRoutes(app, path.join(root, 'dist'), publicBase);
app.listen(port, '127.0.0.1', () => console.log(`轻剪 API listening on http://127.0.0.1:${port}`));
void processQueue();
if (process.env.QINGJIAN_RELEASE_EVAL_STARTUP !== '0' && (existsSync(path.join(root, 'dist', 'release.json')) || process.env.QINGJIAN_RELEASE_EVAL_STARTUP === '1')) {
  void releaseEvaluations.enqueueCurrentRevision().catch(error => console.error(JSON.stringify({ event: 'release-evaluation.enqueue-failed', failure: executionFailure(error) })));
}
