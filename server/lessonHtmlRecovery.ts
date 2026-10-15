import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Format } from '../src/types';
import { hashBytes, validateDrawing, type HtmlDrawing } from './narrativeScenes';
import { currentJobSignal, throwIfJobCancelled } from './jobExecution';
import { liftCardLabels, reflowCardDetails } from './drawingCardLayout';

type LayoutIssue = { code: string; severity?: string; selector?: string; containerSelector?: string };
type LayoutReport = { ok?: boolean; issues?: LayoutIssue[]; findings?: LayoutIssue[]; layout?: { findings?: LayoutIssue[] }; lint?: { findings?: LayoutIssue[] }; runtime?: { findings?: LayoutIssue[] }; motion?: { findings?: LayoutIssue[] }; contrast?: { findings?: LayoutIssue[] } };
export const drawingContentHash = (drawing: HtmlDrawing) => hashBytes(JSON.stringify({ title: drawing.title, text: drawing.nodes.map(n => n.text).filter(Boolean).sort() }));
const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => Math.min(a.x,a.x+a.w) < Math.max(b.x,b.x+b.w) && Math.max(a.x,a.x+a.w) > Math.min(b.x,b.x+b.w) && Math.min(a.y,a.y+a.h) < Math.max(b.y,b.y+b.h) && Math.max(a.y,a.y+a.h) > Math.min(b.y,b.y+b.h);
const contains = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x + 12 <= b.x && b.x + b.w <= a.x + a.w - 12 && a.y + 12 <= b.y && b.y + b.h <= a.y + a.h - 12;
export function htmlLayoutIssues(report: LayoutReport): LayoutIssue[] {
  return (report.issues || report.findings || report.layout?.findings || []).filter(issue => !issue.severity || issue.severity === 'error');
}

/** A card's own label is centered by drawingHtml. When the real checker
 * identifies an inset value colliding with that label, give the unchanged
 * label a separate, empty upper zone. No text, values, fonts or paths move. */
