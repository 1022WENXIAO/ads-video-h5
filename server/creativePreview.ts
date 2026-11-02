import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {artifactDigest} from './artifactIntegrity';
import type {Express} from 'express';
export function createCreativePreviews(base=''){
 const grants=new Map<string,{directory:string;expires:number;artifactHash?:string}>();
 return {
  issue(directory:string,entry='index.html',artifactHash?:string){
   for(const [key,value]of grants)if(value.expires<Date.now())grants.delete(key);
   if(grants.size>200)grants.delete(grants.keys().next().value!);
   const token=randomBytes(24).toString('base64url');grants.set(token,{directory:path.resolve(directory),expires:Date.now()+30*60000,artifactHash});return `${base}/api/creative-preview/${token}/${encodeURIComponent(entry)}`;
  },
  mount(app:Express){app.use(`/api/creative-preview/:token`,async(q,r)=>{
   if(!['GET','HEAD'].includes(q.method))return r.status(405).end();
   const grant=grants.get(String(q.params.token));if(!grant||grant.expires<Date.now())return r.status(404).end();
   if(grant.artifactHash&&await artifactDigest(grant.directory).catch(()=>null)!==grant.artifactHash)return r.status(410).end();
   let name:string;try{name=decodeURIComponent(q.path);}catch{return r.status(400).end();}
   const file=path.resolve(grant.directory,'.'+name);if(!file.startsWith(grant.directory+path.sep)||name.split('/').some(p=>p.startsWith('.'))||!/^[-a-zA-Z0-9_/.]+$/.test(name))return r.status(404).end();
   const prefix=`${q.protocol}://${q.get('host')}${base}/api/creative-preview/${q.params.token}/`;
   r.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${prefix} blob:; connect-src ${prefix} blob:; img-src ${prefix} data:; style-src 'unsafe-inline' ${prefix}; font-src ${prefix}; media-src blob: data:; worker-src blob: ${prefix}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`);
   r.setHeader('Access-Control-Allow-Origin','*');r.setHeader('Cross-Origin-Resource-Policy','cross-origin');r.setHeader('Referrer-Policy','no-referrer');r.setHeader('Cache-Control','no-store');r.setHeader('X-Content-Type-Options','nosniff');
   r.sendFile(path.relative(grant.directory,file),{root:grant.directory,dotfiles:'deny'},error=>{if(error&&!r.headersSent)r.status(404).end();});
  });}
 };
}
