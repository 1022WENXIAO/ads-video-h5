import CreativeGamePreview from './CreativeGamePreview';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { WorkflowTrace } from './WorkflowTrace';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock3,
  Coins,
  CornerDownLeft,
  Film,
  Image as ImageIcon,
  ImagePlus,
  Library,
  Menu,
  Mic2,
  Music2,
  Plus,
  Play,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import type {
  AppSettings,
  AppState,
  Artifact,
  ChatMessage,
  Job,
  MediaItem,
  MediaKind,
  PublicUser,
  Session,
} from "./types";
import { MAX_MEDIA_UPLOAD_BYTES } from "./uploadLimits";
import AssistantReply from "./AssistantReply";
import HotResearchCard from "./HotResearchCard";
import TemplateMentionInput from './TemplateMentionInput';
import VoiceInput from './VoiceInput';
import { fetchCredits } from './creditApi';
import type { CreditWallet } from '../shared/creditTypes';
import './credits.css';
import { formatPoints } from '../shared/creditFormat';
import { isActiveJob } from './jobStatus';
const AvatarPanel = lazy(() => import('./AvatarPanel'));
const CreditPage = lazy(() => import('./CreditPage'));

type Page =
  | "chat"
  | "history"
  | "media"
  | "avatars"
  | "films"
  | "settings"
  | "credits"
  | "profile"
  | "terms"
  | "privacy"
  | "timeline";
