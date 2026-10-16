import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {onJobAbort,throwIfJobCancelled} from './jobExecution';

export interface SvgTextPaintFinding {
  code:'text_occluded'|'content_overlap';severity:'error';time:number;selector:string;containerSelector:string;
  text:string;message:string;coveredFraction:number;
  paintRelation?:'visible-below-stroke';visibleStrokeSamples?:number;
  rect:{left:number;top:number;right:number;bottom:number;width:number;height:number};
  affectedGlyphs?:Array<{char:string;utf16Start:number;utf16End:number;coveredInkSamples:number;totalInkSamples:number;coveredFraction:number;paths:string[];rect:{left:number;top:number;right:number;bottom:number;width:number;height:number}}>;
}
export interface SvgTextPaintReport {version:1;htmlHash:string;samples:number[];findings:SvgTextPaintFinding[];}

/** Runs inside Chromium. Range positions and loaded-font raster ink belong to
 * the current frame; SVG hit tests use painted geometry, never its viewport. */
export function auditSvgTextPaint(input:{time:number}):SvgTextPaintFinding[]{
  const root=document.querySelector('[data-composition-id]')||document.body;
  const nodes=[root,...root.querySelectorAll('*')];
  if(nodes.length>3000)throw new Error('SVG paint inspection exceeds the bounded DOM size.');
  const shapes=nodes.filter((node):node is SVGGeometryElement=>node instanceof SVGGeometryElement&&node.matches('path[data-drawing-id]')&&!node.closest('defs,clipPath,mask,pattern,marker'));
  if(!shapes.length)return[];
  if(shapes.length>128)throw new Error('SVG paint inspection exceeds the bounded geometry count.');
  const opacity=(element:Element)=>{
    let alpha=1;
    for(let node:Element|null=element;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility!=='visible')return 0;
      alpha*=Number(style.opacity);
    }
    return alpha;
  };
  const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;
  const colorContext=colorCanvas.getContext('2d',{willReadFrequently:true});
  const glyphCanvas=document.createElement('canvas'),glyphContext=glyphCanvas.getContext('2d',{willReadFrequently:true});
  if(!colorContext||!glyphContext)throw new Error('SVG paint inspection cannot measure actual glyph ink.');
  const alphaCache=new Map<string,number>();
  const paintAlpha=(color:string)=>{
    if(color==='none'||color==='transparent')return 0;
    if(alphaCache.has(color))return alphaCache.get(color)!;
    if(/url\(/i.test(color))throw new Error('SVG paint inspection cannot infer a paint-server alpha.');
    colorContext.clearRect(0,0,1,1);colorContext.fillStyle=color;colorContext.fillRect(0,0,1,1);
    const value=colorContext.getImageData(0,0,1,1).data[3]/255;alphaCache.set(color,value);return value;
  };
  const selector=(element:Element)=>element.id?'#'+CSS.escape(element.id):element.tagName.toLowerCase();
  const restores:Array<()=>void>=[];
  const override=(node:Element,value:string)=>{
    const style=(node as HTMLElement|SVGElement).style,previous=style.getPropertyValue('pointer-events'),priority=style.getPropertyPriority('pointer-events');
    style.setProperty('pointer-events',value,'important');
    restores.push(()=>previous?style.setProperty('pointer-events',previous,priority):style.removeProperty('pointer-events'));
  };
  // Restore hit testing in page memory only. SVG containers remain transparent
  // to hits; only actual painted shapes/text participate in the paint stack.
  for(const node of nodes){
    if(node instanceof SVGSVGElement)override(node,'none');
    else if(node instanceof SVGGeometryElement||node instanceof SVGTextContentElement)override(node,'visiblePainted');
    else if(node instanceof HTMLElement&&getComputedStyle(node).pointerEvents==='none')override(node,'auto');
  }
  try{
    const measured=shapes.filter(shape=>opacity(shape)>=.6).map(shape=>{
      const style=getComputedStyle(shape),matrix=shape.getScreenCTM();
      if(!matrix||matrix.is2D===false||![matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f].every(Number.isFinite))throw new Error('SVG paint inspection cannot measure this transform.');
      const rect=shape.getBoundingClientRect(),strokeWidth=parseFloat(style.strokeWidth),scale=Math.max(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d)),margin=strokeWidth*scale/2;
      const fillAlpha=opacity(shape)*Number(style.fillOpacity)*paintAlpha(style.fill),strokeAlpha=opacity(shape)*Number(style.strokeOpacity)*paintAlpha(style.stroke);
      const dash=style.strokeDasharray==='none'?[]:style.strokeDasharray.split(/[ ,]+/).filter(Boolean).map(value=>{
        if(!/^[\d.+-]+(?:px)?$/.test(value))throw new Error('SVG paint inspection cannot measure this stroke dash unit.');
        return parseFloat(value);
      });
      if(dash.length%2)dash.push(...dash);
      const total=shape.getTotalLength(),dashOffset=parseFloat(style.strokeDashoffset)||0,pathLength=Number(shape.getAttribute('pathLength'));
      let points:Array<{x:number;y:number;length:number}>|undefined;
      const strokePainted=(point:DOMPoint)=>{
        if(!dash.length||dash.every(value=>value===0))return true;
        const count=Math.min(513,Math.max(2,Math.ceil(total/2)+1));
        points??=Array.from({length:count},(_,index)=>{
          const length=total*index/(count-1),p=shape.getPointAtLength(length);return{x:p.x,y:p.y,length};
        });
        let nearest=points[0],distance=Infinity;
        for(const candidate of points){const d=(candidate.x-point.x)**2+(candidate.y-point.y)**2;if(d<distance){nearest=candidate;distance=d;}}
        const period=dash.reduce((sum,value)=>sum+value,0);let offset=((nearest.length*(pathLength>0?pathLength/total:1)+dashOffset)%period+period)%period;
        for(let index=0;index<dash.length;index++){if(offset<dash[index])return index%2===0;offset-=dash[index];}
        return false;
      };
      return {shape,rect,margin,fillAlpha,strokeAlpha,inverse:matrix.inverse(),strokePainted};
    }).filter(item=>item.fillAlpha>=.6||item.strokeAlpha>=.6);
    const glyphCache=new Map<string,{ink:Array<{x:number;y:number}>;alpha:Uint8ClampedArray;width:number;height:number}>(),issues:SvgTextPaintFinding[]=[];
    // Under-text fills are ordinary label backgrounds. Only an actually drawn
    // stroke can interfere with a transparent label; intervening paint must
    // not hide that stroke. This does not relax the above-text occlusion test.
    const visibleBelowStroke=(item:typeof measured[number],element:Element,x:number,y:number,stack:Element[])=>{
      const textIndex=stack.indexOf(element),pathIndex=stack.indexOf(item.shape);
      if(textIndex<0||pathIndex<=textIndex||item.strokeAlpha<.6)return false;
      const point=new DOMPoint(x,y).matrixTransform(item.inverse);
      if(!item.shape.isPointInStroke(point)||!item.strokePainted(point))return false;
      for(const hit of stack.slice(0,pathIndex)){
        const style=getComputedStyle(hit);
        if(style.filter!=='none'||style.mixBlendMode!=='normal')return false;
        if(hit instanceof HTMLElement){
          if(style.backgroundImage!=='none'||paintAlpha(style.backgroundColor)*opacity(hit)>.01)return false;
          // Other text has its own layout/occlusion checks. Do not infer that
          // a stroke is visible through another label from a DOM hit alone.
          if(hit!==element&&!hit.contains(element)&&!element.contains(hit)&&hit.textContent?.trim())return false;
        }else if(hit instanceof SVGGeometryElement){
          const other=measured.find(candidate=>candidate.shape===hit);if(!other)return false;
          const p=new DOMPoint(x,y).matrixTransform(other.inverse);
          if(other.fillAlpha>=.6&&hit.isPointInFill(p)||other.strokeAlpha>=.6&&hit.isPointInStroke(p)&&other.strokePainted(p))return false;
        }else if(hit instanceof SVGTextContentElement)return false;
      }
      return true;
    };
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let characters=0;
    while(walker.nextNode()){
      const textNode=walker.currentNode,element=textNode.parentElement,text=textNode.textContent||'';
      if(!element||element.closest('script,style,defs,clipPath,mask,pattern,marker')||!text.trim()||opacity(element)<.6)continue;
      const style=getComputedStyle(element);
      if(paintAlpha(style.color)*opacity(element)<.6)continue;
      const font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      let utf16=0,totalInk=0,coveredInk=0,cover:Element|undefined,interferedInk=0,underCover:Element|undefined,visibleStrokeSamples=0;
      const affectedGlyphs:NonNullable<SvgTextPaintFinding['affectedGlyphs']>=[];
      const underGlyphs:NonNullable<SvgTextPaintFinding['affectedGlyphs']>=[];
      const transparentLabel=element instanceof HTMLElement&&paintAlpha(style.backgroundColor)===0&&style.backgroundImage==='none';
      const range=document.createRange();range.selectNodeContents(textNode);const textRect=range.getBoundingClientRect();
      for(const char of text){
        const start=utf16;utf16+=char.length;
        if(!char.trim())continue;
        if(++characters>2048)throw new Error('SVG paint inspection exceeds the bounded text size.');
        range.setStart(textNode,start);range.setEnd(textNode,utf16);
        const rect=range.getBoundingClientRect();if(rect.width<.1||rect.height<.1)continue;
        const nearby=measured.filter(item=>item.rect.left-item.margin<rect.right&&item.rect.right+item.margin>rect.left&&item.rect.top-item.margin<rect.bottom&&item.rect.bottom+item.margin>rect.top);
        glyphContext.font=font;const metrics=glyphContext.measureText(char),ascent=metrics.fontBoundingBoxAscent,descent=metrics.fontBoundingBoxDescent;
        if(!Number.isFinite(ascent+descent)||metrics.width<=0||metrics.width>128||ascent+descent<=0||ascent+descent>128)throw new Error('SVG paint inspection cannot measure the bounded loaded font.');
        const key=font+'\0'+char;
        let glyph=glyphCache.get(key);
        if(!glyph){
          glyphCanvas.width=Math.max(1,Math.ceil(metrics.width));glyphCanvas.height=Math.max(1,Math.ceil(ascent+descent));
          glyphContext.font=font;glyphContext.fillStyle='#000';glyphContext.textBaseline='alphabetic';glyphContext.fillText(char,0,ascent);
          const raster=glyphContext.getImageData(0,0,glyphCanvas.width,glyphCanvas.height),ink:Array<{x:number;y:number}>=[];
          for(let y=1;y<raster.height;y+=2)for(let x=1;x<raster.width;x+=2)if(raster.data[(y*raster.width+x)*4+3]>=128)ink.push({x:(x+.5)/metrics.width,y:(y+.5)/(ascent+descent)});
          glyph={ink,alpha:raster.data,width:raster.width,height:raster.height};glyphCache.set(key,glyph);
        }
        const ink=glyph.ink;
        totalInk+=ink.length;
        if(!nearby.length)continue;
        let glyphCovered=0;const glyphPaths=new Set<string>();
        const under=new Map<typeof measured[number],Array<{x:number;y:number}>>();
        for(const pixel of ink){
          const x=rect.left+pixel.x*rect.width,y=rect.top+pixel.y*rect.height,stack=document.elementsFromPoint(x,y);
          const textIndex=stack.findIndex(hit=>hit===element||element.contains(hit)||hit.contains(element));
          if(textIndex<0)continue;
          const hit=nearby.find(item=>{
            const index=stack.indexOf(item.shape);if(index<0||index>=textIndex)return false;
            const point=new DOMPoint(x,y).matrixTransform(item.inverse);
            return item.fillAlpha>=.6&&item.shape.isPointInFill(point)||item.strokeAlpha>=.6&&item.shape.isPointInStroke(point)&&item.strokePainted(point);
          });
          if(hit){coveredInk++;glyphCovered++;glyphPaths.add(selector(hit.shape));cover??=hit.shape;}
          if(transparentLabel){
            const below=nearby.find(item=>visibleBelowStroke(item,element,x,y,stack));
            if(below){const points=under.get(below)||[];points.push({x,y});under.set(below,points);}
          }
        }
        // A long label must not dilute one severely damaged glyph into its
        // whole-span average. Keep the 15% ink threshold and require multiple
        // actual raster samples, rather than rejecting a one-pixel contact.
        if(glyphCovered>=4&&glyphCovered/ink.length>=.15)affectedGlyphs.push({char,utf16Start:start,utf16End:utf16,coveredInkSamples:glyphCovered,totalInkSamples:ink.length,coveredFraction:+(glyphCovered/ink.length).toFixed(6),paths:[...glyphPaths],rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}});
        // A coincident stroke fully hidden by the glyph is not visible
        // interference. Require both substantial ink-footprint intersection
        // and a nearby actually painted stroke sample in a clear glyph gap.
        for(const [item,points]of under){
          if(points.length<4||points.length/ink.length<.15)continue;
          const candidates=Array.from({length:Math.min(16,points.length)},(_,i)=>points[Math.floor(i*points.length/Math.min(16,points.length))]);
          let visible=0;
          for(const point of candidates){
            for(const [dx,dy]of [[-2,0],[2,0],[0,-2],[0,2],[-4,0],[4,0],[0,-4],[0,4]]){
              const x=point.x+dx,y=point.y+dy,nx=(x-rect.left)/rect.width,ny=(y-rect.top)/rect.height;
              if(nx<0||nx>=1||ny<0||ny>=1)continue;
              const alpha=glyph.alpha[(Math.floor(ny*glyph.height)*glyph.width+Math.floor(nx*glyph.width))*4+3];
              if(alpha<32&&visibleBelowStroke(item,element,x,y,document.elementsFromPoint(x,y))){visible++;break;}
            }
          }
          if(!visible)continue;
          interferedInk+=points.length;visibleStrokeSamples+=visible;underCover??=item.shape;
          underGlyphs.push({char,utf16Start:start,utf16End:utf16,coveredInkSamples:points.length,totalInkSamples:ink.length,coveredFraction:+(points.length/ink.length).toFixed(6),paths:[selector(item.shape)],rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}});
        }
      }
      const atomic=[...text.trim()].length<=16&&!/\s/.test(text.trim()),fraction=totalInk?coveredInk/totalInk:0;
      if(cover&&coveredInk>0&&(atomic||fraction>=.15||affectedGlyphs.length))issues.push({code:'text_occluded',severity:'error',time:input.time,selector:selector(element),containerSelector:selector(cover),text:text.trim(),coveredFraction:+fraction.toFixed(6),message:'Actual SVG fill/stroke is painted above loaded-font text ink. Move the graphic and label into separate readable zones.',affectedGlyphs,rect:{left:textRect.left,top:textRect.top,right:textRect.right,bottom:textRect.bottom,width:textRect.width,height:textRect.height}});
      if(underCover&&underGlyphs.length)issues.push({code:'content_overlap',severity:'error',time:input.time,selector:selector(element),containerSelector:selector(underCover),text:text.trim(),coveredFraction:+(interferedInk/totalInk).toFixed(6),paintRelation:'visible-below-stroke',visibleStrokeSamples,message:'An actual SVG stroke below a transparent label crosses loaded-font glyph ink and remains visible in nearby glyph gaps. Separate the complete label and graphic into readable zones; changing only their z-order is insufficient.',affectedGlyphs:underGlyphs,rect:{left:textRect.left,top:textRect.top,right:textRect.right,bottom:textRect.bottom,width:textRect.width,height:textRect.height}});
      if(issues.length>64)throw new Error('SVG paint inspection exceeds the bounded finding count.');
    }
    return issues;
  }finally{for(const restore of restores.reverse())restore();}
}

