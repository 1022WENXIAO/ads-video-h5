export interface VideoTemplate {
  output?: 'game';
  id: string;
  name: string;
  description: string;
  version: string;
  skillName: string;
  defaults: { width: number; height: number; fps: number; seconds: number; panels: number; narration: boolean; bgm: boolean };
}

export interface TemplateSelection { id: string; name: string; version: string; skillHash: string }
export interface TemplateTestCase { id: string; name: string; prompt: string }
export interface AdminVideoTemplate extends VideoTemplate {
  skillHash: string;
  instructions: string;
  testCases: TemplateTestCase[];
}
export interface TemplateTestRun {
  id: string;
  template: TemplateSelection;
  caseId: string;
  prompt: string;
  createdAt: string;
  sessionId: string;
  jobId: string;
  status: import('./types').JobStatus;
  stage?: string;
  progress?: number;
  error?: string;
  workflow?: import('./types').WorkflowEvent[];
  artifact?: { kind?: import("./types").ArtifactKind; id: string; name: string; duration?: number; technicalPassed: boolean; userAccepted: false; animationMode?:'code'|'declarative'; sourceHash?:string; motion?:{meanChangedAreaPct:number;activeFramePct:number} };
}

/** Mentions need a word boundary so an email or a longer template name cannot select a skill. */
export function templateMentions(text: string): Array<{ name: string; start: number; end: number }> {
  return [...text.matchAll(/(?:^|\s)[@＠]([^\s@＠，。！？,;；:：]{1,64})(?=$|[\s，。！？,;；:：])/gu)]
    .map(m => ({ name: m[1], start: m.index! + m[0].indexOf(m[0].includes('@') ? '@' : '＠'), end: m.index! + m[0].length }));
}

export function selectMention<T extends VideoTemplate>(text: string, templates: T[]): T | undefined {
  const mentions = templateMentions(text);
  if (!mentions.length) return;
  const selected = mentions.map(m => templates.find(t => t.name === m.name || t.id === m.name));
  if (selected.some(t => !t)) throw new Error(`未找到模板「${mentions[selected.findIndex(t => !t)].name}」，请从 @ 模板列表选择。`);
  if (new Set(selected.map(t => t!.id)).size > 1) throw new Error('一次制作请选择一个模板。');
  return selected[0];
}