type Locale = "zh-CN" | "en-US";
const messageTimeFormatters = Object.fromEntries(
  ["zh-CN", "en-US"].map(locale => [locale, new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  })]),
) as Record<Locale, Intl.DateTimeFormat>;
type MediaFilter = "all" | MediaKind;
const mediaAccept: Record<MediaFilter, string> = {
  all: "video/*,image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/x-wav,audio/ogg",
  video: "video/*",
  image: "image/jpeg,image/png,image/webp",
  audio: "audio/mpeg,audio/wav,audio/x-wav,audio/ogg",
};
const apiPath = (url: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}${url}`;
const landscapeUrl = `${import.meta.env.BASE_URL}travel-cover.png`;
const labels = {
  "zh-CN": {
    chat: "对话",
    history: "会话历史",
    media: "素材库",
    avatars: "作者形象",
    films: "成片库",
    settings: "设置",
    credits: "我的积分",
    profile: "用户中心",
    terms: "用户协议",
    privacy: "隐私政策",
    timeline: "剪辑拼接",
    newChat: "新会话",
    hero: "一句话，剪出好视频",
    sub: "添加素材来剪辑，或说一个主题生成教学视频",
    input: "继续说说你想怎么剪…",
    add: "添加素材",
    download: "下载",
    retry: "重试",
    back: "返回对话",
    emptyMedia: "还没有素材",
    emptyFilms: "还没有生成成片",
    emptyHistory: "还没有会话",
    plan: "剪辑方案",
    voice: "口播文案",
    audio: "独立音频",
    image: "生成图片",
    video: "成片视频",
    all: "全部",
    videos: "视频",
    images: "图片",
    audios: "音频",
    model: "对话模型",
    modelLocked: "当前任务完成后可切换。",
    language: "界面语言",
    background: "对话背景",
    default: "默认背景",
    landscape: "暖色风景",
    custom: "本地图片",
    reset: "恢复默认",
    visitorHint: "你的会话、素材和成片仅在此帐号中可见。",
    unconfigured: "模型尚未配置，请管理员在后台设置。",
    legalDraft: "本地原型说明 · 正式上线前需由运营方确认完整条款",
    viewTimeline: "查看剪辑拼接",
    makeVideo: "对话生成成片",
  },
  "en-US": {
    chat: "Chat",
    history: "Conversations",
    media: "Media",
    avatars: "Author avatar",
    films: "Exports",
    settings: "Settings",
    credits: "Credits",
    profile: "Profile",
    terms: "Terms",
    privacy: "Privacy",
    timeline: "Edit preview",
    newChat: "New conversation",
    hero: "Make a video with one sentence",
    sub: "Edit your media or turn a topic into a teaching video",
    input: "Describe your next edit…",
    add: "Add media",
    download: "Download",
    retry: "Retry",
    back: "Back to chat",
    emptyMedia: "No media yet",
    emptyFilms: "No exported videos yet",
    emptyHistory: "No chats yet",
    plan: "Edit plan",
    voice: "Narration script",
    audio: "Audio track",
    image: "Generated image",
    video: "Exported video",
    all: "All",
    videos: "Videos",
    images: "Images",
    audios: "Audio",
    model: "Chat model",
    modelLocked: "Switch after the current task finishes.",
    language: "Language",
    background: "Chat background",
    default: "Default",
    landscape: "Warm landscape",
    custom: "Local image",
    reset: "Reset",
    visitorHint: "Your chats, media and exports are private to this account.",
    unconfigured: "No model is configured. Set one up in the admin console.",
    legalDraft: "Local prototype notice · final terms require operator review before launch",
    viewTimeline: "View timeline",
    makeVideo: "Export in chat",
  },
} as const;
const menuPages: Page[] = [
  "chat",
  "media",
  "avatars",
  "films",
  "history",
  "credits",
  "profile",
  "settings",
];
const hints = {
  "zh-CN": [
    "把素材剪成 15 秒竖屏短片，节奏轻快",
    "生成阳光开场特效视频，标题「去看更大的世界」",
    "写一段温柔的口播，并生成独立音频",
    "生成一张暖色调的封面图",
    "生成一个从浅入深讲解损失函数变迁史的教学视频",
    "搜索轻快的 BGM",
  ],
  "en-US": [
    "Make a lively 15-second vertical video",
    "Create an HTML effect video with the Sunny Opening template",
    "Write warm narration and generate audio",
    "Create a warm-toned cover image",
    "Search for upbeat background music",
  ],
};
function duration(value?: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
function date(value: string, locale: Locale) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
function mediaKindLabel(kind: MediaItem["kind"], locale: Locale) {
  if (locale === "en-US") return kind === "video" ? "Video" : kind === "image" ? "Image" : "Audio";
  return kind === "video" ? "视频" : kind === "image" ? "图片" : "音频";
}
async function getState(response: Response): Promise<AppState> {
  let json: (AppState & { error?: string }) | undefined;
  try {
    json = await response.json();
  } catch {
    /* handled below */
  }
  if (!response.ok)
    throw Object.assign(new Error(json?.error || `请求失败 (${response.status})`), { status: response.status });
  if (!json?.sessions || !json?.media)
    throw new Error("服务返回的数据不完整。");
  return json;
}
async function api(url: string, method = "GET", body?: unknown) {
  return getState(
    await fetch(apiPath(url), {
      method,
      headers:
        body === undefined || body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }),
  );
}
function Visual({ item }: { item: MediaItem }) {
  if (item.kind === "image")
    return <img src={item.url} alt={item.name} loading="lazy" />;
  if (item.kind === "video")
    return (
      <video
        src={item.url}
        muted
        playsInline
        preload="metadata"
        aria-label={item.name}
      />
    );
  return (
    <span className="music-visual">
      <Music2 size={22} />
    </span>
  );
}
function ClipVisual({ item, start }: { item: MediaItem; start: number }) {
  const thumbnail = item.kind === "video" ? item.shots?.find((shot) => start >= shot.start - 0.05 && start < shot.end - 0.05)?.thumbnailUrl : undefined;
  return thumbnail ? <img src={thumbnail} alt={`${item.name} ${duration(start)}`} loading="lazy" /> : <Visual item={item} />;
}
function JobCard({
  job,
  locale,
  retry,
}: {
  job: Job;
  locale: Locale;
  retry: (id: string) => void;
}) {
  const t = labels[locale];
  const name =
    job.kind === 'avatar' ? (locale === 'zh-CN' ? '作者形象动画' : 'Author animation')
      : job.workflow?.some(e=>e.tool==='discover_hot_topics') && job.kind==='plan' ? (locale==='zh-CN'?'热点选题研究':'Hot topic research')
      : job.kind === "understanding" ? (locale === "zh-CN" ? "原声音频理解" : "Audio understanding")
      : job.kind === "review" ? (locale === "zh-CN" ? "成片审查" : "Render review")
      : job.kind === "music"
      ? locale === "zh-CN" ? "BGM 搜索" : "Music search"
      : job.kind === "plan"
      ? t.plan
      : job.kind === "audio"
        ? t.audio
        : job.kind === "image"
          ? t.image
          : t.video;
  const status =
    job.status === "queued"
      ? locale === "zh-CN"
        ? "排队中"
        : "Queued"
      : job.status === "running"
        ? locale === "zh-CN"
          ? "生成中"
          : "Generating"
        : job.status === "failed"
          ? locale === "zh-CN"
            ? "生成失败"
            : "Failed"
          : locale === "zh-CN"
            ? "已完成"
            : "Done";
  if (job.status === "succeeded") {
    return (
      <details className="job-card succeeded job-complete">
        <summary className="job-head">
          <span className="job-icon"><Sparkles size={15} /></span>
          <strong>{name}</strong>
          <span className="job-status">{status}</span>
          <ChevronDown size={15} className="disclosure-chevron" aria-hidden="true" />
        </summary>
        <p className="job-complete-detail">
          {locale === "zh-CN" ? "任务记录已收起，生成结果见对话中的回复与作品。" : "The task record is collapsed. See the reply and output in this chat."}
        </p>
        <WorkflowTrace events={job.workflow} />
      </details>
    );
  }
  return (
    <div className={`job-card ${job.status}`} aria-live="polite">
      <div className="job-head">
        <span className="job-icon">
          <Sparkles size={16} />
        </span>
        <strong>{name}</strong>
        <span className="job-status">{status}</span>
      </div>
      {job.stage ? <p className="workflow-stage">{job.stage}{job.workflow?.length ? ` · ${job.workflow.filter((e) => e.status === "succeeded").length} 个步骤已完成` : ''}</p> : null}
      <WorkflowTrace events={job.workflow} />
      {job.status === "queued" || job.status === "running" ? (
        <div
          className="progress-track"
          role="progressbar"
          aria-label={status}
          aria-valuenow={job.progress || 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            style={{
              width: `${Math.max(5, Math.min(100, job.progress || 5))}%`,
            }}
          />
        </div>
      ) : null}
      {job.status === "failed" ? (
        <div className="job-error">
          <span>{job.error || status}</span>
          <button type="button" onClick={() => retry(job.id)}>
            <RotateCcw size={14} />
            {t.retry}
          </button>
        </div>
      ) : null}
    </div>
  );
}
function ArtifactCard({
  artifact,
  locale,
  open,
  add,
  repair,
}: {
  artifact: Artifact;
  locale: Locale;
  open: (artifact: Artifact) => void;
  add?: (artifact: Artifact) => void;
  repair?: () => void;
}) {
  const t = labels[locale];
  if(artifact.kind==='game')return <div className="artifact-card game-card"><h3>{artifact.name.replace(/\.zip$/,'')}</h3><CreativeGamePreview endpoint={artifact.url}/><p>Defold · 编译、试玩与模型自检通过，待审阅</p><a className="artifact-download" href={artifact.projectUrl} download>下载可编辑工程</a></div>;
  if (artifact.kind === "audio")
    return (
      <div className="artifact-card audio-card">
        {artifact.text ? (
          <div className="narration-block">
            <h3>{t.voice}</h3>
            <p>{artifact.text}</p>
          </div>
        ) : null}
        <div className="audio-title">
          <span>
            <Music2 size={19} />
          </span>
          <strong>
            {t.audio}
            <small>{artifact.name}</small>
          </strong>
        </div>
        <audio
          controls
          preload="metadata"
          src={artifact.url}
          aria-label={artifact.name}
        />
        <a
          className="artifact-download"
          href={artifact.downloadUrl}
          download={artifact.name}
        >
          <ArrowDownToLine size={16} />
          {t.download}
        </a>
      </div>
    );
  if (artifact.kind === "image")
    return (
      <div className="artifact-card image-card">
        <button
          type="button"
          className="artifact-visual"
          onClick={() => open(artifact)}
        >
          <img src={artifact.url} alt={artifact.name} loading="lazy" />
        </button>
        <div className="artifact-caption">
          <span>
            <ImageIcon size={16} />
            {artifact.name}
          </span>
          <a
            href={artifact.downloadUrl}
            download={artifact.name}
            aria-label={t.download}
          >
            <ArrowDownToLine size={18} />
          </a>
        </div>
        {artifact.mediaId && add ? (
          <button
            type="button"
            className="artifact-add"
            onClick={() => add(artifact)}
          >
            <Plus size={15} />
            {locale === "zh-CN" ? "加入当前对话" : "Add to chat"}
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="artifact-card video-card" data-format={artifact.format}>
      <button
        type="button"
        className="artifact-visual"
        onClick={() => open(artifact)}
        aria-label={`${locale === "zh-CN" ? "预览并编辑" : "Preview and edit"} ${artifact.name}`}
      >
        <video
          src={artifact.url}
          poster={artifact.coverUrl}
          muted
          playsInline
          preload="metadata"
          aria-label={artifact.name}
        />
        <span className="play-mark">
          <Play size={23} fill="currentColor" />
        </span>
      </button>
      <div className="artifact-caption">
        <span>
          <Film size={16} />
          {artifact.name}
        </span>
        <a
          href={artifact.downloadUrl}
          download={artifact.name}
          aria-label={t.download}
        >
          <ArrowDownToLine size={18} />
        </a>
      </div>
      {artifact.plan?.lesson ? <details className="editorial-report">
        <summary>教学脚本与来源 · {artifact.plan.lesson.chapters.length} 章</summary>
        <strong>{artifact.plan.lesson.title}</strong>
        <p>{artifact.plan.lesson.arc}</p>
        <p>学习目标：{artifact.plan.lesson.objectives.join('；')}</p>
        {artifact.plan.lesson.factReview?<p>脚本事实审查：{artifact.plan.lesson.factReview.score}/100 · {artifact.plan.lesson.factReview.needsRepair?'仍需修复':'通过'}{artifact.plan.lesson.factReview.adjudication?` · 独立复核 ${artifact.plan.lesson.factReview.adjudication.modelId}，首轮 ${artifact.plan.lesson.factReview.adjudication.primaryScore}/100` : ''}</p>:null}
        {artifact.plan.lesson.factReview?.suggestions?.map((s,i)=><small key={i}>改进建议：{s}</small>)}
        {artifact.plan.lesson.chapters.map((chapter,index)=><article key={chapter.id}>
          <strong>{index+1}. {chapter.title}</strong><small>HTML / GSAP · {chapter.duration?.toFixed(2)}秒 · 旁白匹配 {Math.round((chapter.speechMatch||0)*100)}%</small>
          <p>目标：{chapter.goal}</p><blockquote>{chapter.narration}</blockquote><p>编排理由：{chapter.reason}</p>
          <small>图解：{chapter.visual.takeaway} · 前置章节：{chapter.prerequisites.join('、')||'无'}</small>
          {chapter.claims.map((claim,i)=><p key={i}><small>{claim.basis==='calculation'?'数学定义与课堂演算':claim.basis==='synthesis'?'教学归纳':'文献事实'}：{claim.text}{claim.explanation?` · ${claim.explanation}`:''}</small></p>)}
          {chapter.referenceIds.map(id=>{const ref=artifact.plan!.lesson!.references.find(r=>r.id===id);return ref?<a key={id} href={ref.url} target="_blank" rel="noreferrer">[{id}] {ref.title}</a>:null;})}
        </article>)}
        <a href={artifact.downloadUrl.replace('/api/download/', '/api/artifacts/') + '/edit-report'} download>下载教学制作记录 JSON</a>
        {artifact.plan.lesson.limitations.map((s,i)=><small key={i}>{s}</small>)}
      </details> : null}
      {artifact.plan?.reconstruction ? <details className="editorial-report">
        <summary>重构脚本与补充来源 · {artifact.plan.reconstruction.beats.length} 段</summary>
        <strong>{artifact.plan.reconstruction.premise}</strong>
        <p>{artifact.plan.reconstruction.arc}</p>
        <p>风格：{artifact.plan.reconstruction.style}</p>
        {artifact.plan.reconstruction.beats.map((beat,index)=><article key={beat.id}>
          <strong>{index+1}. {beat.role} · {beat.mode==='original'?'真人原话':'新增台词 · 参考声音合成'}</strong>
          <small>{beat.evidence?`${beat.evidence.sourceName} · ${beat.evidence.start.toFixed(2)}–${beat.evidence.end.toFixed(2)} 秒`:`实测配音 ${beat.duration?.toFixed(2)} 秒`} · {beat.visual==='html'?'HTML信息图':'真人画面'}</small>
          <blockquote>{beat.line}</blockquote><p>选择理由：{beat.reason}</p>
          {beat.referenceIds.map(id=>{const ref=artifact.plan!.reconstruction!.references.find(r=>r.id===id);return ref?<a key={id} href={ref.url} target="_blank" rel="noreferrer">[{id}] {ref.title}</a>:null;})}
        </article>)}
        <a href={artifact.downloadUrl.replace('/api/download/', '/api/artifacts/') + '/edit-report'} download>下载剪辑记录 JSON</a>
        {artifact.plan.reconstruction.limitations.map((s,i)=><small key={i}>{s}</small>)}
      </details> : null}
      {artifact.template ? <details className="template-delivery">
        <summary>{artifact.template.name} · {artifact.template.panels}图同屏 · 待审阅</summary>
        <p>{artifact.template.boundary}</p>
        <small>模板 v{artifact.template.version} · {artifact.template.technicalPassed ? '技术检查通过' : '待检查'} · 用户验收待确认</small>
        {artifact.projectUrl ? <a href={artifact.projectUrl} download>下载可编辑工程 ZIP</a> : null}
        {artifact.coverUrl ? <a href={artifact.coverUrl} download>下载封面</a> : null}
        {artifact.template.basis.map(url=><a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
      </details> : null}
      {artifact.plan?.editorial ? <details className="editorial-report">
        <summary>叙事脚本与分镜依据 · {artifact.plan.editorial.scenes.length} 段</summary>
        <strong>{artifact.plan.editorial.script.premise}</strong>
        <p>{artifact.plan.editorial.script.arc}</p>
        <p>风格：{artifact.plan.editorial.script.style}</p>
        {artifact.plan.editorial.script.beats.map((beat, index) => {
          const scene = artifact.plan!.editorial!.scenes.find((s) => s.id === beat.sceneId)!;
          return <article key={beat.sceneId}><strong>{index + 1}. {beat.intent}</strong><small>{scene.sourceName} · {scene.start.toFixed(2)}–{scene.end.toFixed(2)} 秒</small><blockquote>{scene.quote}</blockquote><p>选择理由：{scene.reason}</p><small>{beat.graphic === 'none' ? '保留原画面' : `绘制动效：${beat.label}`} · {scene.visual?.observations}</small></article>;
        })}
        <a href={artifact.downloadUrl.replace('/api/download/', '/api/artifacts/') + '/edit-report'} download>下载剪辑记录 JSON</a>
        <small>源时间码为模型估计；画面分析基于分镜抽帧。</small>
      </details> : null}
      {artifact.plan?.lesson&&artifact.review?.status==='needs-review'&&repair?<button type="button" className="ghost-button" onClick={repair}>{locale==='zh-CN'?'修复并重新审查':'Repair and review again'}</button>:null}
      {artifact.review ? <details className="render-review">
        <summary>{locale === "zh-CN" ? "成片审查" : "Review"} · {artifact.review.score===0&&!artifact.review.semantic?(locale==='zh-CN'?'审查未完成':'Review incomplete'):`${artifact.review.score}/100`} · {artifact.review.status === 'passed' ? (locale === "zh-CN" ? '检查通过' : 'Passed') : (locale === "zh-CN" ? '需要复核' : 'Needs review')}</summary>
        {artifact.review.audio ? <section className="sound-review" aria-label={locale === 'zh-CN' ? '声音检查' : 'Sound checks'}>
          <strong>{locale === 'zh-CN' ? '声音检查' : 'Sound checks'}</strong>
          <p>{locale === 'zh-CN' ? '段间响度极差' : 'Segment loudness spread'}：{artifact.review.audio.segmentSpreadLu ?? '—'} LU</p>
          {artifact.review.checks.filter(check => /分段人声|段落衔接|段内音量|声音峰值|参考音色|段落音色|声音审听/.test(check.name)).map(check => <details key={check.name} className="sound-check" data-passed={check.passed}>
            <summary>{check.passed ? '✓' : '△'} {check.name} · {check.passed ? (locale === 'zh-CN' ? '通过' : 'Passed') : (locale === 'zh-CN' ? '未通过' : 'Failed')}</summary>
            <p>{check.detail}</p>
          </details>)}
          {artifact.review.audio.userReportedMismatch ? <p className="sound-feedback">{locale === 'zh-CN' ? '你已反馈音色不似。仍使用被拒绝的合成声音时，音色检查不能通过。' : 'Your voice mismatch feedback applies to this audio. Re-exporting the same synthesis cannot pass the voice checks.'}</p> : null}
        </section> : null}
        {artifact.review.checks.filter(check => !artifact.review!.audio || !/分段人声|段落衔接|段内音量|声音峰值|参考音色|段落音色|声音审听/.test(check.name)).map((check) => <p key={check.name}>{check.passed ? '✓' : '△'} {check.name}：{check.detail}</p>)}
        {artifact.review.semantic?.suggestions?.map((suggestion,index)=><p key={`suggestion-${index}`}>{locale==='zh-CN'?'改进建议':'Suggestion'}：{suggestion}</p>)}
        {artifact.review.limitations.map((detail) => <small key={detail}>{detail}</small>)}
      </details> : null}
    </div>
  );
}
function Message({
  message,
  state,
  locale,
  retry,
  open,
  add,
}: {
  message: ChatMessage;
  state: AppState;
  locale: Locale;
  retry: (id: string) => void;
  open: (artifact: Artifact) => void;
  add: (artifact: Artifact) => void;
}) {
  const replyForJob = message.role === "user" && message.jobId ? state.sessions.some(s=>s.messages.some(m=>m.role==='assistant'&&m.jobId===message.jobId)) : false;
  const job = state.jobs.find(x=>x.id===message.jobId);
  const jobs = message.role==='assistant' ? (job?[job]:[]) : replyForJob?[]:state.jobs.filter(x=>x.messageId===message.id);
  const artifacts = message.role==='assistant' && job ? state.artifacts.filter(x=>x.messageId===job.messageId) : replyForJob?[]:state.artifacts.filter(x=>x.messageId===message.id);
  const attachments = (message.attachmentIds || [])
    .map((id) => state.media.find((x) => x.id === id))
    .filter((x): x is MediaItem => Boolean(x));
  const createdAt = new Date(message.createdAt);
  const timestamp = Number.isFinite(createdAt.getTime()) ? messageTimeFormatters[locale].format(createdAt) : null;
  return (
    <article className={`message-row ${message.role}`}>
      {message.role === "assistant" ? (
        <span className="avatar assistant-avatar">
          <Sparkles size={16} fill="currentColor" />
        </span>
      ) : null}
      <div className="message-main">
        {message.role==='assistant' ? <AssistantReply message={message} job={job} locale={locale}/> : message.text ? (
          <div className="message-bubble">{message.text}</div>
        ) : null}
        {attachments.length ? (
          <div className="sent-attachments">
            {attachments.map((item) => (
              <div key={item.id}>
                <Visual item={item} />
                <span>{item.name}</span>
              </div>
            ))}
          </div>
        ) : null}
        {timestamp ? <time className="message-time" dateTime={message.createdAt} title={`${timestamp} (${messageTimeFormatters[locale].resolvedOptions().timeZone})`}>{timestamp}</time> : null}
        {message.research?<HotResearchCard research={message.research}/>:null}
        {message.musicSearch ? (
          <div className="music-search-card">
            <div className="music-search-heading">
              <Music2 size={18} />
              <strong>{locale === "zh-CN" ? "站内搜索 BGM" : "Find background music"}</strong>
              <span>{message.musicSearch.query}</span>
            </div>
            <div className="music-source-list">
              {message.musicSearch.sources.map((source) => (
                <a key={source.name} href={source.url} target="_blank" rel="noopener noreferrer">
                  <span><b>{source.name}</b><small>{source.note}</small></span>
                  <ArrowRight size={17} />
                </a>
              ))}
            </div>
            <p>{locale === "zh-CN" ? "在原站下载并确认使用权后，回到轻剪上传音频；随后通过对话指定为 BGM。" : "Download from the source, check usage rights, then upload the audio and choose it in chat."}</p>
          </div>
        ) : null}
        {jobs.filter(job=>job.status!=='succeeded'||!message.parts?.length).map((job) => (
          <JobCard key={job.id} job={job} locale={locale} retry={retry} />
        ))}
        {artifacts.map((artifact) => (
          <ArtifactCard
            key={artifact.id}
            artifact={artifact}
            locale={locale}
            open={open}
            add={add}
            repair={job?.status==='succeeded'&&job.artifactId===artifact.id?()=>retry(job.id):undefined}
          />
        ))}
      </div>
      {message.role === "user" ? (
        <span className="avatar user-avatar">
          <UserRound size={16} />
        </span>
      ) : null}
    </article>
  );
}
export default function App({ user, onLogout }: { user: PublicUser; onLogout: () => Promise<void> }) {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>("chat");
  const [drawer, setDrawer] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [filter, setFilter] = useState<MediaFilter>(
    "all",
  );
  const [imagePreview, setImagePreview] = useState<Artifact | null>(null);
  const [mediaPreview, setMediaPreview] = useState<MediaItem | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<Artifact | null>(null);
  const [timelineCurrentPlan, setTimelineCurrentPlan] = useState(false);
  const [selectedClip, setSelectedClip] = useState(0);
  const [localBackground, setLocalBackground] = useState<string | null>(() =>
    localStorage.getItem(`qingjian-local-bg:${user.id}`),
  );
  const drafts = useRef<Record<string, { prompt: string; attachments: string[] }>>({});
  const stateRef = useRef<AppState | null>(null);
  const voiceAdmission = useRef<{ ticket: string; message: string; sessionId: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerKind = useRef<MediaFilter>("all");
  const pickerSource = useRef<"chat" | "library">("chat");
  const bgInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const chatScrollY = useRef(0);
  const visibleSessionId = useRef<string | null>(null);
  const chatAtBottom = useRef(true);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const apply = useCallback((next: AppState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const updateCredits = useCallback((wallet: CreditWallet) => {
    if (stateRef.current) apply({ ...stateRef.current, credits: wallet });
  }, [apply]);
  const refresh = useCallback(async () => {
    try {
      apply(await api("/api/state"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接服务。");
    }
  }, [apply]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const stateReady = Boolean(state);
  const hasActiveJobs = state?.jobs.some(isActiveJob) ?? false;
  useEffect(() => {
    if (!state?.credits) return;
    const controller = new AbortController();
    const update = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await fetchCredits(apiPath('/api/credits'), controller.signal);
        if (stateRef.current && !controller.signal.aborted) apply({ ...stateRef.current, credits: result.wallet });
      } catch { /* Keep the last balance; the server still enforces admission. */ }
    };
    const timer = window.setTimeout(() => void update(), Math.max(1000, Date.parse(state.credits.nextCheckInAt) - Date.now() + 1000));
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [state?.credits?.nextCheckInAt, apply]);
  useEffect(() => {
    if (!stateReady) return;
    const controller = new AbortController();
    let inFlight = false;
    const sync = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(apiPath('/api/state'), { signal: controller.signal });
        if (response.ok) {
          const next = await response.json() as AppState;
          if (!controller.signal.aborted) apply(next);
        }
      } catch {
        /* Preserve the current view while the connection recovers. */
      } finally {
        inFlight = false;
      }
    };
    // Other clients can start tasks while this H5 view is idle. Keep the
    // shared account current, and refresh immediately when it returns.
    const timer = window.setInterval(() => void sync(), hasActiveJobs ? 2200 : 30_000);
    const foreground = () => void sync();
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      controller.abort(); window.clearInterval(timer);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [stateReady, hasActiveJobs, user.id, apply]);
  useEffect(() => {
    if (!drawer) return;
    window.history.pushState({ qingjianDrawer: true }, "");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(false);
    };
    const onBack = () => setDrawer(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onBack);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onBack);
      if (window.history.state?.qingjianDrawer) window.history.back();
    };
  }, [drawer]);
  const locale: Locale = state?.settings.language || "zh-CN";
  const t = labels[locale];
  const session = state?.sessions.find((s) => s.id === state.activeSessionId);
  const activeSessionJobs = state?.jobs.filter(job => job.sessionId === session?.id && isActiveJob(job)) || [];
  const sessionRunning = activeSessionJobs.length > 0;
  const textModels = state?.models.filter(model => model.kind === 'text' && model.enabled) || [];
  const sessions = state?.sessions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) || [];
  const sessionTitle = (item: Session) =>
    item.title === "新对话" || item.title === "新会话" ? t.newChat : item.title;
  const sessionPreview = (item: Session) =>
    item.messages.at(-1)?.text ||
    (locale === "zh-CN" ? "开始对话，创建这个主题" : "Start chatting in this topic");
  const lastReply = session?.messages.at(-1);
  const replySize = lastReply?.parts?.reduce((total,part)=>total+part.text.length,0) || 0;
  useLayoutEffect(() => {
    if (page !== "chat" || !chatScroll.current || !state?.activeSessionId) return;
    const view = chatScroll.current;
    view.scrollTop = visibleSessionId.current === state.activeSessionId
      ? chatScrollY.current
      : view.scrollHeight;
    visibleSessionId.current = state.activeSessionId;
  }, [page, state?.activeSessionId]);
  useLayoutEffect(() => {
    if (page === "chat" && chatAtBottom.current && chatScroll.current) {
      chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
    }
  }, [page, session?.messages.length, lastReply?.text.length, replySize]);
  const artifacts =
    state?.artifacts.filter((a) => a.sessionId === session?.id) || [];
  const latestVideo =
    artifacts.filter((a) => a.kind === "video").at(-1) || null;
  const background =
    state?.settings.chatBackground === "local"
      ? localBackground
      : state?.settings.chatBackground;
  function nav(next: Page) {
    setDrawer(false);
    setPage(next);
    setError("");
  }
  async function mutate(url: string, method: string, body?: unknown) {
    setPending(true);
    setError("");
    try {
      apply(await api(url, method, body));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      if ((cause as { status?: number })?.status === 402) {
        try { const credits = await fetchCredits(apiPath('/api/credits')); if (stateRef.current) apply({ ...stateRef.current, credits: credits.wallet }); } catch { /* Keep the insufficient-credit message. */ }
      }
      return false;
    } finally {
      setPending(false);
    }
  }
  function openFilePicker(kind: MediaFilter = "all", source: "chat" | "library" = "chat") {
    pickerKind.current = kind;
    pickerSource.current = source;
    if (!fileInput.current) return;
    fileInput.current.accept = mediaAccept[kind];
    fileInput.current.click();
  }
  function upload(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    const expectedKind = pickerKind.current;
    const source = pickerSource.current;
    if (
      selected.some(
        (f) => !f.type.startsWith("video/") && !f.type.startsWith("image/") && !f.type.startsWith("audio/"),
      )
    ) {
      setError(
        locale === "zh-CN"
          ? "只支持视频、图片和音频。"
          : "Only videos, images and audio are supported.",
      );
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    if (expectedKind !== "all" && selected.some((file) => !file.type.startsWith(`${expectedKind}/`))) {
      setError(locale === "zh-CN" ? `当前分类只允许添加${mediaKindLabel(expectedKind, locale)}文件。` : `Only ${mediaKindLabel(expectedKind, locale).toLowerCase()} files can be added here.`);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const oversized = selected.find((file) => file.size > MAX_MEDIA_UPLOAD_BYTES);
    if (oversized) {
      setError(locale === "zh-CN" ? `「${oversized.name}」超过 100 MB，请先压缩再上传。` : `"${oversized.name}" exceeds 100 MB. Compress it before uploading.`);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const oldIds = new Set(stateRef.current?.media.map((m) => m.id) || []);
    const form = new FormData();
    selected.forEach((f) => form.append("files", f));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiPath("/api/media"));
    setError("");
    setUploadProgress(0);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploadProgress(null);
      try {
        const result = JSON.parse(xhr.responseText) as AppState & {
          error?: string;
        };
        if (xhr.status < 200 || xhr.status >= 300)
          throw new Error(result.error || "上传失败。");
        apply(result);
        if (source === "chat") {
          setAttachments((ids) => [
            ...new Set([...ids, ...result.media.filter((m) => !oldIds.has(m.id)).map((m) => m.id)]),
          ]);
          nav("chat");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "上传失败。");
      }
    };
    xhr.onerror = () => {
      setUploadProgress(null);
      setError("网络中断，上传失败。");
    };
    xhr.send(form);
    if (fileInput.current) fileInput.current.value = "";
  }
  async function send(voiceText?: string, creditTicket?: string) {
    const message = voiceText === undefined ? prompt.trim() : [prompt.trim(), voiceText.trim()].filter(Boolean).join('\n');
    if (
      !message ||
      !state ||
      pending ||
      (voiceBusy && voiceText === undefined) ||
      uploadProgress !== null
    )
      return false;
    if (voiceText !== undefined) setPrompt(message);
    if (creditTicket) voiceAdmission.current = { ticket: creditTicket, message, sessionId: state.activeSessionId };
    const ticket = voiceAdmission.current?.message === message && voiceAdmission.current.sessionId === state.activeSessionId ? voiceAdmission.current.ticket : undefined;
    if (
      await mutate("/api/chat", "POST", {
        sessionId: state.activeSessionId,
        message,
        attachmentIds: attachments,
        ...(ticket ? { voiceTicket: ticket } : {}),
      })
    ) {
      delete drafts.current[state.activeSessionId];
      voiceAdmission.current = null;
      setPrompt("");
      setAttachments([]);
      requestAnimationFrame(() =>
        chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }),
      );
      return true;
    }
    return false;
  }
  async function newChat() {
    const previousId = stateRef.current?.activeSessionId;
    if (previousId) drafts.current[previousId] = { prompt, attachments };
    if (await mutate("/api/sessions", "POST", {})) {
      setPrompt("");
      setAttachments([]);
      nav("chat");
    }
  }
  async function activate(id: string) {
    const previousId = stateRef.current?.activeSessionId;
    if (id === previousId) {
      nav("chat");
      return;
    }
    if (previousId) drafts.current[previousId] = { prompt, attachments };
    if (
      await mutate(
        `/api/sessions/${encodeURIComponent(id)}/activate`,
        "POST",
        {},
      )
    ) {
      const draft = drafts.current[id];
      setPrompt(draft?.prompt || "");
      setAttachments(draft?.attachments.filter((mediaId) => stateRef.current?.media.some((item) => item.id === mediaId)) || []);
      nav("chat");
    }
  }
  async function remove(id: string) {
    if (
      !window.confirm(
        locale === "zh-CN"
          ? "删除素材后，关联的剪辑方案可能无法继续导出。确定删除吗？"
          : "Deleting this media may prevent export. Delete it?",
      )
    )
      return;
    if (await mutate(`/api/media/${encodeURIComponent(id)}`, "DELETE"))
      setAttachments((ids) => ids.filter((x) => x !== id));
  }
  function shortcut(text: string) {
    setPrompt(text);
    nav("chat");
    requestAnimationFrame(() => composerInput.current?.focus());
  }
  function insertLineBreak() {
    const input = composerInput.current;
    if (!input || input.disabled) return;
    const { value, selectionStart: start, selectionEnd: end } = input;
    if (value.length - (end - start) + 1 > input.maxLength) return;
    input.setRangeText("\n", start, end, "end");
    setPrompt(input.value);
    input.focus();
  }
  function open(artifact: Artifact) {
    if (artifact.kind === "video") {
      setSelectedVideo(artifact);
      setTimelineCurrentPlan(false);
      setSelectedClip(0);
      nav("timeline");
    } else setImagePreview(artifact);
  }
  function addArtifact(artifact: Artifact) {
    if (!artifact.mediaId) return;
    setAttachments((ids) =>
      ids.includes(artifact.mediaId!) ? ids : [...ids, artifact.mediaId!],
    );
    nav("chat");
    requestAnimationFrame(() => composerInput.current?.focus());
  }
  async function patch(settings: Partial<AppSettings> & { applyToCurrentSession?: boolean }) {
    await mutate("/api/settings", "PATCH", settings);
  }
  function backgroundFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 1024 * 1024) {
      setError("请选择不超过 1 MB 的图片。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      localStorage.setItem(`qingjian-local-bg:${user.id}`, value);
      setLocalBackground(value);
      void patch({ chatBackground: "local" });
    };
    reader.readAsDataURL(file);
    if (bgInput.current) bgInput.current.value = "";
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage("");
    setPasswordPending(true);
    try {
      const response = await fetch(apiPath("/api/auth/password"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "修改失败，请重试。");
      setCurrentPassword(""); setNewPassword("");
      setPasswordMessage(locale === "zh-CN" ? "密码已更新。" : "Password updated.");
    } catch (cause) { setPasswordMessage(cause instanceof Error ? cause.message : "修改失败。"); }
    finally { setPasswordPending(false); }
  }
  const plan = session?.plan;
  const timelineArtifact = timelineCurrentPlan ? null : selectedVideo || latestVideo;
  const timelinePlan = timelineArtifact ? timelineArtifact.plan : plan;
  const clip = timelinePlan?.clips[selectedClip];
  const clipSource = state?.media.find((m) => m.id === clip?.sourceId);
  const timelineUrl = timelineArtifact?.url || clipSource?.url;
  return (
    <div className="page-backdrop">
      <main className="app-shell">
        <header className="topbar">
          {page === "chat" ? (
            <button
              type="button"
              className="brand"
              onClick={() => setDrawer(true)}
              aria-label="打开菜单"
            >
              轻剪<span>.</span>
              <Menu size={17} />
            </button>
          ) : (
            <button
              type="button"
              className="top-back"
              onClick={() =>
                nav(
                  page === "terms" || page === "privacy" ? "settings" : "chat",
                )
              }
              aria-label={t.back}
            >
              <ArrowLeft size={23} />
            </button>
          )}
          {page !== "chat" ? <h1 className="page-title">{t[page]}</h1> : null}
          {page === "chat" ? (
            <button
              type="button"
              className="top-history"
              onClick={() => nav("history")}
            >
              <Clock3 size={19} />
              {t.history}
            </button>
          ) : page === "history" ? (
            <button
              type="button"
              className="top-plus"
              onClick={() => void newChat()}
              aria-label={t.newChat}
            >
              <Plus size={22} />
            </button>
          ) : (
            <span className="top-spacer" />
          )}
        </header>
        {page !== "chat" && error ? (
          <div className="subpage-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
        ) : null}
        {page === "chat" ? (
          <>
            <div
              className="chat-scroll"
              ref={chatScroll}
              onScroll={(event) => {
                const view = event.currentTarget;
                chatScrollY.current = view.scrollTop;
                chatAtBottom.current = view.scrollHeight - view.clientHeight - view.scrollTop < 80;
              }}
              style={
                background
                  ? {
                      backgroundImage: `linear-gradient(#fffdfadd,#fffdfadd),url(${background})`,
                    }
                  : undefined
              }
            >
              {!state ? (
                <div className="loading-state" role="status">
                  <Sparkles size={23} />
                  {locale === "zh-CN" ? "正在加载对话…" : "Loading chat…"}
                </div>
              ) : null}
              {state && !session?.messages.length ? (
                <section className="chat-empty">
                  <div className="empty-sparkle">
                    <Sparkles size={29} fill="currentColor" />
                  </div>
                  <h1>{t.hero}</h1>
                  <p>{t.sub}</p>
                  <div className="suggestions">
                    {hints[locale].map((hint, index) => (
                      <button
                        type="button"
                        key={hint}
                        onClick={() => shortcut(hint)}
                      >
                        {index === 0 ? (
                          <Film size={18} />
                        ) : index === 1 ? (
                          <WandSparkles size={18} />
                        ) : index === 2 ? (
                          <Mic2 size={18} />
                        ) : index === 3 ? (
                          <ImageIcon size={18} />
                        ) : (
                          <Music2 size={18} />
                        )}
                        <span>{hint}</span>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="add-media-inline"
                    onClick={() => openFilePicker()}
                  >
                    <Plus size={18} />
                    {t.add}
                  </button>
                </section>
              ) : null}
              {session?.messages.length ? (
                <section className="message-list" aria-label={t.chat}>
                  {session.messages.map((message) => (
                    <Message
                      key={message.id}
                      message={message}
                      state={state!}
                      locale={locale}
                      retry={(id) =>
                        void mutate(`/api/jobs/${id}/retry`, "POST", {})
                      }
                      open={open}
                      add={addArtifact}
                    />
                  ))}
                </section>
              ) : null}
              {plan ? (
                <details className="plan-card" key={`${session?.id}:${plan.version ?? plan.summary}`}>
                  <summary className="plan-summary">
                    <span className="plan-summary-icon"><Film size={18} /></span>
                    <span className="plan-summary-copy">
                      <strong>{t.plan} · {plan.clips.length} {locale === "zh-CN" ? "个片段" : "clips"}</strong>
                      <small>{plan.summary}</small>
                    </span>
                    <span className="format-chip">{plan.format}</span>
                    <ChevronDown size={16} className="disclosure-chevron" aria-hidden="true" />
                  </summary>
                  <div className="plan-content">
                  <p className="timeline-track-summary">{locale === "zh-CN" ? `字幕 ${plan.captions?.length || 0} 条 · 覆盖层 ${plan.overlays?.length || 0} 条 · ${plan.fineCut ? '完整句精剪' : '片段剪辑'}` : `${plan.captions?.length || 0} captions · ${plan.overlays?.length || 0} overlays`}</p>
                  {plan.coverMediaId ? (
                    <div className="plan-cover">
                      <img src={state?.media.find((item) => item.id === plan.coverMediaId)?.url} alt="成片封面" />
                      <span>{locale === "zh-CN" ? "当前封面" : "Current cover"}</span>
                    </div>
                  ) : null}
                  {plan.editorial ? <p className="editorial-premise">叙事：{plan.editorial.script.arc}<br />风格：{plan.editorial.script.style} · 绘制动效 {plan.motions?.length || 0} 段</p> : null}
                  <div className="clip-strip">
                    {plan.clips.map((part, index) => {
                      const source = state?.media.find(
                        (m) => m.id === part.sourceId,
                      );
                      return (
                        <button
                          type="button"
                          className="clip-card"
                          key={`${part.sourceId}-${index}`}
                          onClick={() => {
                            setSelectedClip(index);
                            setSelectedVideo(null);
                            setTimelineCurrentPlan(true);
                            nav("timeline");
                          }}
                        >
                          <span className="clip-visual">
                            {source ? (
                              <ClipVisual item={source} start={part.start} />
                            ) : (
                              <Film size={22} />
                            )}
                            <b>{index + 1}</b>
                          </span>
                          <span>{source?.name || `片段 ${index + 1}`}</span>
                          <small>{duration(part.end - part.start)}</small>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="plan-open"
                    onClick={() => {
                      setSelectedVideo(null);
                      setTimelineCurrentPlan(true);
                      nav("timeline");
                    }}
                  >
                    {t.viewTimeline}
                    <ChevronRight size={17} />
                  </button>
                  </div>
                </details>
              ) : null}
              <div ref={chatEnd} />
            </div>
            <form
              className="composer-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {state?.mode === "unconfigured" ? (
                <div className="model-warning">
                  <Settings2 size={14} />
                  {t.unconfigured}
                </div>
              ) : null}
              {uploadProgress !== null ? (
                <div className="upload-progress" role="status">
                  {locale === "zh-CN" ? "上传素材" : "Uploading"} ·{" "}
                  {uploadProgress}%
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
              ) : null}
              {error ? (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setError("")}
                    aria-label="关闭"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : null}
              <div className="composer">
                {state?.credits ? <button type="button" className={`credit-chip${state.credits.balance <= 0 ? ' is-low' : ''}`} onClick={() => nav('credits')}>
                  {locale === 'zh-CN' ? `积分 ${formatPoints(state.credits.balance)}` : `${formatPoints(state.credits.balance)} points`}
                  {state.credits.balance <= 0 ? locale === 'zh-CN' ? ' · 积分不足，查看签到奖励' : ' · Low balance; view daily gift' : ''}
                </button> : null}
                {attachments.length ? (
                  <div className="composer-attachments">
                    {attachments.map((id) => {
                      const item = state?.media.find((m) => m.id === id);
                      return item ? (
                        <div className="composer-attachment" key={id}>
                          <Visual item={item} />
                          <span>
                            {item.name}
                            <small>
                              {locale === "zh-CN" ? "本地素材" : "Local media"}
                            </small>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setAttachments((ids) =>
                                ids.filter((x) => x !== id),
                              )
                            }
                            aria-label={`移除 ${item.name}`}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : null;
                    })}
                  </div>
                ) : null}
                <TemplateMentionInput key={session?.id} templates={state?.templates||[]} value={prompt} onChange={setPrompt} inputRef={composerInput} disabled={voiceBusy} placeholder={t.input} rows={Math.min(5, Math.max(attachments.length ? 2 : 1, prompt.split("\n").length))} onSubmit={()=>void send()} selectedTemplateId={session?.templateId}/>
                <div className="composer-actions">
                  <button
                    type="button"
                    className="attach-button"
                    disabled={voiceBusy}
                    onClick={() => openFilePicker("image")}
                    aria-label={locale === "zh-CN" ? "添加图片" : "Add image"}
                  >
                    <ImagePlus size={21} />
                  </button>
                  <button
                    type="button"
                    className="library-button"
                    disabled={voiceBusy}
                    onClick={() => nav("media")}
                    aria-label={t.media}
                  >
                    <Library size={18} />
                  </button>
                  <button
                    type="button"
                    className="newline-button"
                    disabled={voiceBusy}
                    aria-label={locale === "zh-CN" ? "插入换行" : "Insert line break"}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={insertLineBreak}
                  >
                    <CornerDownLeft size={14} aria-hidden="true" />
                    {locale === "zh-CN" ? "换行" : "Newline"}
                  </button>
                  <VoiceInput
                    key={state?.activeSessionId}
                    locale={locale}
                    endpoint={apiPath('/api/voice/transcribe')}
                    prefix={prompt}
                    disabled={pending || uploadProgress !== null || !state || !!state.credits && state.credits.balance <= 0}
                    onBusyChange={setVoiceBusy}
                    onRecognized={async (text, ticket) => { if (!(await send(text, ticket))) throw new Error(locale === 'zh-CN' ? '指令未发送，识别文字已保留在输入框，请查看提示后重试。' : 'Instruction not sent. The transcript is kept in the input. Please check the notice and retry.'); }}
                  />
                  <button
                    type="submit"
                    className="send-button"
                    disabled={
                      pending ||
                      voiceBusy ||
                      uploadProgress !== null ||
                      !prompt.trim()
                    }
                    aria-label="发送"
                  >
                    <Send size={20} fill="currentColor" />
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : null}
        {page === 'avatars' && state ? <Suspense fallback={<p className="subpage-content">正在打开作者形象…</p>}><AvatarPanel state={state} pending={pending} error={error} mutate={mutate} openChat={() => nav('chat')} /></Suspense> : null}
        {page === "history" ? (
          <section className="subpage-content">
            <div className="history-intro">
              <strong>{locale === "zh-CN" ? "一个会话，一个创作主题" : "One conversation, one creative topic"}</strong>
              <p>{locale === "zh-CN"
                ? "切换主题后，继续沿用该会话的消息与剪辑方案；新会话从新的对话上下文开始。素材库在所有会话中可用。"
                : "Continue with this topic's messages and edit plan. A new conversation starts fresh; your media library remains available."}</p>
            </div>
            {sessions.length ? (
              <div className="history-list">
                {sessions.map((item) => (
                    <button
                      type="button"
                      className={`history-row ${item.id === state?.activeSessionId ? "active" : ""}`}
                      key={item.id}
                      onClick={() => void activate(item.id)}
                    >
                      <span className="history-icon">
                        <Sparkles size={18} />
                      </span>
                      <span>
                        <strong>{sessionTitle(item)}</strong>
                        <span className="history-preview">{sessionPreview(item)}</span>
                        <small>
                          {date(item.updatedAt, locale)} ·{" "}
                          {item.messages.length}{" "}
                          {locale === "zh-CN" ? "条消息" : "messages"}
                        </small>
                      </span>
                      {item.id === state?.activeSessionId
                        ? <em className="history-current">{locale === "zh-CN" ? "当前" : "Current"}</em>
                        : <ChevronRight size={17} />}
                    </button>
                  ))}
              </div>
            ) : (
              <div className="empty-state">
                <Clock3 size={28} />
                <h2>{t.emptyHistory}</h2>
                <button type="button" onClick={() => void newChat()}>
                  {t.newChat}
                </button>
              </div>
            )}
          </section>
        ) : null}
        {page === "media" ? (
          <section className="subpage-content">
            {uploadProgress !== null ? (
              <div className="upload-progress" role="status">
                {locale === "zh-CN" ? "上传素材" : "Uploading"} · {uploadProgress}%
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
            ) : null}
            {error ? (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError("")} aria-label="关闭"><X size={16} /></button>
              </div>
            ) : null}
            <div className="filter-tabs" role="tablist">
              {(["all", "video", "image", "audio"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  role="tab"
                  aria-selected={filter === value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {value === "all"
                    ? t.all
                    : value === "video"
                      ? t.videos
                      : value === "image"
                        ? t.images
                        : t.audios}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="add-row"
              onClick={() => openFilePicker(filter, "library")}
            >
              <Plus size={19} />
              {filter === "all" ? t.add : locale === "zh-CN" ? `添加${mediaKindLabel(filter, locale)}` : `Add ${mediaKindLabel(filter, locale).toLowerCase()}`}
            </button>
            {state?.media.filter((m) => filter === "all" || m.kind === filter)
              .length ? (
              <div className="media-list">
                {state.media
                  .filter((m) => filter === "all" || m.kind === filter)
                  .map((item) => (
                    <article className="library-item" key={item.id}>
                      <button
                        type="button"
                        className="library-preview"
                        onClick={() => setMediaPreview(item)}
                        aria-label={`预览 ${item.name}`}
                      >
                        <Visual item={item} />
                      </button>
                      <div>
                        <strong>{item.name}</strong>
                        <small>
                          {mediaKindLabel(item.kind, locale)} · {date(item.createdAt, locale)}
                        </small>
                        {item.kind !== 'image' ? <div className="transcript-actions">
                          <button type="button" disabled={!session || state.jobs.some((j) => j.kind === 'understanding' && ['queued','running'].includes(j.status) && session?.messages.some((m) => m.jobId === j.id && m.attachmentIds?.includes(item.id)))} onClick={() => void mutate(`/api/media/${item.id}/analyze`, 'POST', { sessionId: session?.id })}>{item.analysis ? (locale === 'zh-CN' ? '重新分析 / 读取缓存' : 'Analyze again') : (locale === 'zh-CN' ? '理解原声' : 'Understand audio')}</button>
                          {item.analysis ? <a href={apiPath(`/api/media/${item.id}/transcript`)} download>{locale === 'zh-CN' ? '下载逐字稿' : 'Download transcript'}</a> : null}
                        </div> : null}
                        {item.analysis ? <details className="transcript-detail"><summary>{item.analysis.status === 'no-audio' ? '无音轨' : `逐字稿 · ${item.analysis.sentences.length} 句`}</summary><p className="transcript-note">时间码为模型估计；停顿来自低音量检测。</p>{item.analysis.sentences.map((s) => <p key={s.id}><time>{duration(s.start)}–{duration(s.end)}</time> {s.text}{!s.complete ? '（未完整）' : ''}</p>)}</details> : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachments((ids) =>
                            ids.includes(item.id) ? ids : [...ids, item.id],
                          );
                          nav("chat");
                        }}
                        aria-label={`选择 ${item.name}`}
                      >
                        <Plus size={19} />
                      </button>
                      <button
                        type="button"
                        className="delete-media"
                        onClick={() => void remove(item.id)}
                        aria-label={`删除 ${item.name}`}
                      >
                        <Trash2 size={17} />
                      </button>
                    </article>
                  ))}
              </div>
            ) : (
              <div className="empty-state">
                <Library size={28} />
                <h2>{t.emptyMedia}</h2>
              </div>
            )}
          </section>
        ) : null}
        {page === "films" ? (
          <section className="subpage-content">
            {state?.jobs
              .filter((j) => j.kind === "export" && j.status !== "succeeded")
              .map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  locale={locale}
                  retry={(id) =>
                    void mutate(`/api/jobs/${id}/retry`, "POST", {})
                  }
                />
              ))}
            {state?.artifacts.some((a) => a.kind === "video") ? (
              <div className="film-list">
                {state.artifacts
                  .filter((a) => a.kind === "video")
                  .slice()
                  .reverse()
                  .map((item) => (
                    <div className="film-library-card" key={item.id}>
                      <ArtifactCard
                        artifact={item}
                        locale={locale}
                        open={open}
                      />
                      <div className="film-meta">
                        <strong className="film-title">{item.name}</strong>
                        <span>
                          V{item.version} · {duration(item.duration)} · {item.format || "—"}
                        </span>
                      </div>
                      <p className="film-session" title={state.sessions.find((session) => session.id === item.sessionId)?.title || ""}>
                        {state.sessions.find((session) => session.id === item.sessionId)?.title || t.chat}
                        {item.hasNarration ? (locale === "zh-CN" ? " · 口播" : " · Voice") : ""}
                        {item.hasBgm ? " · BGM" : ""}
                      </p>
                      <button type="button" className="film-back" onClick={() => void activate(item.sessionId)}>
                        {t.back}<ArrowRight size={15} />
                      </button>
                    </div>
                  ))}
              </div>
            ) : !state?.jobs.some((j) => j.kind === "export") ? (
              <div className="empty-state">
                <Film size={28} />
                <h2>{t.emptyFilms}</h2>
                <p>
                  {locale === "zh-CN"
                    ? "在对话中要求生成成片，完成后可在这里下载。"
                    : "Ask for an export in chat, then download it here."}
                </p>
                <button type="button" onClick={() => nav("chat")}>
                  {t.back}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
        {page === 'credits' && state?.credits ? <Suspense fallback={<p className="subpage-content">{locale === 'zh-CN' ? '正在打开我的积分…' : 'Opening credits…'}</p>}><CreditPage wallet={state.credits} endpoint={apiPath('/api/credits')} locale={locale} onWallet={updateCredits} /></Suspense> : null}
        {page === "settings" ? (
          <section className="subpage-content settings-page">
            {state?.credits ? <button type="button" className="setting-credit-link" onClick={() => nav('credits')}><Coins size={20} /><span><strong>{t.credits}</strong><small>{locale === 'zh-CN' ? '每日签到 · 领取积分 · 查看明细' : 'Daily gifts · balance · history'}</small></span><ChevronRight size={18} /></button> : null}
            <div className="setting-group">
              <h2>{t.model}</h2>
              <select
                value={session ? session.modelId || "" : state?.settings.defaultModelId || ""}
                disabled={pending || sessionRunning || !session || !textModels.length}
                onChange={(e) =>
                  void patch({ defaultModelId: e.target.value || null, applyToCurrentSession: true })
                }
                aria-label={t.model}
              >
                <option value="">
                  {locale === "zh-CN" ? "使用默认" : "Use default"}
                </option>
                {textModels.map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
              <p>
                {sessionRunning ? t.modelLocked : locale === "zh-CN"
                  ? "更改后从下一条消息起生效，也用于新对话。"
                  : "Applies to the next message and new chats."}
              </p>
            </div>
            <div className="setting-group">
              <h2>{t.language}</h2>
              <div className="choice-row">
                <button
                  type="button"
                  className={locale === "zh-CN" ? "selected" : ""}
                  onClick={() => void patch({ language: "zh-CN" })}
                >
                  简体中文
                </button>
                <button
                  type="button"
                  className={locale === "en-US" ? "selected" : ""}
                  onClick={() => void patch({ language: "en-US" })}
                >
                  English
                </button>
              </div>
            </div>
            <div className="setting-group">
              <h2>{t.background}</h2>
              <div className="background-options">
                <button
                  type="button"
                  className={!background ? "selected" : ""}
                  onClick={() => void patch({ chatBackground: null })}
                >
                  <span className="bg-swatch default" />
                  {t.default}
                </button>
                <button
                  type="button"
                  className={
                    state?.settings.chatBackground === landscapeUrl || state?.settings.chatBackground === "/travel-cover.png"
                      ? "selected"
                      : ""
                  }
                  onClick={() =>
                    void patch({ chatBackground: landscapeUrl })
                  }
                >
                  <span className="bg-swatch landscape" />
                  {t.landscape}
                </button>
                <button
                  type="button"
                  className={
                    state?.settings.chatBackground === "local" ? "selected" : ""
                  }
                  onClick={() => bgInput.current?.click()}
                >
                  <span className="bg-swatch custom">+</span>
                  {t.custom}
                </button>
              </div>
              {background ? (
                <button
                  type="button"
                  className="reset-link"
                  onClick={() => void patch({ chatBackground: null })}
                >
                  {t.reset}
                </button>
              ) : null}
            </div>
            <div className="setting-group setting-links">
              <button type="button" onClick={() => nav("terms")}>
                {t.terms}
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={() => nav("privacy")}>
                {t.privacy}
                <ChevronRight size={18} />
              </button>
            </div>
          </section>
        ) : null}
        {page === "profile" ? (
          <section className="subpage-content">
            <div className="profile-card">
              <span>
                <UserRound size={30} />
              </span>
              <h2>{user.displayName}</h2>
              <strong className="profile-email">{user.email}</strong>
              <p>{t.visitorHint}</p>
            </div>
            <form className="profile-password" onSubmit={(event) => void changePassword(event)}>
              <h3>{locale === "zh-CN" ? "修改密码" : "Change password"}</h3>
              <label>{locale === "zh-CN" ? "当前密码" : "Current password"}<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
              <label>{locale === "zh-CN" ? "新密码（至少 10 位）" : "New password (10+ characters)"}<input type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
              {passwordMessage ? <p role="status">{passwordMessage}</p> : null}
              <button type="submit" disabled={passwordPending}>{passwordPending ? "…" : locale === "zh-CN" ? "更新密码" : "Update password"}</button>
            </form>
            <button className="profile-logout" type="button" onClick={() => void onLogout()}>{locale === "zh-CN" ? "退出登录" : "Sign out"}</button>
          </section>
        ) : null}
        {page === "terms" || page === "privacy" ? (
          <section className="subpage-content legal-page">
            <h2>{page === "terms" ? t.terms : t.privacy}</h2>
            <p>{t.legalDraft}</p>
            {page === "terms" ? (
              locale === "zh-CN" ? (
                <>
                  <h3>使用与内容</h3>
                  <p>你应只上传自己有权使用的素材，并检查生成文案、图片、音频和成片是否适合发布。生成结果可能不准确，需要人工确认。</p>
                  <h3>任务与文件</h3>
                  <p>剪辑、生成和导出任务可能因为素材格式、网络或模型服务失败。你可以在页面重试；下载前请确认最终文件可以播放。删除素材可能使关联方案无法再次导出。</p>
                </>
              ) : (
                <>
                  <h3>Content and use</h3>
                  <p>Upload only media you have the right to use, and review generated text, images, audio, and videos before publishing. Results may be inaccurate.</p>
                  <h3>Jobs and files</h3>
                  <p>Jobs may fail because of media formats, network issues, or model services. You can retry them in the app. Check exported files before use. Removing media may prevent an edit plan from being exported again.</p>
                </>
              )
            ) : locale === "zh-CN" ? (
              <>
                <h3>本地存储</h3>
                <p>上传素材、对话、任务和生成结果保存在运行轻剪服务的设备上。对话背景的本地图片保存在当前浏览器中。清除浏览器数据不会自动删除服务端文件。</p>
                <h3>模型处理</h3>
                <p>为完成请求，服务端会将对话内容和必要的素材信息发送至已配置的文本模型；生成图片时会发送图片描述及你选择的参考图；生成口播时会发送口播文本。模型 API Key 由服务端保存，不会显示在普通页面中。</p>
                <h3>删除</h3>
                <p>你可以在素材库删除素材。帐号数据保存在轻剪服务端，目前没有批量清除全部帐号数据的页面。</p>
              </>
            ) : (
              <>
                <h3>Local storage</h3>
                <p>Uploads, chats, jobs, and generated results are stored on the device running Qingjian. A custom chat background is stored in this browser. Clearing browser data does not delete server files.</p>
                <h3>Model processing</h3>
                <p>The server sends chat content and necessary media information to the configured text model. Image generation sends a description and any reference image you select. Narration generation sends the script. API keys stay on the server and are not shown in the app.</p>
                <h3>Deletion</h3>
                <p>You can remove media from the library. Account data is stored on the Qingjian server. There is currently no bulk account-data deletion page.</p>
              </>
            )}
          </section>
        ) : null}
        {page === "timeline" ? (
          <section className="timeline-page">
            <div className="timeline-scroll-content">
            <div className="timeline-preview" data-format={timelineArtifact?.format}>
              {timelineUrl ? (
                <video
                  key={timelineUrl}
                  ref={previewVideo}
                  src={timelineUrl}
                  poster={timelineArtifact?.coverUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={() => {
                    if (!timelineArtifact && clip && previewVideo.current)
                      previewVideo.current.currentTime = clip.start;
                  }}
                />
              ) : (
                <div className="no-preview">
                  <Film size={31} />
                  <span>
                    {locale === "zh-CN" ? "暂无视频预览" : "No video preview"}
                  </span>
                </div>
              )}
            </div>
            {timelinePlan ? (
              <div className="timeline-panel">
                <div className="timeline-ruler">
                  <span>00:00</span>
                  <span>{duration(timelinePlan.targetSeconds / 2)}</span>
                  <span>{duration(timelinePlan.targetSeconds)}</span>
                </div>
                <div className="timeline-clips">
                  {timelinePlan.clips.map((part, index) => {
                    const source = state?.media.find(
                      (m) => m.id === part.sourceId,
                    );
                    return (
                      <button
                        type="button"
                        className={selectedClip === index ? "selected" : ""}
                        key={`${part.sourceId}-${index}`}
                        onClick={() => {
                          setSelectedClip(index);
                          if (timelineArtifact && previewVideo.current)
                            previewVideo.current.currentTime = timelinePlan.clips
                              .slice(0, index)
                              .reduce((sum, p) => sum + p.end - p.start, 0);
                        }}
                      >
                        <span className="timeline-visual">
                          {source ? <ClipVisual item={source} start={part.start} /> : null}
                        </span>
                        <span>
                          {locale === "zh-CN" ? "片段" : "Clip"} {index + 1}
                        </span>
                        <small>{duration(part.end - part.start)}</small>
                      </button>
                    );
                  })}
                </div>
                {timelineArtifact?.hasNarration ? (
                  <div className="audio-track">
                    <Music2 size={18} />
                    {locale === "zh-CN" ? "口播音轨" : "Narration track"}
                    <span />
                  </div>
                ) : null}
                {timelineArtifact?.hasBgm ? (
                  <div className="audio-track">
                    <Music2 size={18} />
                    {locale === "zh-CN" ? "背景音乐" : "Background music"}
                    <span />
                  </div>
                ) : null}
              </div>
            ) : timelineArtifact ? (
              <p className="timeline-snapshot-note">
                {locale === "zh-CN"
                  ? "此历史成片未保存片段快照，仍可播放和下载。"
                  : "This older export has no saved clip snapshot. You can still play and download it."}
              </p>
            ) : null}
            <div className="quick-tools">
              {[
                ["裁剪", "把当前片段裁剪到 "],
                ["分割", "在当前片段的 "],
                ["排序", "调整片段顺序为 "],
                ["配音", "为这支短片生成口播并配音"],
              ].map(([name, value], index) => (
                <button
                  type="button"
                  key={name}
                  onClick={() =>
                    shortcut(
                      locale === "zh-CN"
                        ? value
                        : [
                            "Trim this clip to ",
                            "Split this clip at ",
                            "Reorder clips as ",
                            "Add narration and voiceover",
                          ][index],
                    )
                  }
                >
                  {index === 3 ? (
                    <Mic2 size={22} />
                  ) : index === 2 ? (
                    <Library size={22} />
                  ) : (
                    <WandSparkles size={22} />
                  )}
                  <span>
                    {locale === "zh-CN"
                      ? name
                      : ["Trim", "Split", "Reorder", "Voiceover"][index]}
                  </span>
                </button>
              ))}
            </div>
            </div>
            <div className="timeline-primary-actions">
            <button
              type="button"
              className="timeline-chat-button"
              onClick={() =>
                shortcut(
                  locale === "zh-CN"
                    ? "请根据当前方案生成成片"
                    : "Export the current plan as a video",
                )
              }
            >
              {t.makeVideo}
              <ArrowRight size={18} />
            </button>
            {timelineArtifact ? (
              <a
                className="timeline-download"
                href={timelineArtifact.downloadUrl}
                download={timelineArtifact.name}
              >
                <ArrowDownToLine size={17} />
                {t.download}
              </a>
            ) : null}
            </div>
          </section>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept={mediaAccept.all}
          multiple
          hidden
          onChange={(e) => upload(e.target.files)}
        />
        <input
          ref={bgInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => backgroundFile(e.target.files?.[0])}
        />
      </main>
      {drawer ? (
        <div className="drawer-overlay" onClick={() => setDrawer(false)}>
          <nav
            className="drawer"
            aria-label="主菜单"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-heading">
              <strong>
                轻剪<span>.</span>
              </strong>
              <button
                type="button"
                onClick={() => setDrawer(false)}
                aria-label="关闭"
              >
                <X size={20} />
              </button>
            </div>
            <button
              type="button"
              className="drawer-new"
              onClick={() => void newChat()}
            >
              <Plus size={19} />
              {t.newChat}
            </button>
            <section className="drawer-sessions" aria-label={t.history}>
              <div className="drawer-section-heading">
                <strong>{locale === "zh-CN" ? "最近会话" : "Recent conversations"}</strong>
                <button type="button" onClick={() => nav("history")}>{locale === "zh-CN" ? "查看全部" : "View all"}</button>
              </div>
              {sessions.slice(0, 5).map((item) => (
                <button
                  type="button"
                  className={`drawer-session ${item.id === state?.activeSessionId ? "active" : ""}`}
                  key={item.id}
                  onClick={() => void activate(item.id)}
                  aria-current={item.id === state?.activeSessionId ? "page" : undefined}
                >
                  <span>{sessionTitle(item)}</span>
                  <small>{sessionPreview(item)}</small>
                </button>
              ))}
            </section>
            <div className="drawer-links">
              {menuPages.map((item, index) => (
                <button
                  type="button"
                  key={item}
                  className={page === item ? "active" : ""}
                  onClick={() => nav(item)}
                >
                  {
                    [
                      <Sparkles size={19} />,
                      <Library size={19} />,
                      <UserRound size={19} />,
                      <Film size={19} />,
                      <Clock3 size={19} />,
                      <Coins size={19} />,
                      <UserRound size={19} />,
                      <Settings2 size={19} />,
                    ][index]
                  }
                  <span>{t[item]}</span>
                  {page === item ? <i /> : null}
                </button>
              ))}
            </div>
            <a className="admin-link" href={import.meta.env.VITE_ADMIN_URL || (import.meta.env.DEV ? 'http://127.0.0.1:5174/' : `${import.meta.env.BASE_URL}admin/`)}>
              {locale === "zh-CN" ? "管理后台" : "Admin console"}
              <ChevronRight size={16} />
            </a>
            <div className="drawer-footer">
              <UserRound size={17} />
              {user.displayName}
            </div>
          </nav>
        </div>
      ) : null}
      {mediaPreview ? (
        <div className="preview-overlay" onClick={() => setMediaPreview(null)}>
          <div
            className="media-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={mediaPreview.name}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="close-preview"
              onClick={() => setMediaPreview(null)}
              aria-label="关闭"
            >
              <X size={22} />
            </button>
            {mediaPreview.kind === "video" ? (
              <video src={mediaPreview.url} controls playsInline />
            ) : mediaPreview.kind === "audio" ? (
              <audio src={mediaPreview.url} controls />
            ) : (
              <img src={mediaPreview.url} alt={mediaPreview.name} />
            )}
            <strong>{mediaPreview.name}</strong>
            {mediaPreview.shots?.length ? (
              <div className="shot-list" aria-label="自动识别的分镜">
                <p>自动识别 {mediaPreview.shots.length} 个镜头 · 点击缩略图查看分镜</p>
                <div>
                  {mediaPreview.shots.map((shot, index) => (
                    <button key={index} type="button" onClick={() => { setMediaPreview(null); shortcut(`请将「${mediaPreview.name}」的第 ${index + 1} 个镜头（${shot.start}–${shot.end} 秒）整理成剪辑方案，并配上轻快背景音乐`); }}>
                      <img src={shot.thumbnailUrl} alt={`镜头 ${index + 1}`} loading="lazy" />
                      <span>镜头 {index + 1}<small>{duration(shot.start)}–{duration(shot.end)}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {imagePreview ? (
        <div className="preview-overlay" onClick={() => setImagePreview(null)}>
          <div
            className="image-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={imagePreview.name}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setImagePreview(null)}
              aria-label="关闭"
            >
              <X size={22} />
            </button>
            <img src={imagePreview.url} alt={imagePreview.name} />
            <a href={imagePreview.downloadUrl} download={imagePreview.name}>
              <ArrowDownToLine size={17} />
              {t.download}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