async function installedBrowser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  const explicit=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(explicit){await access(explicit);return{puppeteer,executablePath:explicit};}
  for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const installed=await browsers.getInstalledBrowsers({cacheDir}),platform=browsers.detectBrowserPlatform();
    const match=installed.filter((item:any)=>item.platform===platform&&['chrome-headless-shell','chrome'].includes(item.browser)).sort((a:any,b:any)=>b.buildId.localeCompare(a.buildId,undefined,{numeric:true}))[0];
    if(match){await access(match.executablePath);return{puppeteer,executablePath:match.executablePath};}
  }
  throw new Error('SVG paint inspection requires the already installed rendering browser.');
}

/** No browser download, network access, render or provider call. Errors are
 * failures, not evidence that the drawing is unobstructed. */
export async function inspectSvgTextPaint(project:string):Promise<SvgTextPaintReport|undefined>{
  throwIfJobCancelled();
  const file=path.join(project,'index.html'),before=await readFile(file);
  if(before.length>4_000_000)throw new Error('SVG paint inspection exceeds the bounded HTML size.');
  // The owned compiler marks authored geometry. Native chart/icon semantics
  // retain their separate checks; do not infer ownership from a whole SVG box.
  if(!/<path\b[^>]*\bdata-drawing-id=/i.test(before.toString()))return;
  const {puppeteer,executablePath}=await installedBrowser();throwIfJobCancelled();
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:30000,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
  let closing=false,closePromise:Promise<void>|undefined,requestFailure:unknown;
  const close=()=>{closing=true;return closePromise??=browser.close();};
  // Callbacks observe the same close promise that finally awaits. Closing a
  // browser during an intercepted request must not reject an unowned promise.
  const removeAbort=onJobAbort(()=>{void close().catch(()=>{});});let expired=false;
  const timer=setTimeout(()=>{expired=true;void close().catch(()=>{});},60000);
  const requests=new Set<Promise<void>>();
  const checkRequests=()=>{if(requestFailure)throw new Error('SVG paint inspection request handling failed; no layout success was established.',{cause:requestFailure});};
  try{
    throwIfJobCancelled();const page=await browser.newPage();
    await page.setRequestInterception(true);page.on('request',(request:any)=>{
      const handled:Promise<void>=(/^(?:file:|data:)/.test(request.url())?request.continue():request.abort()).catch((error:unknown)=>{if(!closing)requestFailure??=error;});
      requests.add(handled);void handled.then(()=>requests.delete(handled));
    });
    await page.goto(pathToFileURL(file).href,{waitUntil:'load',timeout:20000});
    checkRequests();
    const canvas=await page.$eval('[data-composition-id]',(element:Element)=>{const node=element as HTMLElement;return{width:Number(node.dataset.width),height:Number(node.dataset.height),duration:Number(node.dataset.duration)};});
    if(![canvas.width,canvas.height,canvas.duration].every(Number.isFinite)||canvas.width<1||canvas.height<1||canvas.width>4096||canvas.height>4096||canvas.duration<.1||canvas.duration>600)throw new Error('SVG paint inspection requires a valid bounded composition canvas and duration.');
    await page.setViewport({width:canvas.width,height:canvas.height,deviceScaleFactor:1});await page.evaluate(()=>document.fonts.ready);
    // tsx/esbuild preserves local callback names with this identity helper.
    // It changes no drawing, style, geometry or checked paint.
    await page.evaluate('globalThis.__name = (fn) => fn');
    const samples=Array.from({length:9},(_,i)=>+(canvas.duration*(i+.5)/9).toFixed(6)),findings:SvgTextPaintFinding[]=[];
    for(const time of samples){
      throwIfJobCancelled();checkRequests();
      await page.evaluate((at:number)=>{const timeline=(window as any).__timelines?.main;if(!timeline?.seek)throw new Error('SVG paint inspection requires the actual paused animation timeline.');timeline.pause().seek(at,false);},time);
      findings.push(...await page.evaluate(auditSvgTextPaint,{time}));
    }
    await Promise.all(requests);throwIfJobCancelled();checkRequests();
    if(!before.equals(await readFile(file)))throw new Error('HTML changed during actual SVG paint inspection.');
    return{version:1,htmlHash:createHash('sha256').update(before).digest('hex'),samples,findings};
  }catch(error){throwIfJobCancelled();if(expired)throw new Error('SVG paint inspection timed out; no layout success was established.',{cause:error});throw error;}
  finally{clearTimeout(timer);removeAbort();try{await close();}catch(error){throwIfJobCancelled();throw error;}finally{await Promise.allSettled(requests);}}
}

