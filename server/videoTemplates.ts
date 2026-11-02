import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminVideoTemplate, TemplateSelection, VideoTemplate } from '../shared/videoTemplates';

export interface LoadedVideoTemplate extends AdminVideoTemplate { directory: string; workflow: 'animated-science'|'defold-game'; context: string; sourceHints:Array<{keywords:string[];urls:string[]}> }
const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url));

export async function loadVideoTemplates(root = skillRoot): Promise<LoadedVideoTemplate[]> {
  const entries = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name));
  const results = await Promise.all(entries.map(async entry => {
    const directory = path.join(root, entry.name);
    let manifest: any;
    try { manifest = JSON.parse(await readFile(path.join(directory, 'template.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || manifest.id !== entry.name || typeof manifest.name !== 'string' || !manifest.name.trim() || /[\s@＠，。！？,;；:：]/u.test(manifest.name) || manifest.name.length > 64 || typeof manifest.description !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !['animated-science','defold-game'].includes(manifest.workflow)) throw new Error(`模板配置无效：${entry.name}`);
    const files: string[] = manifest.contextFiles;
    if (!Array.isArray(files) || files.some(f => typeof f !== 'string' || !/^[a-zA-Z0-9_./-]+\.md$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f))) throw new Error(`模板引用路径无效：${entry.name}`);
    const parts = await Promise.all(['SKILL.md', ...files].map(f => readFile(path.join(directory, f), 'utf8')));
    const defaults = manifest.defaults;
    if (manifest.workflow==='defold-game'?(!defaults||defaults.width!==960||defaults.height!==640||defaults.fps!==60||defaults.panels!==0||defaults.narration!==false||defaults.bgm!==false):(!defaults || defaults.width !== 1080 || defaults.height !== 1920 || defaults.fps !== 30 || !Number.isInteger(defaults.seconds) || defaults.seconds < 8 || defaults.seconds > 64 || !Number.isInteger(defaults.panels) || defaults.panels < 4 || defaults.panels > 8 || defaults.narration !== false || defaults.bgm !== true)) throw new Error(`模板默认参数无效：${entry.name}`);
    const testCases = manifest.testCases;
    if (!Array.isArray(testCases) || new Set(testCases.map((t:any) => t.id)).size !== testCases.length || testCases.some((t:any) => !t || !/^[a-z0-9-]{1,64}$/.test(t.id) || typeof t.name !== 'string' || !t.name.trim() || typeof t.prompt !== 'string' || !t.prompt.trim() || t.prompt.length > 2000)) throw new Error(`模板测试案例无效：${entry.name}`);
    const context = parts.join('\n\n');
    const sourceHints=manifest.sourceHints||[];
    if(!Array.isArray(sourceHints)||sourceHints.length>12||sourceHints.some((h:any)=>!Array.isArray(h.keywords)||!h.keywords.length||h.keywords.some((k:any)=>typeof k!=='string'||!k.trim()||k.length>80)||!Array.isArray(h.urls)||h.urls.length>8||h.urls.some((u:any)=>typeof u!=='string'||!u.startsWith('https://'))))throw new Error(`模板资料提示无效：${entry.name}`);
    const skillHash = createHash('sha256').update(JSON.stringify(manifest)).update(context);
    // Include the actual executable interpreter and shared renderer in the version fingerprint.
    for (const f of (manifest.workflow==='defold-game'?['assets/nodes/game.gui_script','assets/nodes/ambient.gui_script','assets/preview.mjs']:['assets/integration/renderer.mjs','assets/integration/scene.mjs','assets/integration/motion-api.mjs','assets/integration/motion-metrics.mjs','assets/integration/reference-effects.mjs','assets/integration/project-builder.mjs','assets/integration/module-builder.mjs','assets/examples/prompt-program.js','assets/starter/audio/default-loop-16s.wav'])) skillHash.update(await readFile(path.join(directory, f)));
    return { id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version, skillName: entry.name, defaults, workflow: manifest.workflow, directory, instructions: parts[0], context, skillHash: skillHash.digest('hex'), testCases, sourceHints } as LoadedVideoTemplate;
  }));
  const templates = results.filter((t): t is LoadedVideoTemplate => Boolean(t));
  if (new Set(templates.map(t => t.name)).size !== templates.length) throw new Error('模板名称重复。');
  return templates;
}
export const publicTemplate = (t: LoadedVideoTemplate): VideoTemplate => ({ id:t.id, name:t.name, description:t.description, version:t.version, skillName:t.skillName, defaults:t.defaults, ...(t.workflow==='defold-game'?{output:'game' as const}:{}) });
export const adminTemplate = (t: LoadedVideoTemplate): AdminVideoTemplate => ({ ...publicTemplate(t), skillHash:t.skillHash, instructions:t.context, testCases:t.testCases });
export const templateSelection = (t: LoadedVideoTemplate): TemplateSelection => ({ id:t.id, name:t.name, version:t.version, skillHash:t.skillHash });
