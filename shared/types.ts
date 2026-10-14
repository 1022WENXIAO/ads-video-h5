export type Format = '9:16' | '16:9' | '1:1';
export type MediaKind = 'video' | 'image' | 'audio';
export type ArtifactKind = 'image' | 'audio' | 'video';
export type JobKind = 'plan' | 'image' | 'audio' | 'export' | 'music' | 'effect' | 'understanding' | 'review' | 'avatar';
export type JobStatus = 'queued' | 'running' | 'stopping' | 'cancelled' | 'succeeded' | 'failed';
export type ModelKind = 'text' | 'image' | 'audio' | 'understanding';
export interface PublicUser { id: string; email: string; displayName: string; authProvider?: 'email' | 'wechat'; }

export interface Shot {
  start: number;
  end: number;
  thumbnailUrl: string;
}

export interface MediaItem {
  ownerId?: string;
  id: string;
  name: string;
  mimeType: string;
  kind: MediaKind;
  duration?: number;
  shots?: Shot[];
  url: string;
  createdAt: string;
  origin?: 'upload' | 'generated' | 'imported';
  sourceUrl?: string;
  hasAudio?: boolean;
  character?: { role: 'reference' | 'sprite'; referenceMediaId?: string; sprite?: SpriteSheet };
  analysis?: AudioAnalysis;
  generation?: { workflowId: string; beatId: string; mode: 'original' | 'generated'; lineHash: string; sceneSpecHash?: string; audioHash: string; voiceRejectedAudioHash?: string; htmlHash?: string; referenceHash?: string; originalSourceId?: string; originalStart?: number; originalEnd?: number; newsPublication?: NewsPublicationEvidence };
}

export interface SpriteSheet {
  columns: number; rows: number; frameCount: number; fps: number;
  width: number; height: number; frameWidth: number; frameHeight: number;
  sha256: string; frameHashes: string[]; transparency: 'alpha' | 'chroma';
  modelId?: string;
}
export interface AvatarTrack extends TimeRange {
  mediaId: string; assetHash: string; fps: number;
  layout: 'corner' | 'sidebar'; position: 'left' | 'right'; size: number;
  reason: string;
}

export interface TimeRange { start: number; end: number; }
export interface TranscriptWord extends TimeRange { text: string; }
export interface TranscriptSentence extends TimeRange {
  id: string;
  text: string;
  words: TranscriptWord[];
  complete: boolean;
}
export interface AudioAnalysis {
  captionBoundarySource?: 'model' | 'matched-clauses';
  status: 'ready' | 'no-audio';
  modelId: string;
  sourceHash: string;
  duration: number;
  transcript: string;
  sentences: TranscriptSentence[];
  pauses: TimeRange[];
  captionBreaks?: number[];
  timing: 'model-estimated';
  warnings: string[];
  createdAt: string;
}

export interface EditClip {
  sceneId?: string;
  sourceId: string;
  start: number;
  end: number;
  zoom?: number;
  volume?: number;
  purpose?: 'hook' | 'argument' | 'conclusion' | 'context' | 'comparison';
  sentenceIds?: string[];
  transition?: { kind: 'cut' | 'fade'; duration: number };
}

