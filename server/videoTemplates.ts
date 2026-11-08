import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminVideoTemplate, AdminVideoTemplateEntry, TemplateSelection, VideoTemplate } from '../shared/videoTemplates';

export const styleRenderer = fileURLToPath(new URL('../skills/video-style-renderer.js', import.meta.url));
export const styleKinds = ['interface', 'diagram', 'spatial', 'pixel'] as const;
export type VideoStyle = typeof styleKinds[number];

export interface VideoTemplateEntry extends AdminVideoTemplateEntry {
  directory: string;
  workflow: 'animated-science' | 'defold-game' | 'style-video';
  contextFiles: string[];
  manifestHash: string;
  style?: VideoStyle;
  sourceHints: Array<{ keywords: string[]; urls: string[] }>;
}
export interface LoadedVideoTemplate extends VideoTemplateEntry, AdminVideoTemplate {
  context: string;
}
const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url));

export async function loadVideoTemplateCatalog(root = skillRoot): Promise<VideoTemplateEntry[]> {
  const entries = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name));
  const results = await Promise.all(entries.map(async entry => {
    const directory = path.join(root, entry.name);
    let manifest: any;
    let manifestHash: string;
    try {
      const raw = await readFile(path.join(directory, 'template.json'), 'utf8');
      manifest = JSON.parse(raw);
      manifestHash = createHash('sha256').update(raw).digest('hex');
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || manifest.id !== entry.name || typeof manifest.name !== 'string' || !manifest.name.trim() || /[\s@＠，。！？,;；:：]/u.test(manifest.name) || manifest.name.length > 64 || typeof manifest.description !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !['animated-science','defold-game','style-video'].includes(manifest.workflow)) throw new Error(`模板配置无效：${entry.name}`);
    const files: string[] = manifest.contextFiles;
    if (!Array.isArray(files) || files.some(f => typeof f !== 'string' || !/^[a-zA-Z0-9_./-]+\.md$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f))) throw new Error(`模板引用路径无效：${entry.name}`);
    const defaults = manifest.defaults;
    if (manifest.workflow==='style-video' ? !defaults || defaults.width!==960 || defaults.height!==540 || defaults.fps!==30 || defaults.seconds!==12 || defaults.panels!==0 || defaults.narration!==false || defaults.bgm!==false : manifest.workflow==='defold-game'?(!defaults||defaults.width!==960||defaults.height!==640||defaults.fps!==60||defaults.panels!==0||defaults.narration!==false||defaults.bgm!==false):(!defaults || defaults.width !== 1080 || defaults.height !== 1920 || defaults.fps !== 30 || !Number.isInteger(defaults.seconds) || defaults.seconds < 8 || defaults.seconds > 64 || !Number.isInteger(defaults.panels) || defaults.panels < 4 || defaults.panels > 8 || defaults.narration !== false || defaults.bgm !== true)) throw new Error(`模板默认参数无效：${entry.name}`);
    const testCases = manifest.testCases;
    if (!Array.isArray(testCases) || new Set(testCases.map((t:any) => t.id)).size !== testCases.length || testCases.some((t:any) => !t || !/^[a-z0-9-]{1,64}$/.test(t.id) || typeof t.name !== 'string' || !t.name.trim() || typeof t.prompt !== 'string' || !t.prompt.trim() || t.prompt.length > 2000)) throw new Error(`模板测试案例无效：${entry.name}`);
    const sourceHints=manifest.sourceHints||[];
    if(!Array.isArray(sourceHints)||sourceHints.length>12||sourceHints.some((h:any)=>!Array.isArray(h.keywords)||!h.keywords.length||h.keywords.some((k:any)=>typeof k!=='string'||!k.trim()||k.length>80)||!Array.isArray(h.urls)||h.urls.length>8||h.urls.some((u:any)=>typeof u!=='string'||!u.startsWith('https://'))))throw new Error(`模板资料提示无效：${entry.name}`);
    const sample = manifest.sample;
    if (manifest.workflow === 'style-video' && (
      !styleKinds.includes(manifest.style) || !sample || typeof sample.title !== 'string' ||
      typeof sample.source?.author !== 'string' || !httpsUrl(sample.source?.url) || !httpsUrl(sample.source?.galleryUrl)
    )) throw new Error(`风格模板的样片或来源无效：${entry.name}`);
    return {
      id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version,
      skillName: entry.name, defaults, workflow: manifest.workflow, directory, contextFiles: files, manifestHash,
      testCases, sourceHints,
      ...(sample && manifest.workflow === 'style-video' ? {
        style: manifest.style,
        sample: {
          title: sample.title,
          source: { author: sample.source.author, url: sample.source.url, galleryUrl: sample.source.galleryUrl },
          videoUrl: `/api/templates/${entry.name}/sample/video`,
          posterUrl: `/api/templates/${entry.name}/sample/poster`,
        },
      } : {}),
    } as VideoTemplateEntry;
  }));
  const templates = results.filter((t): t is VideoTemplateEntry => Boolean(t));
  if (new Set(templates.map(t => t.name)).size !== templates.length) throw new Error('模板名称重复。');
  return templates;
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

export async function loadVideoTemplate(entry: VideoTemplateEntry): Promise<LoadedVideoTemplate> {
  const files = entry.workflow === 'defold-game'
    ? ['assets/nodes/game.gui_script', 'assets/nodes/ambient.gui_script', 'assets/preview.mjs']
    : entry.workflow === 'style-video'
      ? ['assets/sample.mp4', 'assets/sample.json']
      : ['assets/integration/renderer.mjs', 'assets/integration/scene.mjs', 'assets/integration/motion-api.mjs',
         'assets/integration/motion-metrics.mjs', 'assets/integration/reference-effects.mjs',
         'assets/integration/project-builder.mjs', 'assets/integration/module-builder.mjs',
         'assets/examples/prompt-program.js', 'assets/starter/audio/default-loop-16s.wav'];
  const raw = await readFile(path.join(entry.directory, 'template.json'), 'utf8');
  if (createHash('sha256').update(raw).digest('hex') !== entry.manifestHash) {
    throw new Error('模板清单已变化，请刷新服务后再试。');
  }
  const parts = await Promise.all(['SKILL.md', ...entry.contextFiles].map(file => readFile(path.join(entry.directory, file), 'utf8')));
  const context = parts.join('\n\n');
  // Preserve the old hash for already queued science and Defold jobs.
  const hash = createHash('sha256').update(JSON.stringify(JSON.parse(raw))).update(context);
  for (const file of files) hash.update(await readFile(path.join(entry.directory, file)));
  if (entry.workflow === 'style-video') hash.update(await readFile(styleRenderer));
  return { ...entry, instructions: parts[0], context, skillHash: hash.digest('hex') };
}

export async function loadVideoTemplates(root = skillRoot): Promise<LoadedVideoTemplate[]> {
  return Promise.all((await loadVideoTemplateCatalog(root)).map(loadVideoTemplate));
}

export const publicTemplate = (t: VideoTemplateEntry): VideoTemplate => ({
  id: t.id, name: t.name, description: t.description, version: t.version, skillName: t.skillName,
  defaults: t.defaults, ...(t.sample ? { sample: t.sample } : {}),
  ...(t.workflow === 'defold-game' ? { output: 'game' as const } : {}),
});
export const adminTemplate = (t: VideoTemplateEntry): AdminVideoTemplateEntry => ({ ...publicTemplate(t), testCases: t.testCases });
export const templateSelection = (t: LoadedVideoTemplate): TemplateSelection => ({ id: t.id, name: t.name, version: t.version, skillHash: t.skillHash });
