import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import path from 'node:path';
import {buildPreview} from './build-preview.mjs';
await buildPreview();const base=process.cwd();
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(base+path.sep))throw Error();const data=await readFile(file);res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.wav')?'audio/wav':file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream');res.end(data);}catch{res.writeHead(404);res.end('Not found');}});
server.listen(0,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${server.address().port}`));