export interface SelectedScene extends TimeRange {
  id: string; sourceId: string; sourceName: string; sourceHash: string;
  sentenceIds: string[]; quote: string; reason: string;
  purpose: NonNullable<EditClip['purpose']>;
  visual?: { observations: string; safeZone: 'top' | 'bottom'; frameTimes: number[] };
}
export interface NarrativeScript {
  premise: string; audience: string; arc: string; style: string;
  beats: Array<{ sceneId: string; intent: string; graphic: 'none' | 'underline' | 'circle' | 'arrow' | 'steps'; label: string }>;
}
export interface EditorialReport { scenes: SelectedScene[]; script: NarrativeScript; }
export interface ResearchReference {
  id: string; title: string; url: string; excerpt: string; retrievedAt: string;
  verification: 'search-cited'|'primary-page'|'primary-record'|'primary-paper'|'public-page'|'news-page';
  publishedAt?: string; dateEvidence?: string; freshness?: 'fresh'|'stale'|'undated'|'future';
}
export interface HotTopicSignal {
  id: string; title: string; url: string; boardUrl: string; source: 'baidu'|'hackernews';
  rank: number; observedAt: string; submittedAt?: string; pinned?: boolean;
  metric?: { label: string; value: number }; description: string;
}
export interface HotResearchBrief {
  asOf: string; expiresAt: string; windowHours: number; signals: HotTopicSignal[];
  topics: Array<{ title: string; hook: string; angle: string; signalIds: string[];
    facts: Array<{ text: string; evidence: Array<{ referenceId: string; quote: string }> }>;
    visualPlan: string; uncertainties: string[] }>;
  failures: string[];
}
export interface ReconstructionBeat {
  id: string; role: string; line: string; reason: string; mode: 'original' | 'generated';
  sourceId?: string; sentenceIds?: string[]; evidence?: SelectedScene;
  referenceIds: string[]; visual: 'person' | 'html'; title: string; visualBrief: string;
  mediaId?: string; duration?: number; audioHash?: string; htmlHash?: string;
  voiceRevision?: number;
}
export interface ReconstructionReport {
  workflowId: string; premise: string; audience: string; arc: string; style: string;
  gaps: string[]; references: ResearchReference[]; beats: ReconstructionBeat[];
  voiceReference?: { sourceId: string; sourceHash: string; start: number; end: number; audioHash: string };
  requestedSeconds: number; limitations: string[];
  sourceIds?: string[];
}
export interface DrawingMotion extends TimeRange { sceneId: string; kind: 'underline' | 'circle' | 'arrow' | 'steps'; label: string; zone: 'top' | 'bottom'; }
export interface WorkflowEvent {
  tool: string; stage: string; status: 'running' | 'succeeded' | 'failed'; at: string; detail?: string;
  callId?: string; input?: unknown; output?: unknown; durationMs?: number;
}

export type LessonCurveFunction = 'mse' | 'mae' | 'huber' | 'cross-entropy' | 'hinge' | 'focal';
export type LessonIllustration = 'interface' | 'steps' | 'code' | 'character' | 'controller' | 'interaction' | 'gallery' | 'announcement' | 'signal' | 'hardware' | 'modules' | 'thermos' | 'bar-chart' | 'book' | 'clothing' | 'desk' | 'coffee' | 'orbit' | 'battery' | 'map';
export interface LessonBarChart {
  bars: Array<{label:string;value:number}>;
  unit: string;
  illustrative: boolean;
  panels: Array<{title:string;min:number;max:number}>;
}
export interface LessonVisual {
  kind: 'concept' | 'formula' | 'curve' | 'timeline' | 'comparison' | 'bar-chart';
  takeaway: string;
  items: Array<{ label: string; detail: string; cue: string; illustration?: LessonIllustration }>;
  formula?: string;
  barChart?: LessonBarChart;
  plot?: {
    xLabel: string; yLabel: string; xMin: number; xMax: number; yMin: number; yMax: number;
    curves: Array<{ label: string; fn: LessonCurveFunction; parameter?: number }>;
  };
}
export interface LessonChapter {
  id: string; title: string; role: 'hook' | 'foundation' | 'development' | 'application' | 'recap';
  goal: string; prerequisites: string[]; narration: string; reason: string;
  referenceIds: string[]; claims: Array<{ text: string; referenceIds: string[]; basis?: 'source' | 'calculation' | 'synthesis'; explanation?: string }>;
  visual: LessonVisual;
  mediaId?: string; duration?: number; audioHash?: string; htmlHash?: string;
  speechMatch?: number; cues?: Array<{ text: string; start: number; end: number }>;
}
export interface LessonReport {
  hotResearch?: HotResearchBrief;
  presentation?: LessonPresentation;
  workflowId: string; title: string; audience: string; objectives: string[]; arc: string;
  requestedSeconds: number; explicitDuration: boolean; format: Format;
  chapters: LessonChapter[]; references: ResearchReference[];
  pacing?: LessonPacing;
  factReview?: { score: number; needsRepair: boolean; findings: string[]; suggestions?: string[]; todayEvents?: Array<{date:string;referenceId:string;quote:string}>; selectionReason?: {chapterId:string;quote:string}; adjudication?: { modelId: string; primaryScore: number; primaryNeedsRepair: boolean; primaryFindings: string[] } };
  voice?: { mode: 'preset'; modelId: string; anchorHash: string; revision: number; tempo: number; spokenCharacters?: number; spokenSeconds?: number; charactersPerSecond?: number };
  limitations: string[];
}

