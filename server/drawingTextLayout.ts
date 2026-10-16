import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {onJobAbort,throwIfJobCancelled} from './jobExecution';

interface Rect {left:number;top:number;right:number;bottom:number;width:number;height:number;}
export interface DrawingTextFinding {
  code:'content_overlap'|'text_overflow'|'orphan_line';severity:'error'|'warning';time:number;
  selector:string;containerSelector?:string;text:string;message:string;characters:string[];rect:Rect;
  paintRelation?:'visible-css-border';visibleBorderSamples?:number;
}
export interface DrawingTextFrame {
  time:number;nodes:Array<{selector:string;text:string;font:string;lines:Array<{text:string;rect:Rect}>}>;
  findings:DrawingTextFinding[];
}
export interface DrawingTextLayoutReport {
  version:1;htmlHash:string;samples:number[];frames:DrawingTextFrame[];
  fonts:Array<{selector:string;fonts:Array<{familyName:string;isCustomFont:boolean;glyphCount:number}>}>;
  findings:DrawingTextFinding[];
}

/** Executed in Chromium against the authored HTML at its actual animation time.
 * Range offsets are UTF-16; raster positions are measured from the loaded font.
 * Empty line boxes, padding, and an SVG viewport are never treated as ink. */
export function auditDrawingTextLayout(input:{time:number}):DrawingTextFrame {
  const root=document.querySelector('[data-composition-id]')||document.body;
  const elements=[...root.querySelectorAll<HTMLElement>('[data-drawing-id].node')];
  if(root.querySelectorAll('*').length>3000||elements.length>32)throw new Error('Drawing text inspection exceeds the bounded DOM size.');
  const rect=(r:{left:number;top:number;right:number;bottom:number}):Rect=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.right-r.left,height:r.bottom-r.top});
  const union=(rs:Rect[]):Rect=>rect({left:Math.min(...rs.map(r=>r.left)),top:Math.min(...rs.map(r=>r.top)),right:Math.max(...rs.map(r=>r.right)),bottom:Math.max(...rs.map(r=>r.bottom))});
  const opacity=(element:Element)=>{let alpha=1;for(let p:Element|null=element;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility!=='visible')return 0;alpha*=Number(s.opacity);}return alpha;};
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw new Error('Drawing text inspection cannot measure actual font ink.');
  const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;
  const colorContext=colorCanvas.getContext('2d',{willReadFrequently:true});
  if(!colorContext)throw new Error('Drawing text inspection cannot measure text opacity.');
  const colors=new Map<string,Uint8ClampedArray>();
  const colorRgba=(color:string)=>{let rgba=colors.get(color);if(!rgba){colorContext.clearRect(0,0,1,1);colorContext.fillStyle=color;colorContext.fillRect(0,0,1,1);rgba=colorContext.getImageData(0,0,1,1).data;colors.set(color,rgba);}return rgba;};
  const colorAlpha=(color:string)=>colorRgba(color)[3]/255;
  const cache=new Map<string,{ink:Array<{x:number;y:number}>;alpha:Uint8ClampedArray;width:number;height:number}>();let characters=0,totalPoints=0;
  const measured=elements.filter(e=>e.textContent?.trim()&&opacity(e)*colorAlpha(getComputedStyle(e).color)>=.6).map(element=>{
    const style=getComputedStyle(element),font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if(style.writingMode!=='horizontal-tb')throw new Error('Drawing text inspection cannot infer this writing mode.');
    for(let p:Element|null=element;p&&p!==root.parentElement;p=p.parentElement){const transform=getComputedStyle(p).transform;if(transform!=='none'){const m=new DOMMatrix(transform);if(!m.is2D||Math.abs(m.b)>.0001||Math.abs(m.c)>.0001||m.a<=0||m.d<=0)throw new Error('Drawing text inspection cannot infer rotated text ink.');}}
    const clips:Rect[]=[rect({left:0,top:0,right:innerWidth,bottom:innerHeight})];
    for(let p:HTMLElement|null=element;p;p=p.parentElement){const s=getComputedStyle(p),r=p.getBoundingClientRect();if(s.clipPath!=='none'||s.clip!=='auto')throw new Error('Drawing text inspection cannot infer this clipping shape.');
      if(/hidden|clip|scroll|auto/.test(s.overflowX+' '+s.overflowY)){
        const sx=p.offsetWidth?r.width/p.offsetWidth:1,sy=p.offsetHeight?r.height/p.offsetHeight:1;
        clips.push(rect({left:/hidden|clip|scroll|auto/.test(s.overflowX)?r.left+p.clientLeft*sx:-Infinity,right:/hidden|clip|scroll|auto/.test(s.overflowX)?r.left+(p.clientLeft+p.clientWidth)*sx:Infinity,top:/hidden|clip|scroll|auto/.test(s.overflowY)?r.top+p.clientTop*sy:-Infinity,bottom:/hidden|clip|scroll|auto/.test(s.overflowY)?r.top+(p.clientTop+p.clientHeight)*sy:Infinity}));
      }
    }
    const glyphs:Array<{char:string;rect:Rect;points:Array<{x:number;y:number}>;clipped:number;raster:NonNullable<ReturnType<typeof cache.get>>}>=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode,text=node.textContent||'';let offset=0;const range=document.createRange();
      for(const char of text){const start=offset;offset+=char.length;if(!char.trim())continue;if(++characters>1024)throw new Error('Drawing text inspection exceeds the bounded character count.');
        range.setStart(node,start);range.setEnd(node,offset);const r=rect(range.getBoundingClientRect());if(r.width<.1||r.height<.1)continue;
        const key=font+'\0'+char;let raster=cache.get(key);
        if(!raster){ctx.font=font;const m=ctx.measureText(char),height=m.fontBoundingBoxAscent+m.fontBoundingBoxDescent;
          if(!Number.isFinite(height)||height<=0||height>192||m.width<=0||m.width>192)throw new Error('Drawing text inspection cannot measure the bounded loaded font.');
          canvas.width=Math.ceil(m.width);canvas.height=Math.ceil(height);ctx.font=font;ctx.fillStyle='#000';ctx.textBaseline='alphabetic';ctx.fillText(char,0,m.fontBoundingBoxAscent);
          const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),ink:Array<{x:number;y:number}>=[];
          for(let y=1;y<pixels.height;y+=2)for(let x=1;x<pixels.width;x+=2)if(pixels.data[(y*pixels.width+x)*4+3]>=128)ink.push({x:(x+.5)/m.width,y:(y+.5)/height});raster={ink,alpha:pixels.data,width:pixels.width,height:pixels.height};cache.set(key,raster);
        }
        const points=raster.ink.map(p=>({x:r.left+p.x*r.width,y:r.top+p.y*r.height}));totalPoints+=points.length;if(totalPoints>180000)throw new Error('Drawing text inspection exceeds the bounded raster size.');
        const clipped=points.filter(p=>clips.some(c=>p.x<c.left-1||p.x>c.right+1||p.y<c.top-1||p.y>c.bottom+1)).length;
        glyphs.push({char,rect:r,points,clipped,raster});
      }
    }
    const lines:Array<{text:string;rect:Rect;glyphs:typeof glyphs}>=[];
    for(const glyph of glyphs){let line=lines.find(l=>Math.abs(l.rect.top-glyph.rect.top)<=2);if(!line){line={text:'',rect:glyph.rect,glyphs:[]};lines.push(line);}line.text+=glyph.char;line.glyphs.push(glyph);line.rect=union(line.glyphs.map(g=>g.rect));}
    return{element,selector:'#'+CSS.escape(element.id),text:element.textContent?.trim()||'',font,glyphs,lines};
  });
  const findings:DrawingTextFinding[]=[];
  // Only straight, solid sides of owned cards are known paint here. Rounded
  // corners, dashed borders and other CSS paint are deliberately not inferred.
  const borders=elements.filter(e=>e.classList.contains('card')&&opacity(e)>=.6).flatMap(element=>{
    const s=getComputedStyle(element),r=rect(element.getBoundingClientRect());
    if(!element.offsetWidth||!element.offsetHeight||s.filter!=='none'||s.mixBlendMode!=='normal'||s.borderImageSource!=='none'||s.clipPath!=='none'||s.backgroundImage!=='none')return[];
    // A line's alpha alone does not prove it is visible: white paint over a
    // white card is not interference. Only known opaque, plain card fill is
    // supported; no surrounding CSS background reconstruction is inferred.
    const background=colorRgba(s.backgroundColor);if(background[3]!==255)return[];
    const distinctBorder=(color:string)=>{const rgba=colorRgba(color),alpha=rgba[3]/255;return Math.max(...[0,1,2].map(i=>Math.abs(rgba[i]-background[i])*alpha*opacity(element)))>=12;};
    for(let p:Element|null=element;p;p=p.parentElement){const transform=getComputedStyle(p).transform;if(transform!=='none'){const m=new DOMMatrix(transform);if(!m.is2D||Math.abs(m.b)>.0001||Math.abs(m.c)>.0001||m.a<=0||m.d<=0)return[];}}
    const sx=r.width/element.offsetWidth,sy=r.height/element.offsetHeight;
    const radius=(value:string)=>{const parts=value.split(/\s+/);if(parts.some(p=>!/^\d+(?:\.\d+)?px$|^0$/.test(p)))return;return [parseFloat(parts[0])*sx,parseFloat(parts[1]||parts[0])*sy];};
    const tl=radius(s.borderTopLeftRadius),tr=radius(s.borderTopRightRadius),bl=radius(s.borderBottomLeftRadius),br=radius(s.borderBottomRightRadius);if(!tl||!tr||!bl||!br)return[];
    const edges=[
      {style:s.borderTopStyle,color:s.borderTopColor,width:parseFloat(s.borderTopWidth)*sy,box:{left:r.left+tl[0],right:r.right-tr[0],top:r.top,bottom:r.top+parseFloat(s.borderTopWidth)*sy}},
      {style:s.borderBottomStyle,color:s.borderBottomColor,width:parseFloat(s.borderBottomWidth)*sy,box:{left:r.left+bl[0],right:r.right-br[0],top:r.bottom-parseFloat(s.borderBottomWidth)*sy,bottom:r.bottom}},
      {style:s.borderLeftStyle,color:s.borderLeftColor,width:parseFloat(s.borderLeftWidth)*sx,box:{left:r.left,right:r.left+parseFloat(s.borderLeftWidth)*sx,top:r.top+tl[1],bottom:r.bottom-bl[1]}},
      {style:s.borderRightStyle,color:s.borderRightColor,width:parseFloat(s.borderRightWidth)*sx,box:{left:r.right-parseFloat(s.borderRightWidth)*sx,right:r.right,top:r.top+tr[1],bottom:r.bottom-br[1]}},
    ].filter(e=>e.style==='solid'&&e.width>0&&Number.isFinite(e.width)&&colorAlpha(e.color)*opacity(element)>=.6&&distinctBorder(e.color)&&e.box.left<e.box.right&&e.box.top<e.box.bottom);
    return edges.length?[{element,rect:r,edges}]:[];
  });
  const onBorder=(border:typeof borders[number],x:number,y:number)=>border.edges.some(e=>x>=e.box.left&&x<=e.box.right&&y>=e.box.top&&y<=e.box.bottom);
  const visibleBorder=(border:typeof borders[number],label:HTMLElement,x:number,y:number)=>{
    if(!onBorder(border,x,y))return false;
    const stack=document.elementsFromPoint(x,y),labelIndex=stack.indexOf(label),borderIndex=stack.indexOf(border.element);
    if(labelIndex<0||borderIndex<=labelIndex)return false;
    for(const hit of stack.slice(0,borderIndex)){
      const s=getComputedStyle(hit);if(opacity(hit)<=.01)continue;
      if(s.filter!=='none'||s.mixBlendMode!=='normal'||s.backgroundImage!=='none'||colorAlpha(s.backgroundColor)*opacity(hit)>.01)return false;
      if(hit instanceof SVGGeometryElement||hit instanceof SVGTextContentElement)return false;
      if(hit instanceof HTMLElement&&hit!==label&&!hit.contains(label)&&!label.contains(hit)&&(hit.textContent?.trim()||[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth].some(w=>parseFloat(w)>0)))return false;
    }
    return true;
  };
  for(const item of measured){
    const clipped=item.glyphs.filter(g=>g.clipped>=3&&g.clipped/g.points.length>=.08);
    if(clipped.length)findings.push({code:'text_overflow',severity:'error',time:input.time,selector:item.selector,text:item.text,characters:clipped.map(g=>g.char),rect:union(clipped.map(g=>g.rect)),message:'Actual loaded-font glyph ink is outside the viewport or an actual clipping ancestor. Move the complete text into its visible region.'});
    // A soft-wrapped single Han is useful author feedback, not evidence that
    // the glyph was cropped. Short badges, circles, quantities, formulas and
    // deliberately authored line breaks are outside this advisory policy.
    const last=item.lines.at(-1),previous=item.lines.at(-2);
    if(!item.element.classList.contains('circle')&&!item.text.includes('\n')&&[...item.text].length>=16&&last&&previous&&/^\p{Script=Han}$/u.test(last.text)&&[...previous.text].length>=8&&!/[=+×÷%％°℃℉μΩ]/u.test(item.text)&&!/[零〇一二两三四五六七八九十百千万亿\d]\s*[年月日时分秒元块美元欧元吨千克克公斤斤米厘米毫米升毫升度瓦焦帕赫兹袋杯份批台个本次件品牌]/u.test(item.text))findings.push({code:'orphan_line',severity:'warning',time:input.time,selector:item.selector,text:item.text,characters:[last.text],rect:last.rect,message:'A long authored label naturally wraps its final Han onto a single-character line. Rebalance the line width without deleting its content; this observation alone is not clipping.'});
    const style=getComputedStyle(item.element),labelBox=rect(item.element.getBoundingClientRect());
    if(colorAlpha(style.backgroundColor)>.01||style.backgroundImage!=='none'||style.filter!=='none'||style.mixBlendMode!=='normal')continue;
    for(const border of borders){
      if(border.element===item.element||border.element.contains(item.element)||item.element.contains(border.element)||labelBox.left>=border.rect.left&&labelBox.right<=border.rect.right&&labelBox.top>=border.rect.top&&labelBox.bottom<=border.rect.bottom)continue;
      const affected:typeof item.glyphs=[];let visible=0;
      for(const glyph of item.glyphs){
        if(!border.edges.some(e=>glyph.rect.left<e.box.right&&glyph.rect.right>e.box.left&&glyph.rect.top<e.box.bottom&&glyph.rect.bottom>e.box.top))continue;
        // This CSS line/text collision uses the existing text/text ink rule.
        // The separate SVG paint guard retains its original 15% threshold.
        const hits=glyph.points.filter(p=>visibleBorder(border,item.element,p.x,p.y));if(hits.length<4||hits.length/glyph.points.length<.08)continue;
        let gaps=0;
        for(let i=0;i<Math.min(16,hits.length);i++){
          const point=hits[Math.floor(i*hits.length/Math.min(16,hits.length))];
          for(const[dx,dy]of [[-2,0],[2,0],[0,-2],[0,2],[-4,0],[4,0],[0,-4],[0,4]]){
            const x=point.x+dx,y=point.y+dy,nx=(x-glyph.rect.left)/glyph.rect.width,ny=(y-glyph.rect.top)/glyph.rect.height;if(nx<0||nx>=1||ny<0||ny>=1)continue;
            if(glyph.raster.alpha[(Math.floor(ny*glyph.raster.height)*glyph.raster.width+Math.floor(nx*glyph.raster.width))*4+3]<32&&visibleBorder(border,item.element,x,y)){gaps++;break;}
          }
        }
        if(gaps){affected.push(glyph);visible+=gaps;}
      }
      if(affected.length)findings.push({code:'content_overlap',severity:'error',time:input.time,selector:item.selector,containerSelector:'#'+CSS.escape(border.element.id),text:item.text,characters:affected.map(g=>g.char),rect:union(affected.map(g=>g.rect)),paintRelation:'visible-css-border',visibleBorderSamples:visible,message:'A visible solid card border below an independent transparent label crosses loaded-font glyph ink and remains visible in glyph gaps. Separate the complete label and card; box overlap alone is not this finding.'});
      if(findings.length>64)throw new Error('Drawing text inspection exceeds the bounded finding count.');
    }
  }
  for(let a=0;a<measured.length;a++)for(let b=a+1;b<measured.length;b++){
    const first=measured[a],second=measured[b],pairs:Array<[typeof first.glyphs[number],typeof second.glyphs[number]]>=[];
    for(const ga of first.glyphs)for(const gb of second.glyphs){if(ga.rect.right<=gb.rect.left||gb.rect.right<=ga.rect.left||ga.rect.bottom<=gb.rect.top||gb.rect.bottom<=ga.rect.top)continue;
      // Quantized actual ink masks, not line/border boxes. Two pixels of
      // tolerance cover antialiasing; a material shared glyph area is required.
      const set=new Set(gb.points.map(p=>Math.round(p.x)+','+Math.round(p.y)));let hits=0;
      for(const p of ga.points){const x=Math.round(p.x),y=Math.round(p.y);let hit=false;for(let dy=-1;dy<=1&&!hit;dy++)for(let dx=-1;dx<=1;dx++)if(set.has((x+dx)+','+(y+dy))){hit=true;break;}if(hit)hits++;}
      if(hits>=4&&hits/Math.min(ga.points.length,gb.points.length)>=.08)pairs.push([ga,gb]);
    }
    if(pairs.length)findings.push({code:'content_overlap',severity:'error',time:input.time,selector:first.selector,containerSelector:second.selector,text:first.text,characters:[...new Set(pairs.flatMap(([a,b])=>[a.char,b.char]))],rect:union(pairs.flatMap(pair=>pair.map(g=>g.rect))),message:'Actual loaded-font glyph ink from two independent authored labels overlaps. Separate these text lines without changing their words.'});
    if(findings.length>64)throw new Error('Drawing text inspection exceeds the bounded finding count.');
  }
  return{time:input.time,nodes:measured.map(({selector,text,font,lines})=>({selector,text,font,lines:lines.map(({text,rect})=>({text,rect}))})),findings};
}

