import {parse,serialize} from 'parse5';
import type {Format} from '../src/types';
import {drawingHtml,hashBytes,validateDrawing,type HtmlDrawing} from './narrativeScenes';

const geometry=new Set(['content_overlap','text_occluded','text_overflow','out_of_bounds','element_out_of_bounds','overflow','text_box_overflow']);
const errors=(report:any):any[]=>[...(report.issues||report.findings||[]),...Object.values(report).flatMap((part:any)=>part&&typeof part==='object'&&Array.isArray(part.findings)?part.findings:[])].filter(issue=>!issue.severity||issue.severity==='error');
const content=(drawing:HtmlDrawing)=>hashBytes(JSON.stringify({title:drawing.title,text:drawing.nodes.map(node=>node.text).filter(Boolean).sort()}));
const attr=(node:any,key:string)=>node.attrs?.find((a:any)=>a.name===key)?.value;
function elements(html:string,predicate:(node:any)=>boolean){const found:any[]=[];const visit=(node:any)=>{if(predicate(node))found.push(node);for(const child of node.childNodes||[])visit(child);};visit(parse(html));return found;}
function bindsDrawing(html:string,drawing:HtmlDrawing,format:Format):boolean{
  try{validateDrawing(drawing,format);}catch{return false;}
  const roots=elements(html,node=>attr(node,'data-composition-id')==='main'),planes=elements(html,node=>attr(node,'class')==='drawing-plane'),duration=Number(attr(roots[0],'data-duration'));
  if(roots.length!==1||planes.length!==1||!(duration>0&&duration<=600))return false;
  const expected=elements(drawingHtml(drawing,duration,format),node=>attr(node,'class')==='drawing-plane');
  return expected.length===1&&serialize(planes[0])===serialize(expected[0]);
}

/** Eligibility for one *new, checked* native scene. Old contrast failures stay
 * immutable; only the next complete check can prove they were repaired. */
export function resolvedContrastRecovery(before:Map<string,Buffer>,after:Map<string,Buffer>,drawings:HtmlDrawing[],format:Format):boolean{
  if(drawings.length!==2||content(drawings[0])!==content(drawings[1]))return false;
  const reports:any[]=[];
  for(const [index,files] of [before,after].entries()){
    const html=files.get('index.html'),bytes=files.get('check-report.json');
    if(!html||!bytes||!bindsDrawing(html.toString(),drawings[index],format))return false;
    let report:any;try{report=JSON.parse(bytes.toString());}catch{return false;}
    if(report.ok!==false||report.runtime?.ok!==true||report.lint?.ok!==true||report.motion?.ok!==true||!report.contrast||!report.layout||report.layout.truncated!==false)return false;
    const samples=report.layout.samples;
    if(!Number.isFinite(report.layout.duration)||report.layout.duration<=0||!Array.isArray(samples)||samples.length!==9||!samples.every((v:any,i:number)=>Number.isFinite(v)&&v>=0&&v<report.layout.duration&&(!i||v>samples[i-1])))return false;
    // No unknown/runtime/contrast failure can hide in another report or section.
    for(const [name,part] of Object.entries(report) as Array<[string,any]>)if(part&&typeof part==='object'&&part.ok===false&&!['layout','contrast'].includes(name))return false;
    for(const name of ['lint-report.json','inspect-report.json'])if(files.has(name)){
      let extra:any;try{extra=JSON.parse(files.get(name)!.toString());}catch{return false;}
      if(extra.ok!==true||errors(extra).length)return false;
    }
    const issues=errors(report);if(!issues.length)return false;
    if(index===0){
      if(report.layout.ok!==true||report.contrast.ok!==false||issues.some(issue=>issue.code!=='contrast_aa_failure'||!/^#[\w-]+$/.test(issue.selector||'')||!Number.isFinite(issue.ratio)||!Number.isFinite(issue.requiredRatio)||![3,4.5].includes(issue.requiredRatio)||issue.ratio>=issue.requiredRatio))return false;
    }else if(report.contrast.ok!==true||report.contrast.errorCount!==0||report.layout.ok!==false||issues.some(issue=>!geometry.has(issue.code)))return false;
    reports.push(report);
  }
  if(reports[0].layout.duration!==reports[1].layout.duration||JSON.stringify(reports[0].layout.samples)!==JSON.stringify(reports[1].layout.samples))return false;
  const currentSelectors=new Set(errors(reports[1]).map(issue=>issue.selector));
  return errors(reports[0]).every(issue=>currentSelectors.has(issue.selector));
}
