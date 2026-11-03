// Trusted, pinned library renderer. Never imports project/model-authored code.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFrame,clearFrame,createFx,composite} from '../../third_party/pixelfx/src/core/index.js';
import {edgeFade,isScreen} from '../../third_party/pixelfx/tools/lib/fxlib.mjs';
import {encodePNG} from '../../third_party/pixelfx/tools/lib/png.mjs';

const root=fileURLToPath(new URL('../../third_party/pixelfx/',import.meta.url));
const [inputFile,output]=process.argv.slice(2),input=JSON.parse(await readFile(inputFile,'utf8'));
if(!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(input.id))throw Error('Invalid effect id');
const catalog=JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8'));
const item=catalog.effects.find(e=>e.id===input.id);if(!item)throw Error('Unknown effect');
const fps=input.fps;if(!Number.isInteger(fps)||fps<6||fps>30)throw Error('Invalid frame rate');
const mod=await import(pathToFileURL(path.join(root,'src/fx',input.id+'.js')).href);
const [w,h]=item.size,n=Math.max(1,Math.round(item.duration*fps)+(item.loop?0:1));
if(n>600||n*w*h>36_000_000)throw Error('Effect raster budget exceeded');
const pageCapacity=Math.floor(2048/w)*Math.floor(2048/h);
if(!pageCapacity)throw Error('Effect frame exceeds texture limit');
const frame=createFrame(w,h),fx=createFx(mod,{x:item.origin[0],y:item.origin[1],seed:input.seed,...(input.palette?{palette:input.palette}:{})});
const rgba=new Uint8ClampedArray(w*h*4),pages=[],hashes={};
const picked=[...new Set(Array.from({length:Math.min(n,12)},(_,i)=>Math.round(i*(n-1)/Math.max(1,Math.min(n,12)-1))))];
const contactCols=4,contactRows=Math.ceil(picked.length/contactCols),cw=contactCols*w,ch=contactRows*h,contact=new Uint8Array(cw*ch*4);
for(let i=0;i<contact.length;i+=4){contact[i]=12;contact[i+1]=18;contact[i+2]=30;contact[i+3]=255;}
await mkdir(output,{recursive:true});
const save=async(name,bytes)=>{await writeFile(path.join(output,name),bytes);hashes[name]=createHash('sha256').update(bytes).digest('hex');};
let buffer,cols,rows,count,width,height;
for(let i=0;i<n;i++){
 if(i%pageCapacity===0){count=Math.min(pageCapacity,n-i);cols=Math.min(Math.floor(2048/w),Math.max(1,Math.ceil(Math.sqrt(count*h/w))));rows=Math.ceil(count/cols);if(rows*h>2048){cols=Math.floor(2048/w);rows=Math.ceil(count/cols);}width=cols*w;height=rows*h;buffer=new Uint8Array(width*height*4);}
 if(i)fx.update(1/fps);clearFrame(frame);fx.draw(frame);if(!isScreen(item))edgeFade(frame);composite(frame,rgba,null);
 const local=i%pageCapacity,x=local%cols*w,y=Math.floor(local/cols)*h;
 // Copy straight RGBA exactly; alpha compositing here would premultiply glow twice.
 for(let row=0;row<h;row++)buffer.set(rgba.subarray(row*w*4,(row+1)*w*4),((y+row)*width+x)*4);
 const contactIndex=picked.indexOf(i);
 if(contactIndex>=0){const xx=contactIndex%contactCols*w,yy=Math.floor(contactIndex/contactCols)*h;for(let row=0;row<h;row++)for(let col=0;col<w;col++){const s=(row*w+col)*4,d=((yy+row)*cw+xx+col)*4,a=rgba[s+3]/255;for(let c=0;c<3;c++)contact[d+c]=Math.round(rgba[s+c]*a+contact[d+c]*(1-a));}}
 if(local===count-1){const file=`page-${pages.length}.png`;await save(file,encodePNG(width,height,buffer));pages.push({file,frames:count,columns:cols,width,height});}
}
await save('contact.png',encodePNG(cw,ch,contact));
await writeFile(path.join(output,'render.json'),JSON.stringify({format:1,id:input.id,fps,frames:n,frameSize:[w,h],pivot:item.origin,loop:item.loop,duration:n/fps,pages,hashes},null,2));