async function installedBrowser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  const explicit=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(explicit){await access(explicit);return{puppeteer,executablePath:explicit};}
  for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){const installed=await browsers.getInstalledBrowsers({cacheDir}),platform=browsers.detectBrowserPlatform();const match=installed.filter((i:any)=>i.platform===platform&&['chrome-headless-shell','chrome'].includes(i.browser)).sort((a:any,b:any)=>b.buildId.localeCompare(a.buildId,undefined,{numeric:true}))[0];if(match){await access(match.executablePath);return{puppeteer,executablePath:match.executablePath};}}
  throw new Error('Drawing text inspection requires the already installed rendering browser.');
}

/** Local file/installed Chromium only. Every check closes its owned browser;
 * missing data, timeout, cancellation or changed HTML is never a layout pass. */
export async function inspectDrawingTextLayout(project:string):Promise<DrawingTextLayoutReport|undefined>{
  throwIfJobCancelled();const file=path.join(project,'index.html'),before=await readFile(file);
  if(before.length>4_000_000)throw new Error('Drawing text inspection exceeds the bounded HTML size.');
  if(!/\bdata-drawing-id=/i.test(before.toString())||!before.toString().includes('class="node '))return;
  const {puppeteer,executablePath}=await installedBrowser();throwIfJobCancelled();
  const browser=await puppeteer.launch({executablePath,headless:true,timeout:30000,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
  let closing=false,closePromise:Promise<void>|undefined,requestFailure:unknown,primaryFailure:unknown,expired=false;const requests=new Set<Promise<void>>();
  const close=()=>{closing=true;return closePromise??=browser.close();};const removeAbort=onJobAbort(()=>{void close().catch(()=>{});});const timer=setTimeout(()=>{expired=true;void close().catch(()=>{});},60000);
  try{throwIfJobCancelled();const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',(request:any)=>{const handled:Promise<void>=(/^(?:file:|data:)/.test(request.url())?request.continue():request.abort()).catch((e:unknown)=>{if(!closing)requestFailure??=e;});requests.add(handled);void handled.then(()=>requests.delete(handled));});
    await page.goto(pathToFileURL(file).href,{waitUntil:'load',timeout:20000});
    const canvas=await page.$eval('[data-composition-id]',(element:Element)=>{const n=element as HTMLElement;return{width:Number(n.dataset.width),height:Number(n.dataset.height),duration:Number(n.dataset.duration)};});
    if(![canvas.width,canvas.height,canvas.duration].every(Number.isFinite)||canvas.width<1||canvas.height<1||canvas.width>4096||canvas.height>4096||canvas.duration<.1||canvas.duration>600)throw new Error('Drawing text inspection requires a valid bounded canvas and duration.');
    await page.setViewport({width:canvas.width,height:canvas.height,deviceScaleFactor:1});await page.evaluate(()=>document.fonts.ready);await page.evaluate('globalThis.__name = (fn) => fn');
    const samples=Array.from({length:9},(_,i)=>+(canvas.duration*(i+.5)/9).toFixed(6)),frames:DrawingTextFrame[]=[];
    for(const time of samples){throwIfJobCancelled();if(requestFailure)throw new Error('Drawing text inspection request handling failed.',{cause:requestFailure});await page.evaluate((t:number)=>{const timeline=(window as any).__timelines?.main;if(!timeline?.seek)throw new Error('Drawing text inspection requires the actual paused animation timeline.');timeline.pause().seek(t,false);},time);frames.push(await page.evaluate(auditDrawingTextLayout,{time}));}
    const cdp=await page.createCDPSession();await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument');
    const {nodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'[data-drawing-id].node'});const fonts:DrawingTextLayoutReport['fonts']=[];
    if(nodeIds.length>32)throw new Error('Drawing text inspection exceeds the bounded font node count.');
    for(const nodeId of nodeIds){throwIfJobCancelled();const {node}=await cdp.send('DOM.describeNode',{nodeId}),attributes=node.attributes||[],id=attributes[attributes.indexOf('id')+1];const result=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});fonts.push({selector:'#'+id,fonts:result.fonts.map((font:any)=>({familyName:font.familyName,isCustomFont:font.isCustomFont,glyphCount:font.glyphCount}))});}
    await Promise.all(requests);throwIfJobCancelled();if(requestFailure)throw new Error('Drawing text inspection request handling failed.',{cause:requestFailure});if(!before.equals(await readFile(file)))throw new Error('HTML changed during actual drawing text inspection.');
    return{version:1,htmlHash:createHash('sha256').update(before).digest('hex'),samples,frames,fonts,findings:frames.flatMap(f=>f.findings)};
  }catch(error){primaryFailure=error;throwIfJobCancelled();if(expired)throw new Error('Drawing text inspection timed out; no layout success was established.',{cause:error});throw error;}
  finally{clearTimeout(timer);removeAbort();try{await close();}catch(error){throwIfJobCancelled();if(!primaryFailure)throw error;}finally{await Promise.allSettled(requests);}}
}

