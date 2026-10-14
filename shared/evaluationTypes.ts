import type { Artifact, Format, Job, ModelKind, WorkflowEvent } from './types';

export type EvaluationCategory = 'hot-news' | 'knowledge' | 'multi-video';
export interface EvaluationExpectation {
  seconds: number;
  toleranceSeconds: number;
  format: Format;
  captions: boolean;
  minSources: number;
  html: boolean;
  originalOnly: boolean;
  requiredWords: string[];
}
export interface EvaluationCase {
  id: string;
  name: string;
  category: EvaluationCategory;
  description: string;
  messages: string[];
  fixtureIds: string[];
  expectation: EvaluationExpectation;
  threshold: number;
  enabled: boolean;
  version: number;
  updatedAt: string;
}
export interface EvaluationFixture {
  id: string;
  name: string;
  bytes: number;
  duration: number;
  hasAudio: boolean;
  sha256: string;
  createdAt: string;
}
export interface EvaluationCheck {
  id: string;
  name: string;
  passed: boolean;
  weight: number;
  detail: string;
}
export type EvaluationResultStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
export interface EvaluationResult {
  id: string;
  case: EvaluationCase;
  caseHash: string;
  fixtures: EvaluationFixture[];
  repeat: number;
  status: EvaluationResultStatus;
  jobIds: string[];
  stage?: string;
  progress?: number;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  error?: string;
  score?: number;
  checks?: EvaluationCheck[];
  workflow?: WorkflowEvent[];
  diagnostics?: {
    toolCalls:number;successfulCalls:number;recoveredFailures:number;
    failures:Array<{callId?:string;tool:string;kind:string;detail:string;recovery:{status:'recovered'|'unresolved';callId?:string;tool?:string}}>;
    qualityFeedback?:Array<{callId?:string;tool:string;score:number|null;findings?:unknown;status:string;repairTool?:string;repairCallId?:string}>;
  };
  artifact?: Omit<Artifact, 'url' | 'downloadUrl' | 'ownerId'> & { sha256: string; bytes: number; actualDuration: number };
  spokenText?: string;
  humanReview?: { score: number; note: string; reviewedAt: string };
}
export interface EvaluationRun {
  id: string;
  name: string;
  status: 'running' | 'stopping' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  maxCaseSeconds: number;
  releaseId?: string;
  releaseAttempt?: number;
  snapshot: {
    revision: string | null;
    implementationHash: string;
    skillHash: string;
    rubricVersion: string;
    models: Array<{ id: string; name: string; modelId: string; kind: ModelKind; provider: string }>;
  };
  results: EvaluationResult[];
}
export interface EvaluationSummary {
  total: number; finished: number; passed: number; failed: number; cancelled: number;
  rendered: number; completionRate: number; passRate: number; averageScore: number | null; elapsedMs: number;
  categories: Array<{ category: EvaluationCategory; total: number; passed: number; averageScore: number | null }>;
}
export type EvaluationRunSummary = Omit<EvaluationRun, 'results'> & { summary: EvaluationSummary };
export interface EvaluationProgress { jobs: Pick<Job, 'id' | 'status' | 'stage' | 'progress' | 'workflow'>[] }

export interface ReleaseEvaluationSettings {
  enabled: boolean;
  /** Registry ID; null follows the backend default text model. Never a provider key. */
  generatorModelId: string | null;
  caseCount: number;
  maxCaseSeconds: number;
  generationTimeoutSeconds: number;
  maxSuiteSeconds: number;
  /** Explicit administrator retries, including the initial attempt. */
  maxAttempts: number;
}
export type ReleaseEvaluationStatus = 'queued' | 'generating' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled';
export interface ReleaseEvaluationAttempt {
  attempt: number;
  status: ReleaseEvaluationStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  settingsSnapshot: ReleaseEvaluationSettings;
  generator?: { id: string; name: string; modelId: string; provider: string };
  generatedCases: EvaluationCase[];
  evaluationRunId?: string;
  summary?: EvaluationSummary;
  error?: string;
}
export interface ReleaseEvaluation extends ReleaseEvaluationAttempt {
  id: string;
  revision: string;
  implementationHash: string;
  /** Earlier attempts remain immutable; a restart never silently replays paid calls. */
  history: ReleaseEvaluationAttempt[];
}
export interface ReleaseEvaluationState {
  settings: ReleaseEvaluationSettings;
  releases: ReleaseEvaluation[];
  currentRevision: string | null;
  currentReleaseId?: string;
}