export interface LessonPacing {
  mode: 'brisk' | 'standard' | 'deliberate';
  targetCharactersPerSecond: number; minCharactersPerSecond: number; maxCharactersPerSecond: number;
  maxPauseSeconds: number; leadSeconds: number; tailSeconds: number; transitionSeconds: number;
}

export interface LessonPresentation {
  mood: 'neutral' | 'urgent';
  bgm: boolean;
}

export interface TimelineText extends TimeRange {
  text: string;
  style: 'subtitle' | 'keyword' | 'title' | 'lower-third';
  animation?: 'none' | 'pop' | 'rise' | 'underline';
}
export interface NewsPublicationFrameObservation {
  visible: boolean;
  chapterId: string;
  quote: string;
  frameTime: number;
}
export interface NewsPublicationAnnotation {
  referenceId: string;
  publishedAt: string;
  publishedDateBeijing: string;
  cutoffUtc: string;
  windowHours: number;
  label: string;
}
export interface NewsPublicationLayout {
  fontSize: number; x: number; y: number; width: number; height: number; sampledTimes: number[]; minimumOpacity: number;
}
export interface NewsPublicationEvidence extends NewsPublicationAnnotation {
  htmlHash: string;
  sceneHash: string;
  htmlVerified: true;
  layout: NewsPublicationLayout;
}
export interface NewsPublicationProof extends NewsPublicationAnnotation {
  version: 1;
  chapterId: string;
  sourceId: string;
  htmlHash: string;
  sourceHash: string;
  planHash: string;
  renderedSha256: string;
  htmlVerified: true;
  frameVerified: true;
  layout: NewsPublicationLayout;
  frameEvidence: { chapterId: string; quote: string; frameTime: number; sampledTimes: number[] };
}
export interface RenderReview {
  status: 'passed' | 'needs-review';
  score: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  semantic?: { score: number; findings: string[]; suggestions?: string[]; repaired?: boolean };
  newsPublication?: NewsPublicationProof;
  transport?: { mode: 'inline' | 'hosted'; requests: Array<{stage: 'voice' | 'semantic'; attempt: number; bytes: number; durationMs: number; status?: number; error?: string}> };
  audio?: {
    limits: { targetLufs:number;truePeakDb:number;segmentSpreadLu:number;adjacentJumpLu:number;withinSpreadLu:number };
    segments: Array<{id:string;mode:string;start:number;end:number;integratedLufs:number|null;truePeakDb:number|null;voicedSpreadLu:number|null;headLufs:number|null;tailLufs:number|null}>;
    segmentSpreadLu:number|null;
    userReportedMismatch?:boolean;
    jumps:Array<{from:string;to:string;time:number;integratedDeltaLu:number|null;boundaryDeltaLu:number|null}>;
    voice?:{method:string;consistency:{status:'passed'|'failed'|'uncertain';detail:string};segments:Array<{id:string;status:'passed'|'failed'|'uncertain';detail:string}>};
  };
  limitations: string[];
  createdAt: string;
}

