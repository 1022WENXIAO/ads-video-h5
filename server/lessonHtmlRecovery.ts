import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, serialize } from 'parse5';
import type { Format } from '../src/types';
import { drawingDimensions, drawingDomId, drawingHtml, hashBytes, svgCardLabelZones, validateDrawing, type HtmlDrawing } from './narrativeScenes';
import {fitNumericDrawingSlots} from './drawingNumberLayout';
import { currentJobSignal, throwIfJobCancelled } from './jobExecution';
import { liftCardLabels, reflowCardDetails } from './drawingCardLayout';
import {AuthoredDrawingGeometryError} from './drawingGeometry';

type EvidenceFile = {path:string;sha256:string};
type LayoutIssue = { code: string; severity?: string; selector?: string; containerSelector?: string; source?:string;htmlHash?:string;text?:string;time?:number;coveredFraction?:number;evidence?:EvidenceFile };
type LayoutReport = { ok?: boolean; issues?: LayoutIssue[]; findings?: LayoutIssue[]; layout?: { findings?: LayoutIssue[] }; lint?: { findings?: LayoutIssue[] }; runtime?: { ok?: boolean; findings?: LayoutIssue[] }; motion?: { findings?: LayoutIssue[] }; contrast?: { findings?: LayoutIssue[] };svgPaint?:{source:string;version:number;htmlHash:string;samples:number[];findings:LayoutIssue[];report:EvidenceFile;upstreamReport:EvidenceFile;upstreamStdout:EvidenceFile} };
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
    const selectors = [issue.selector, issue.containerSelector];
    if(selectors.some(selector=>!selector||!/^#[a-zA-Z][a-zA-Z0-9_-]*$/.test(selector)))return;
    const compiled=selectors.map(selector=>next.nodes.filter(node=>'#'+drawingDomId(node.id)===selector));
    // Match whole generated IDs, including logical IDs already containing the
    // namespace. Mixed/unknown selectors and framework nodes are not evidence.
    const legacy=()=>selectors.some(selector=>/^#(?:main|title|note|ambient-a|ambient-b)$/.test(selector!))?undefined:selectors.map(selector=>next.nodes.filter(node=>'#'+node.id===selector));
    const matches=compiled.some(nodes=>nodes.length)?compiled:legacy();
    if(!matches||matches.some(nodes=>nodes.length!==1))return;
    const pair = matches.map(nodes=>nodes[0]);
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

/** A measured products-path paint collision may put the complete label in a
 * conservative path-free content zone. Declared boxes only propose a layout;
 * real loaded-font/paint/contrast checks still consume the remaining attempt. */
export function splitSvgCoveredCardLabels(drawing:HtmlDrawing,report:LayoutReport,format:Format,html:string):HtmlDrawing|undefined{
  const svg=report.svgPaint,htmlHash=hashBytes(html),issues=reportIssues(report);
  if(drawing.serverCardLabels!==undefined||report.ok!==false||report.runtime?.ok===false||!issues.length||!svg||svg.source!=='server-svg-paint'||svg.version!==1||svg.htmlHash!==htmlHash||!Array.isArray(svg.samples)||svg.samples.length!==9||!svg.samples.every(t=>Number.isFinite(t)&&t>=0)||!Array.isArray(svg.findings))return;
  if([svg.report,svg.upstreamReport,svg.upstreamStdout].some(reference=>!reference||typeof reference.path!=='string'||!/^[a-f0-9]{64}$/.test(reference.sha256)))return;
  try{validateDrawing(drawing,format);}catch{return;}
  // Bind the complete current author plane to this exact drawing, including
  // positions, original text, fonts, paths and compiled IDs. A stale drawing
  // with matching label text is not the candidate that was measured.
  const elements=(source:string,predicate:(node:any)=>boolean)=>{const found:any[]=[];const visit=(node:any)=>{if(predicate(node))found.push(node);for(const child of node.childNodes||[])visit(child);};visit(parse(source));return found;};
  const attr=(node:any,name:string)=>node?.attrs?.find((a:any)=>a.name===name)?.value;
  const compositions=elements(html,node=>attr(node,'data-composition-id')==='main'),planes=elements(html,node=>attr(node,'class')==='drawing-plane');
  const duration=Number(attr(compositions[0],'data-duration'));
  if(compositions.length!==1||planes.length!==1||!Number.isFinite(duration)||duration<=0||duration>600)return;
  const expected=elements(drawingHtml(drawing,duration,format),node=>attr(node,'class')==='drawing-plane');
  if(expected.length!==1||serialize(planes[0])!==serialize(expected[0]))return;
  const cards=new Set<string>();
  for(const issue of issues){
    if(issue.code!=='text_occluded'||issue.severity!=='error'||issue.source!=='server-svg-paint'||issue.htmlHash!==htmlHash||!isDeepStrictEqual(issue.evidence,svg.report)||!Number.isFinite(issue.time)||!svg.samples.includes(issue.time!)||!(issue.coveredFraction!>0&&issue.coveredFraction!<=1))return;
    const {source:_source,htmlHash:_hash,evidence:_evidence,...observation}=issue;
    if(!svg.findings.some(finding=>isDeepStrictEqual(finding,observation)))return;
    const card=drawing.nodes.filter(n=>'#'+drawingDomId(n.id)===issue.selector),paths=drawing.nodes.filter(n=>'#'+drawingDomId(n.id)===issue.containerSelector);
    if(card.length!==1||paths.length!==1||card[0].kind!=='card'||!card[0].text.trim()||card[0].text!==issue.text||paths[0].kind!=='path'||paths[0].text!==''||!contains(card[0],paths[0]))return;
    cards.add(card[0].id);
  }
  const next=structuredClone(drawing);next.serverCardLabels=[];
  for(const id of cards){
    const card=next.nodes.find(n=>n.id===id)!,labelId=id+'_svg_label';
    if(labelId.length>64||next.nodes.some(n=>n.id===labelId))return;
    const text=card.text,zones=svgCardLabelZones(next,card),minimum=Math.max(32,Math.ceil(card.fontSize*.9));let label:HtmlDrawing['nodes'][number]|undefined;
    for(let font=card.fontSize;font>=minimum&&!label;font--){
      for(const zone of zones){
        // Whole glyphs cannot share the unused fraction at each line end.
        // This is a conservative candidate estimate, not a font measurement.
        const lines=text.split(/\r?\n/).reduce((sum,line)=>{let rows=1,width=0;for(const char of line){const glyph=(/[\u0000-\u007f]/.test(char)?.55:1)*font;if(glyph>zone.w)return Infinity;if(width&&width+glyph>zone.w){rows++;width=0;}width+=glyph;}return sum+rows;},0);
        if(lines*font*1.3<=zone.h){label={...card,...zone,id:labelId,kind:'text',fontSize:font,highlight:false};break;}
      }
    }
    if(!label)return;
    next.nodes.push(label);card.text='';next.serverCardLabels.push({cardId:id,labelId,text,fontSize:label.fontSize});
  }
  if(drawingContentHash(next)!==drawingContentHash(drawing))return;
  try{return validateDrawing(next,format);}catch{return;}
}

async function verifiedSvgCardLabelProposal(project:string,drawing:HtmlDrawing,report:LayoutReport,format:Format):Promise<HtmlDrawing|undefined>{
  const svg=report.svgPaint;if(!svg)return;
  const html=await readFile(path.join(project,'index.html'),'utf8'),proposal=splitSvgCoveredCardLabels(drawing,report,format,html);if(!proposal)return;
  const directory=path.dirname(svg.report.path),expectedRoot=path.join('svg-paint-evidence',svg.htmlHash);
  if(path.dirname(directory)!==expectedRoot||!/^([a-f0-9]{64})-[a-f0-9-]{36}$/.test(path.basename(directory))||path.basename(svg.report.path)!=='server-svg-paint-report.json')return;
  if(!/^(?:check|lint|inspect)-hyperframes-report\.json$/.test(path.basename(svg.upstreamReport.path))||! /^(?:check|lint|inspect)-hyperframes-stdout\.txt$/.test(path.basename(svg.upstreamStdout.path)))return;
  for(const reference of [svg.report,svg.upstreamReport,svg.upstreamStdout]){
    if(!reference||path.dirname(reference.path)!==directory||!/^[a-f0-9]{64}$/.test(reference.sha256))return;
    let bytes:Buffer;try{bytes=await readFile(path.join(project,reference.path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}if(hashBytes(bytes)!==reference.sha256)return;
    if(reference!==svg.upstreamStdout){let parsed:any;try{parsed=JSON.parse(bytes.toString());}catch{return;}
      if(reference===svg.report){const {report:_reference,...observation}=svg;if(!isDeepStrictEqual(parsed,observation))return;}
      else if(parsed.ok!==true||reportIssues(parsed).length)return;
    }
  }
  if(await readFile(path.join(project,'index.html'),'utf8')!==html)return;
  return proposal;
}

interface SceneResult { file: string; analysis: { sourceHash: string }; }
interface AttemptEvidence { directory: string; manifestHash: string; geometry: boolean; kind?:'authored-proposal'; }
type NativeRecoveryReason = 'geometry' | 'static-sweep' | 'authored-geometry';
interface NativeState { status: 'running' | 'failed' | 'cancelled' | 'completed'; claimHash: string; terminalHash?: string; evidence?: AttemptEvidence; reason?: NativeRecoveryReason; }
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
  if(saved.failed.some(f=>f.evidence?.kind!==undefined&&f.evidence.kind!=='authored-proposal'))throw new Error('HTML恢复证据类型无效，保留原文件并停止。');
  if(saved.native&&(!['running','failed','cancelled','completed'].includes(saved.native.status)||!/^[a-f0-9]{64}$/.test(saved.native.claimHash)||saved.native.terminalHash!==undefined&&!/^[a-f0-9]{64}$/.test(saved.native.terminalHash)||saved.native.reason!==undefined&&!['geometry','static-sweep','authored-geometry'].includes(saved.native.reason)||saved.attempts!==2||saved.failed.length!==2))throw new Error('HTML原生恢复状态无效，保留原文件并停止。');
  return saved;
}
export class LessonHtmlLayoutError extends Error { code = 'HTML_LAYOUT_EXHAUSTED'; }

const artifactNames=['index.html','check-report.json','lint-report.json','inspect-report.json','check-failure.json','lint-failure.json','inspect-failure.json'] as const;
const geometryCodes=new Set(['content_overlap','text_occluded','text_overflow','out_of_bounds','element_out_of_bounds','overflow']);
const nativeGeometryCodes=new Set([...geometryCodes,'text_box_overflow']);
const reportNames=['check-report.json','lint-report.json','inspect-report.json'] as const;
const proposalNames=['draft.json','server-validation.json','raw-proposal.json'] as const;
const recoveryReason=(reasons:NativeRecoveryReason[]):NativeRecoveryReason=>reasons.includes('static-sweep')?'static-sweep':reasons.includes('authored-geometry')?'authored-geometry':'geometry';
const reportIssues=(report:LayoutReport):LayoutIssue[]=>[...(report.issues||report.findings||[]),...['layout','lint','runtime','motion','contrast'].flatMap(key=>(report as any)[key]?.findings||[])].filter(issue=>!issue.severity||issue.severity==='error');

// This is eligibility to render a different native scene, never permission to
// accept the failed authored HTML. Only the server's explicit local paused
// GSAP timeline contract qualifies; comments and quoted examples do not.
function hasPausedRegisteredGsap(html:string):boolean{
  let localGsap=false;const scripts:string[]=[];
  const visit=(node:any)=>{
    if(node.nodeName==='script'){
      const type=(node.attrs?.find((a:any)=>a.name==='type')?.value||'').trim().toLowerCase();
      if(!['','text/javascript','application/javascript'].includes(type)||node.attrs?.some((a:any)=>a.name==='nomodule'))return;
      const src=node.attrs?.find((a:any)=>a.name==='src')?.value;
      if(src==='./gsap.min.js')localGsap=true;
      if(!src)scripts.push((node.childNodes||[]).filter((n:any)=>n.nodeName==='#text').map((n:any)=>n.value).join(''));
    }
    for(const child of node.childNodes||[])visit(child);
  };visit(parse(html));
  return localGsap&&scripts.some(script=>{
    const code=script.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,' ');
    const topLevel=(at:number)=>{let depth=0;for(const char of code.slice(0,at)){if(char==='{')depth++;else if(char==='}')depth--;}return depth===0;};
    for(const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*gsap\.timeline\(\{\s*paused\s*:\s*true\s*\}\)\s*;/g)){
      if(!topLevel(match.index!))continue;
      const variable=match[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const after=match.index!+match[0].length,registered=new RegExp('\\bwindow\\.__timelines\\.[A-Za-z_$][\\w$]*\\s*=\\s*'+variable+'\\s*;').exec(code.slice(after));
      if(registered&&topLevel(after+registered.index))return true;
    }return false;
  });
}
function nativeEvidenceReason(artifacts:Map<string,Buffer>):NativeRecoveryReason|undefined{
  let failed=false,staticSweep=false;
  for(const name of reportNames){
    const bytes=artifacts.get(name);if(!bytes)continue;
    const report=JSON.parse(bytes.toString()) as LayoutReport,issues=reportIssues(report);
    if(report.runtime?.ok===false)return;
    if(report.ok===true&&!issues.length)continue;
    if(report.ok!==false||!issues.length||issues.some(issue=>!nativeGeometryCodes.has(issue.code)&&issue.code!=='sweep_static'))return;
    failed=true;
    if(issues.some(issue=>issue.code==='sweep_static')){if(report.runtime?.ok!==true)return;staticSweep=true;}
  }
  if(!failed||staticSweep&&!hasPausedRegisteredGsap(artifacts.get('index.html')!.toString()))return;
  return staticSweep?'static-sweep':'geometry';
}
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
  for(const file of reportNames){
    const bytes=artifacts.get(file);if(!bytes)continue;
    let report:LayoutReport;try{report=JSON.parse(bytes.toString());}catch(cause){throw new Error('HTML实际检查报告JSON损坏，保留原文件并停止。',{cause});}
    const issues=reportIssues(report);
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
function verifyRejectedProposal(error:AuthoredDrawingGeometryError,format:Format){
  if(error.format!==format)throw new Error('HTML被拒提案的画幅与当前上下文不一致。');
  try{validateDrawing(error.draft,format);}
  catch(actual){if(actual instanceof AuthoredDrawingGeometryError&&JSON.stringify(actual.issues)===JSON.stringify(error.issues))return;throw new Error('HTML被拒提案无法确认是已知纯几何错误，保留原文件并停止。',{cause:actual});}
  throw new Error('HTML提案未被实际几何校验拒绝，不能伪造恢复证据。');
}
async function archiveProposal(project:string,contextHash:string,name:string,error:AuthoredDrawingGeometryError):Promise<AttemptEvidence>{
  verifyRejectedProposal(error,error.format);
  const draft=JSON.stringify(error.draft),draftHash=hashBytes(draft),artifacts=new Map<string,string>([['draft.json',draft],['server-validation.json',JSON.stringify({version:1,kind:'authored-geometry-rejected',format:error.format,draftHash,issues:error.issues,htmlChecked:false,accepted:false})]]);
  if(error.rawProposal!==undefined){JSON.parse(error.rawProposal);artifacts.set('raw-proposal.json',error.rawProposal);}
  const directory=path.join('html-recovery-evidence',hashBytes(contextHash),name),absolute=path.join(project,directory);await mkdir(absolute,{recursive:true,mode:0o700});
  const files:Record<string,string>={};for(const[file,bytes]of artifacts){files[file]=hashBytes(bytes);await immutableWrite(path.join(absolute,file),bytes);}
  const manifest=JSON.stringify({version:1,contextHash,name,kind:'authored-proposal',files,geometry:false,reason:String(error)});await immutableWrite(path.join(absolute,'manifest.json'),manifest);
  return{directory,manifestHash:hashBytes(manifest),geometry:false,kind:'authored-proposal'};
}
async function verifyAttemptEvidence(project:string,evidence:AttemptEvidence|undefined,contextHash:string,format:Format,expectedDraftHash?:string):Promise<NativeRecoveryReason|undefined>{
  if(!evidence)return;
  const root=path.join('html-recovery-evidence',hashBytes(contextHash));
  if(path.dirname(evidence.directory)!==root||!/^authored-[12]$/.test(path.basename(evidence.directory)))throw new Error('HTML恢复证据路径无效，保留原文件并停止。');
  const bytes=await readFile(path.join(project,evidence.directory,'manifest.json'));
  if(hashBytes(bytes)!==evidence.manifestHash)throw new Error('HTML恢复证据manifest SHA不一致，保留原文件并停止。');
  const manifest=JSON.parse(bytes.toString());
  if(manifest.version!==1||manifest.contextHash!==contextHash||manifest.geometry!==evidence.geometry||manifest.kind!==evidence.kind)throw new Error('HTML恢复证据内容无效，保留原文件并停止。');
  if(manifest.kind==='authored-proposal'){
    if(evidence.geometry!==false||!manifest.files?.['draft.json']||!manifest.files?.['server-validation.json'])throw new Error('HTML被拒提案证据内容无效，不能作为已检查HTML。');
    const artifacts=new Map<string,Buffer>();for(const[file,hash]of Object.entries(manifest.files)){if(!proposalNames.includes(file as any))throw new Error('HTML被拒提案含未知证据文件。');const bytes=await readFile(path.join(project,evidence.directory,file));if(hashBytes(bytes)!==hash)throw new Error('HTML被拒提案证据SHA不一致，保留原文件并停止。');artifacts.set(file,bytes);}
    const draft=JSON.parse(artifacts.get('draft.json')!.toString()) as HtmlDrawing,report=JSON.parse(artifacts.get('server-validation.json')!.toString());
    if(report.version!==1||report.kind!=='authored-geometry-rejected'||report.htmlChecked!==false||report.accepted!==false||report.draftHash!==expectedDraftHash||report.draftHash!==hashBytes(artifacts.get('draft.json')!)||report.format!==format)throw new Error('HTML被拒提案校验绑定无效。');
    if(artifacts.has('raw-proposal.json'))JSON.parse(artifacts.get('raw-proposal.json')!.toString());
    verifyRejectedProposal(new AuthoredDrawingGeometryError(draft,report.format,report.issues,'已保存的被拒提案'),report.format);return'authored-geometry';
  }
  if(!manifest.files?.['index.html'])throw new Error('HTML恢复缺少实际页面证据。');
  const artifacts=new Map<string,Buffer>();
  for(const[file,hash]of Object.entries(manifest.files)){if(!artifactNames.includes(file as any))throw new Error('HTML恢复实际文件SHA不一致，保留原文件并停止。');const bytes=await readFile(path.join(project,evidence.directory,file));if(hashBytes(bytes)!==hash)throw new Error('HTML恢复实际文件SHA不一致，保留原文件并停止。');artifacts.set(file,bytes);}
  // Keep the original geometry=false manifest immutable. Static sweep is a
  // separate, tightly checked recovery reason derived from its actual bytes.
  return nativeEvidenceReason(artifacts);
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
    const reasons:NativeRecoveryReason[]=[];
    for(const failure of state.failed){const reason=await verifyAttemptEvidence(options.project,failure.evidence,options.contextHash,options.format,failure.hash);if(!reason)throw new Error('HTML原生恢复缺少已保存的真实布局失败，保留原文件并停止。');reasons.push(reason);}
    const reason=recoveryReason(reasons);
    if(claim.reason!==state.native.reason||claim.reason!==undefined&&claim.reason!==reason||claim.reason===undefined&&reason!=='geometry')throw new Error('HTML原生恢复启动原因与实际证据不一致，保留原文件并停止。');
    if(state.native.status!=='running'){
      const terminal=await readFile(terminalFile);if(hashBytes(terminal)!==state.native.terminalHash)throw new Error('HTML原生恢复终态SHA不一致，保留原文件并停止。');
      const record=JSON.parse(terminal.toString());if(record.status!==state.native.status||record.claimHash!==state.native.claimHash||record.reason!==state.native.reason||JSON.stringify(record.completed)!==JSON.stringify(state.completed)||JSON.stringify(record.evidence)!==JSON.stringify(state.native.evidence))throw new Error('HTML原生恢复终态内容不一致，保留原文件并停止。');
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
    const prior = state.failed.at(-1);let drawing:HtmlDrawing;
    try{
      const proposed=state.pendingDrawing || await options.author(prior?.feedback || ''),[width,height]=drawingDimensions(options.format);
      drawing=validateDrawing(fitNumericDrawingSlots(proposed,{left:40,top:height>width?220:160,right:width-40,bottom:height>width?1010:height-170})||proposed,options.format);
    }
    catch(error){
      throwIfJobCancelled();if(!(error instanceof AuthoredDrawingGeometryError))throw error;
      verifyRejectedProposal(error,options.format);
      state.pendingDrawing=undefined;state.attempts++;await persist();
      const hash=hashBytes(JSON.stringify(error.draft)),feedback=String(error)+'；被拒的是绘图提案，尚未通过HTML检查；仅修复上述实际几何，保留已核验脚本、旁白和用户要求。';
      const evidence=await archiveProposal(options.project,options.contextHash,'authored-'+state.attempts,error);
      state.failed.push({hash,feedback,drawing:error.draft,evidence});await persist();continue;
    }
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
        const issues=htmlLayoutIssues(report),proposal=state.attempts<2&&await verifiedSvgCardLabelProposal(options.project,drawing,report,options.format)||separateCardLabels(drawing,issues,options.format)||liftCardLabels(drawing,issues,options.format)||reflowCardDetails(drawing,issues,options.format);
        if(proposal&&drawingContentHash(proposal)===drawingContentHash(drawing))try{state.pendingDrawing=validateDrawing(proposal,options.format);}catch{/* Unsafe geometry requires the remaining authored redraw. */}
      }
      await persist();
    }
  }
  if(options.nativeFallback&&state.attempts===2&&state.failed.length===2){
    const reasons:NativeRecoveryReason[]=[];
    for(const failure of state.failed){const reason=await verifyAttemptEvidence(options.project,failure.evidence,options.contextHash,options.format,failure.hash);if(!reason)throw exhausted();reasons.push(reason);}
    const reason=recoveryReason(reasons);
    throwIfJobCancelled();
    await mkdir(nativeDirectory,{recursive:true,mode:0o700});
    const claim=JSON.stringify({version:1,contextHash:options.contextHash,reason,evidence:state.failed.map(f=>f.evidence!.manifestHash)});
    // This immutable claim is also a second guard against a rolled-back state
    // or an interrupted process. An unknown execution is never replayed.
    try{await writeFile(claimFile,claim,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new LessonHtmlLayoutError(options.chapterId+'：原生恢复已有启动证据，不能重试。');throw error;}
    state.native={status:'running',claimHash:hashBytes(claim),reason};await persist();
    try{
      await clearCurrentReports(options.project);throwIfJobCancelled();
      const result=await options.nativeFallback();throwIfJobCancelled();const fileHash=hashBytes(await readFile(result.file));
      if(fileHash!==result.analysis.sourceHash)throw new Error('实际原生分镜文件哈希与返回的转写来源不一致。');
      const completed={rendererKind:'native' as const,result,fileHash},terminal=JSON.stringify({status:'completed',claimHash:state.native.claimHash,reason,completed});
      await immutableWrite(terminalFile,terminal);state.completed=completed;state.native={...state.native,status:'completed',terminalHash:hashBytes(terminal)};await persist();return result;
    }catch(error){
      const evidence=await archiveAttempt(options.project,options.contextHash,'native-1',error);
      const status=currentJobSignal()?.aborted?'cancelled' as const:'failed' as const,terminal=JSON.stringify({status,claimHash:state.native.claimHash,reason,error:String(error),...(evidence?{evidence}:{})});
      await immutableWrite(terminalFile,terminal);state.native={...state.native,status,terminalHash:hashBytes(terminal),...(evidence?{evidence}:{})};await persist();throwIfJobCancelled();throw error;
    }
  }
  throw exhausted();
}