/** Keep the exact upstream report/stdout and the independent server evidence
 * immutable before returning a combined current-candidate decision. */
export async function addSvgTextPaintReport(project:string,task:string,result:Record<string,any>,stdout:string):Promise<Record<string,any>>{
  const html=await readFile(path.join(project,'index.html'));
  if(!/<path\b[^>]*\bdata-drawing-id=/i.test(html.toString()))return result;
  const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
  // Separate observations never overwrite each other, even if upstream JSON
  // is identical but stdout, installed fonts or the paint policy have changed.
  const raw=JSON.stringify(result,null,2),htmlHash=hash(html),directory=path.join('svg-paint-evidence',htmlHash,hash(raw)+'-'+randomUUID());
  await mkdir(path.join(project,directory),{recursive:true,mode:0o700});
  const immutable=async(name:string,bytes:string)=>{
    const file=path.join(project,directory,name);
    try{await writeFile(file,bytes,{flag:'wx',mode:0o600});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if((await readFile(file)).toString()!==bytes)throw new Error('SVG paint evidence bytes differ from their immutable hash.',{cause:error});}
    return{path:path.join(directory,name),sha256:hash(bytes)};
  };
  const upstreamReport=await immutable(task+'-hyperframes-report.json',raw),upstreamStdout=await immutable(task+'-hyperframes-stdout.txt',stdout);
  const checked=await inspectSvgTextPaint(project);
  if(!checked||checked.htmlHash!==htmlHash)throw new Error('SVG paint inspection did not verify these exact HTML bytes.');
  const evidence={source:'server-svg-paint',...checked,upstreamReport,upstreamStdout};
  const report=await immutable('server-svg-paint-report.json',JSON.stringify(evidence,null,2));
  const unique=new Map<string,SvgTextPaintFinding>();
  for(const finding of checked.findings)unique.set(finding.selector+'\0'+finding.containerSelector,unique.get(finding.selector+'\0'+finding.containerSelector)||finding);
  const findings=[...unique.values()].map(finding=>({...finding,source:'server-svg-paint',htmlHash,evidence:report}));
  return{...result,ok:result.ok&&findings.length===0,svgPaint:{...evidence,report},layout:{...result.layout,ok:(result.layout?.ok??true)&&findings.length===0,errorCount:(result.layout?.errorCount||0)+findings.length,findings:[...(result.layout?.findings||[]),...findings]}};
}