export interface EditPlan {
  lesson?: LessonReport;
  reconstruction?: ReconstructionReport;
  editorial?: EditorialReport;
  motions?: DrawingMotion[];
  avatars?: AvatarTrack[];
  authorAvatarMode?: 'default' | 'off';
  format: Format;
  targetSeconds: number;
  summary: string;
  clips: EditClip[];
  version?: number;
  coverMediaId?: string;
  captions?: TimelineText[];
  overlays?: TimelineText[];
  audio?: { originalVolume: number; bgmVolume: number; narrationVolume: number; normalize: boolean };
  fineCut?: boolean;
}

export interface ChatMessage {
  research?: { brief: HotResearchBrief; references: ResearchReference[] };
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  attachmentIds?: string[];
  artifactIds?: string[];
  jobId?: string;
  musicSearch?: MusicSearch;
  parts?: ReplyPart[];
}

export interface ReplyPart {
  id: string;
  phase: 'commentary' | 'final';
  text: string;
  createdAt: string;
}

export interface MusicSearch {
  query: string;
  sources: Array<{ name: 'Pixabay' | '24bit'; url: string; note: string }>;
}

export interface Artifact {
  /** Original user-message time; reviewing an existing movie keeps this cutoff. */
  requestedAt?: string;
  workflow?: WorkflowEvent[];
  ownerId?: string;
  id: string;
  sessionId: string;
  messageId: string;
  kind: ArtifactKind;
  name: string;
  url: string;
  downloadUrl: string;
  createdAt: string;
  version: number;
  text?: string;
  duration?: number;
  format?: Format;
  mediaId?: string;
  plan?: EditPlan;
  hasNarration?: boolean;
  hasBgm?: boolean;
  coverUrl?: string;
  coverMimeType?: string;
  review?: RenderReview;
  planHash?: string;
}

export interface JobFailure {
  name: string;
  message: string;
  code?: string;
  status?: number;
  retryable: boolean;
  retryExhausted: boolean;
  origin?: { tool: string; stage: string; callId: string };
  causes?: JobFailure[];
}
export interface JobAttempt {
  id: string;
  number: number;
  reason: 'initial' | 'retry' | 'restart';
  kind: JobKind;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  revision: string | null;
  textModel?: Pick<PublicModel, 'id' | 'name' | 'modelId'>;
  stage?: string;
  error?: string;
  failure?: JobFailure;
  artifactId?: string;
  inheritedArtifactId?: string;
  artifactOrigin?: 'generated' | 'reviewed' | 'retained';
  restoredCallIds?: string[];
  restoredCallCount?: number;
  workflow?: WorkflowEvent[];
  transport?: Array<{ at: string; origin: string; path: string; attempts: number; durationMs: number; outcome: 'recovered' | 'failed'; failure: JobFailure; status?: number; requestId?: string; recoveryKind?: 'audio-rate-limit'; retryDelaysMs?: number[]; queueWaitMs?: number }>;
}

export interface Job {
  attemptId?: string;
  attempts?: JobAttempt[];
  legacyWorkflow?: WorkflowEvent[];
  failure?: JobFailure;
  creditTaskId?: string;
  textModel?: Pick<PublicModel, 'id' | 'name' | 'modelId'>;
  avatarSourceId?: string;
  authorAvatarId?: string | null;
  stopRequestedAt?: string;
  cancelledAt?: string;
  workflow?: WorkflowEvent[];
  stage?: string;
  ownerId?: string;
  id: string;
  sessionId: string;
  messageId: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress?: number;
  error?: string;
  artifactId?: string;
}

export interface Session {
  lessonDraft?: LessonReport;
  ownerId?: string;
  id: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  plan: EditPlan | null;
}

export interface PublicModel {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  kind: ModelKind;
  enabled: boolean;
}

export interface AppSettings {
  authorAvatarId?: string | null;
  defaultModelId: string | null;
  language: 'zh-CN' | 'en-US';
  chatBackground: string | null;
}

export interface AppState {
  credits?: import('./creditTypes').CreditWallet;
  activeSessionId: string;
  sessions: Session[];
  media: MediaItem[];
  artifacts: Artifact[];
  jobs: Job[];
  settings: AppSettings;
  models: PublicModel[];
  mode: 'pi' | 'unconfigured';
}