export async function addDrawingTextLayoutReport(project:string,task:string,current:Record<string,any>,stdout:string,upstream:Record<string,any>):Promise<Record<string,any>>{
  const html=await readFile(path.join(project,'index.html'));if(!/\bdata-drawing-id=/i.test(html.toString())||!html.toString().includes('class="node '))return current;
  const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex'),htmlHash=hash(html),raw=JSON.stringify(upstream,null,2),directory=path.join('drawing-text-evidence',htmlHash,randomUUID());await mkdir(path.join(project,directory),{recursive:true,mode:0o700});
  const immutable=async(name:string,bytes:string|Buffer)=>{const file=path.join(project,directory,name);await writeFile(file,bytes,{flag:'wx',mode:0o600});return{path:path.join(directory,name),sha256:hash(bytes)};};
  const upstreamReport=await immutable(task+'-hyperframes-report.json',raw),upstreamStdout=await immutable(task+'-hyperframes-stdout.txt',stdout),htmlSnapshot=await immutable('index.html',html);
  const checked=await inspectDrawingTextLayout(project);if(!checked||checked.htmlHash!==htmlHash)throw new Error('Drawing text inspection did not verify these exact HTML bytes.');
  const evidence={source:'server-drawing-text',...checked,upstreamReport,upstreamStdout,htmlSnapshot},report=await immutable('server-drawing-text-report.json',JSON.stringify(evidence,null,2));
  const unique=new Map<string,DrawingTextFinding>();for(const f of checked.findings)unique.set(f.code+'\0'+f.selector+'\0'+(f.containerSelector||''),unique.get(f.code+'\0'+f.selector+'\0'+(f.containerSelector||''))||f);
  const findings=[...unique.values()].filter(f=>f.severity==='error').map(f=>({...f,source:'server-drawing-text',htmlHash,evidence:report}));
  return{...current,ok:current.ok&&findings.length===0,drawingText:{...evidence,report},layout:{...current.layout,ok:(current.layout?.ok??true)&&findings.length===0,errorCount:(current.layout?.errorCount||0)+findings.length,findings:[...(current.layout?.findings||[]),...findings]}};
}