export function separateCardLabels(drawing: HtmlDrawing, issues: LayoutIssue[], format: Format): HtmlDrawing | undefined {
  if (!issues.length || issues.some(issue => !['content_overlap', 'text_occluded'].includes(issue.code))) return;
  const next = structuredClone(drawing), cards = new Set<string>();
  for (const issue of issues) {
    const ids = [issue.selector, issue.containerSelector].map(selector => selector?.match(/^#([a-zA-Z][a-zA-Z0-9_-]*)$/)?.[1]);
    const pair = ids.map(id => next.nodes.find(node => node.id === id));
    const card = pair.find(node => node?.kind === 'card' && node.text.trim());
    const value = pair.find(node => node?.kind === 'text');
    if (!card || !value || !contains(card, value)) return;
    cards.add(card.id);
  }
  for (const id of cards) {
    const card = next.nodes.find(node => node.id === id)!;
    const units = [...card.text].reduce((n, char) => n + (/^[\u0000-\u007f]$/.test(char) ? .55 : 1), 0);
    const label = { ...card, id: card.id + '_label', kind: 'text' as const, x: card.x + 15, y: card.y + 15, w: card.w - 30, h: Math.ceil(Math.ceil(units * card.fontSize / (card.w - 30)) * card.fontSize * 1.3), highlight: false };
    if (label.id.length > 64 || next.nodes.some(node => node.id === label.id) || label.y + label.h > card.y + card.h - 15) return;
    // Bounds are conservative: a proposed label must not touch any other
    // meaningful object, even if a later animation might temporarily hide it.
    if (next.nodes.some(node => node.id !== card.id && (node.text.trim() || node.kind === 'path' || node.kind === 'line') && intersects(label, node))) return;
    card.text = '';
    next.nodes.push(label);
  }
  if (drawingContentHash(next) !== drawingContentHash(drawing)) return;
  try { return validateDrawing(next, format); } catch { return; }
}

interface SceneResult { file: string; analysis: { sourceHash: string }; }
interface AttemptEvidence { directory: string; manifestHash: string; geometry: boolean; }
interface NativeState { status: 'running' | 'failed' | 'cancelled' | 'completed'; claimHash: string; terminalHash?: string; evidence?: AttemptEvidence; }
interface HtmlState<R> {
  version: 1; contextHash: string; attempts: number;
  blocked?: boolean;
  failed: Array<{ hash: string; feedback: string; drawing?: HtmlDrawing; report?: LayoutReport; evidence?: AttemptEvidence }>;
  pendingDrawing?: HtmlDrawing;
  native?: NativeState;
  completed?: { drawing?: HtmlDrawing; rendererKind?: 'native'; result: R; fileHash: string };
}
function parseHtmlState<R>(stored:string):HtmlState<R>{
  let saved:HtmlState<R>;
  try { saved=JSON.parse(stored); } catch (error) { throw new Error('HTML局部恢复状态JSON损坏，保留原文件并停止。', {cause:error}); }
  if (!saved || saved.version !== 1 || typeof saved.contextHash !== 'string' || !saved.contextHash || !Number.isInteger(saved.attempts) || saved.attempts < 0 || saved.attempts > 2 || !Array.isArray(saved.failed) || saved.failed.length > saved.attempts || saved.failed.some(failure => !failure || !/^[a-f0-9]{64}$/.test(failure.hash) || typeof failure.feedback !== 'string') || saved.blocked !== undefined && typeof saved.blocked !== 'boolean') throw new Error('HTML局部恢复状态版本或内容无效，保留原文件并停止。');
  if(saved.native&&(!['running','failed','cancelled','completed'].includes(saved.native.status)||!/^[a-f0-9]{64}$/.test(saved.native.claimHash)||saved.native.terminalHash!==undefined&&!/^[a-f0-9]{64}$/.test(saved.native.terminalHash)||saved.attempts!==2||saved.failed.length!==2))throw new Error('HTML原生恢复状态无效，保留原文件并停止。');
  return saved;
}
export class LessonHtmlLayoutError extends Error { code = 'HTML_LAYOUT_EXHAUSTED'; }

const artifactNames=['index.html','check-report.json','lint-report.json','inspect-report.json','check-failure.json','lint-failure.json','inspect-failure.json'] as const;
const geometryCodes=new Set(['content_overlap','text_occluded','text_overflow','out_of_bounds','element_out_of_bounds','overflow']);
async function immutableWrite(file:string,bytes:string|Buffer){
  try{await writeFile(file,bytes,{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await readFile(file);if(!existing.equals(Buffer.from(bytes)))throw new Error('HTML恢复不可变证据SHA冲突，保留原文件并停止。',{cause:error});}
}
async function clearCurrentReports(project:string){
  for(const name of artifactNames)await rm(path.join(project,name),{force:true});
}
async function archiveAttempt(project:string,contextHash:string,name:string,error:unknown):Promise<AttemptEvidence|undefined>{
  const artifacts=new Map<string,Buffer>();
  for(const file of artifactNames)try{artifacts.set(file,await readFile(path.join(project,file)));}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;}
  if(!artifacts.has('index.html'))return;
  let geometry=false;
  for(const file of ['check-report.json','lint-report.json','inspect-report.json']){
    const bytes=artifacts.get(file);if(!bytes)continue;
    let report:LayoutReport;try{report=JSON.parse(bytes.toString());}catch(cause){throw new Error('HTML实际检查报告JSON损坏，保留原文件并停止。',{cause});}
    const issues=[...(report.issues||report.findings||[]),...['layout','lint','runtime','motion','contrast'].flatMap(key=>(report as any)[key]?.findings||[])].filter(issue=>!issue.severity||issue.severity==='error');
    if(report.ok===true&&!issues.length)continue;
    // Any unknown/incomplete/other failure is decisive regardless of report
    // ordering. A later collision cannot turn it into geometry-only recovery.
    if(report.ok!==false||!issues.length||issues.some(issue=>!geometryCodes.has(issue.code)))return await store(false);
    geometry=true;
  }
  return await store(geometry);
  async function store(isGeometry:boolean){
    const directory=path.join('html-recovery-evidence',hashBytes(contextHash),name),absolute=path.join(project,directory);
    await mkdir(absolute,{recursive:true,mode:0o700});
    const files:Record<string,string>={};
    for(const [file,bytes]of artifacts){files[file]=hashBytes(bytes);await immutableWrite(path.join(absolute,file),bytes);}
    const manifest=JSON.stringify({version:1,contextHash,name,files,geometry:isGeometry,reason:String(error)});
    await immutableWrite(path.join(absolute,'manifest.json'),manifest);
    return {directory,manifestHash:hashBytes(manifest),geometry:isGeometry};
  }
}
async function verifyAttemptEvidence(project:string,evidence:AttemptEvidence|undefined,contextHash:string):Promise<boolean>{
  if(!evidence)return false;
  const root=path.join('html-recovery-evidence',hashBytes(contextHash));
  if(path.dirname(evidence.directory)!==root||!/^authored-[12]$/.test(path.basename(evidence.directory)))throw new Error('HTML恢复证据路径无效，保留原文件并停止。');
  const bytes=await readFile(path.join(project,evidence.directory,'manifest.json'));
  if(hashBytes(bytes)!==evidence.manifestHash)throw new Error('HTML恢复证据manifest SHA不一致，保留原文件并停止。');
  const manifest=JSON.parse(bytes.toString());
  if(manifest.version!==1||manifest.contextHash!==contextHash||manifest.geometry!==evidence.geometry||!manifest.files?.['index.html'])throw new Error('HTML恢复证据内容无效，保留原文件并停止。');
  for(const[file,hash]of Object.entries(manifest.files)){if(!artifactNames.includes(file as any)||hashBytes(await readFile(path.join(project,evidence.directory,file)))!==hash)throw new Error('HTML恢复实际文件SHA不一致，保留原文件并停止。');}
  return evidence.geometry;
}

/** Two actual layout attempts per unchanged chapter, across calls/restarts.
 * This never synthesizes speech or changes a verified lesson script. */
export async function recoverLessonHtml<R extends SceneResult>(options: {
  project: string; chapterId: string; contextHash: string; format: Format;
  author: (feedback: string) => Promise<HtmlDrawing>;
  produce: (drawing: HtmlDrawing) => Promise<R>;
  nativeFallback?: () => Promise<R>;
}): Promise<R> {
  throwIfJobCancelled();
  const stateFile = path.join(options.project, 'html-recovery.json');
  let state: HtmlState<R> = { version: 1, contextHash: options.contextHash, attempts: 0, failed: [] };
  let stored: string | undefined, restoredFromHistory=false;
  try { stored = await readFile(stateFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取HTML局部恢复状态，保留原文件并停止。', { cause: error }); }
  if (stored !== undefined) {
    const saved=parseHtmlState<R>(stored);
    if (saved.contextHash === options.contextHash) state = saved;
    else {
      // Every state revision is immutable evidence. The context's atomic
      // latest pointer advances as its check budget progresses; it does not
      // mistake a later valid state for a conflicting immutable snapshot.
      const history = path.join(options.project, 'html-recovery-history');
      const directory=(contextHash:string)=>path.join(history,hashBytes(contextHash));
      const loadLatest=async(contextHash:string):Promise<string|undefined>=>{
        let pointer:string;
        try{pointer=await readFile(path.join(directory(contextHash),'latest.json'),'utf8');}
        catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
        let latest:{version:number;contextHash:string;stateHash:string};
        try{latest=JSON.parse(pointer);}catch(error){throw new Error('HTML局部恢复历史索引JSON损坏，保留原文件并停止。',{cause:error});}
        if(latest?.version!==1||latest.contextHash!==contextHash||!String(latest.stateHash).match(/^[a-f0-9]{64}$/))throw new Error('HTML局部恢复历史索引内容无效，保留原文件并停止。');
        const bytes=await readFile(path.join(directory(contextHash),latest.stateHash+'.json'),'utf8');
        if(hashBytes(bytes)!==latest.stateHash)throw new Error('HTML局部恢复历史内容SHA冲突，保留原文件并停止。');
        if(parseHtmlState<R>(bytes).contextHash!==contextHash)throw new Error('HTML局部恢复历史上下文哈希不一致，保留原文件并停止。');
        return bytes;
      };
      const prior=await loadLatest(saved.contextHash);
      if(prior!==undefined){
        const previous=parseHtmlState<R>(prior);
        if(saved.attempts<previous.attempts||previous.failed.some((failure,index)=>JSON.stringify(saved.failed[index])!==JSON.stringify(failure))||previous.blocked&&!saved.blocked||previous.completed&&JSON.stringify(previous.completed)!==JSON.stringify(saved.completed)||previous.native&&(!saved.native||previous.native.claimHash!==saved.native.claimHash||previous.native.status!=='running'&&JSON.stringify(previous.native)!==JSON.stringify(saved.native)))throw new Error('HTML局部恢复历史检查预算或证据倒退，保留原文件并停止。');
      }
      const archiveDirectory=directory(saved.contextHash),stateHash=hashBytes(stored);
      await mkdir(archiveDirectory,{recursive:true,mode:0o700});
      const archive=path.join(archiveDirectory,stateHash+'.json');
      try{await writeFile(archive,stored,{mode:0o600,flag:'wx'});}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        if(await readFile(archive,'utf8')!==stored)throw new Error('HTML局部恢复历史内容SHA冲突，保留原文件并停止。',{cause:error});
      }
      const latest=path.join(archiveDirectory,'latest.json'),temporary=latest+'.'+randomUUID()+'.tmp';
      await writeFile(temporary,JSON.stringify({version:1,contextHash:saved.contextHash,stateHash}),{mode:0o600});await rename(temporary,latest);
      const target=await loadLatest(options.contextHash);
      if(target!==undefined){state=parseHtmlState<R>(target);restoredFromHistory=true;}
    }
  }
  const persist = async () => { const temporary = stateFile + '.' + randomUUID() + '.tmp'; await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, stateFile); };
  if(restoredFromHistory)await persist();
  const nativeDirectory=path.join(options.project,'html-recovery-native',hashBytes(options.contextHash)),claimFile=path.join(nativeDirectory,'started.json'),terminalFile=path.join(nativeDirectory,'terminal.json');
  let nativeClaim:Buffer|undefined;
  try{nativeClaim=await readFile(claimFile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(nativeClaim){
    if(!state.native||hashBytes(nativeClaim)!==state.native.claimHash)throw new LessonHtmlLayoutError(options.chapterId+'：原生恢复已启动但状态缺失或倒退，不能重试。');
    const claim=JSON.parse(nativeClaim.toString());
    if(claim.version!==1||claim.contextHash!==options.contextHash||JSON.stringify(claim.evidence)!==JSON.stringify(state.failed.map(f=>f.evidence?.manifestHash)))throw new Error('HTML原生恢复启动证据内容不一致，保留原文件并停止。');
    for(const failure of state.failed)if(!await verifyAttemptEvidence(options.project,failure.evidence,options.contextHash))throw new Error('HTML原生恢复缺少已保存的真实几何失败，保留原文件并停止。');
    if(state.native.status!=='running'){
      const terminal=await readFile(terminalFile);if(hashBytes(terminal)!==state.native.terminalHash)throw new Error('HTML原生恢复终态SHA不一致，保留原文件并停止。');
      const record=JSON.parse(terminal.toString());if(record.status!==state.native.status||record.claimHash!==state.native.claimHash||JSON.stringify(record.completed)!==JSON.stringify(state.completed)||JSON.stringify(record.evidence)!==JSON.stringify(state.native.evidence))throw new Error('HTML原生恢复终态内容不一致，保留原文件并停止。');
    }
  }else if(state.native)throw new Error('HTML原生恢复启动证据缺失，保留原文件并停止。');
  if (state.completed) {
    try { if (hashBytes(await readFile(state.completed.result.file)) === state.completed.fileHash && state.completed.fileHash === state.completed.result.analysis.sourceHash) return state.completed.result; } catch {}
    throw new LessonHtmlLayoutError(options.chapterId + '：已核验分镜文件已改变或缺失，不能复用或原样重试。');
  }
  const exhausted = () => new LessonHtmlLayoutError(options.chapterId + '：实际HTML布局局部恢复已停止（检查' + state.attempts + '/2）；保留已核验脚本、旁白与其他章节。' + (state.failed.at(-1)?.feedback || ''));
  if(state.native)throw new LessonHtmlLayoutError(options.chapterId+'：原生恢复已'+state.native.status+'，不能自动再次执行。');
  while (state.attempts < 2 && !state.blocked) {
    throwIfJobCancelled();
    const prior = state.failed.at(-1), drawing = validateDrawing(state.pendingDrawing || await options.author(prior?.feedback || ''), options.format);
    state.pendingDrawing = undefined;
    const hash = hashBytes(JSON.stringify(drawing));
    if (state.failed.some(failure => failure.hash === hash)) { state.blocked = true; await persist(); throw exhausted(); }
    state.attempts++; await persist();
    try {
      await clearCurrentReports(options.project);
      const result = await options.produce(drawing), fileHash = hashBytes(await readFile(result.file));
      if (fileHash !== result.analysis.sourceHash) throw new Error('实际图解文件哈希与返回的转写来源不一致。');
      state.completed = { drawing, result, fileHash }; await persist(); return result;
    } catch (error) {
      if (!/HTML (?:check|lint|inspect) 未通过/.test(String(error))) { state.attempts--; await persist(); throwIfJobCancelled(); throw error; }
      throwIfJobCancelled();
      let report: LayoutReport | undefined;
      try { report = JSON.parse(await readFile(path.join(options.project, 'check-report.json'), 'utf8')); } catch {}
      const feedback = String(error) + '；仅修复报告中的实际几何布局，保留完整原话、数值、来源与旁白。上一版布局：' + JSON.stringify(drawing);
      const evidence=await archiveAttempt(options.project,options.contextHash,'authored-'+state.attempts,error);
      state.failed.push({ hash, feedback, drawing, report, ...(evidence?{evidence}:{}) });
      if(report){
        const issues=htmlLayoutIssues(report),proposal=separateCardLabels(drawing,issues,options.format)||liftCardLabels(drawing,issues,options.format)||reflowCardDetails(drawing,issues,options.format);
        if(proposal&&drawingContentHash(proposal)===drawingContentHash(drawing))try{state.pendingDrawing=validateDrawing(proposal,options.format);}catch{/* Unsafe geometry requires the remaining authored redraw. */}
      }
      await persist();
    }
  }
  if(options.nativeFallback&&state.attempts===2&&state.failed.length===2){
    for(const failure of state.failed)if(!await verifyAttemptEvidence(options.project,failure.evidence,options.contextHash))throw exhausted();
    throwIfJobCancelled();
    await mkdir(nativeDirectory,{recursive:true,mode:0o700});
    const claim=JSON.stringify({version:1,contextHash:options.contextHash,evidence:state.failed.map(f=>f.evidence!.manifestHash)});
    // This immutable claim is also a second guard against a rolled-back state
    // or an interrupted process. An unknown execution is never replayed.
    try{await writeFile(claimFile,claim,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new LessonHtmlLayoutError(options.chapterId+'：原生恢复已有启动证据，不能重试。');throw error;}
    state.native={status:'running',claimHash:hashBytes(claim)};await persist();
    try{
      await clearCurrentReports(options.project);throwIfJobCancelled();
      const result=await options.nativeFallback();throwIfJobCancelled();const fileHash=hashBytes(await readFile(result.file));
      if(fileHash!==result.analysis.sourceHash)throw new Error('实际原生分镜文件哈希与返回的转写来源不一致。');
      const completed={rendererKind:'native' as const,result,fileHash},terminal=JSON.stringify({status:'completed',claimHash:state.native.claimHash,completed});
      await immutableWrite(terminalFile,terminal);state.completed=completed;state.native={...state.native,status:'completed',terminalHash:hashBytes(terminal)};await persist();return result;
    }catch(error){
      const evidence=await archiveAttempt(options.project,options.contextHash,'native-1',error);
      const status=currentJobSignal()?.aborted?'cancelled' as const:'failed' as const,terminal=JSON.stringify({status,claimHash:state.native.claimHash,error:String(error),...(evidence?{evidence}:{})});
      await immutableWrite(terminalFile,terminal);state.native={...state.native,status,terminalHash:hashBytes(terminal),...(evidence?{evidence}:{})};await persist();throwIfJobCancelled();throw error;
    }
  }
  throw exhausted();
}
