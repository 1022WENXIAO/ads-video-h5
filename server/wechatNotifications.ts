import {readFile} from 'node:fs/promises';
import {atomicStateWrite,withFileLock} from './durableState';
import {withoutJobSignal} from './jobExecution';
import type {WeChatIdentity} from './wechatAuth';
import type {CompletionNotice,NoticeInbox} from '../shared/notifications';
import {wechatNoticeTemplates} from './wechatNoticeTemplates';

type Template={id:string;kind:'all'|'reply'|'task';fields:Record<string,'title'|'result'|'time'|'status'|'jobId'>};
type Configuration={appId?:string;appSecret?:string;templates:Template[];stage:'developer'|'trial'|'formal'};
type Store={revision?:number;items:CompletionNotice[];grants:Record<string,Record<string,{count:number;at:string}>>;receipts:Record<string,string>};
export function notificationConfig():Configuration{
  let templates:Template[]=[];
  try{
    const value=JSON.parse(process.env.QINGJIAN_WECHAT_NOTICE_TEMPLATES??JSON.stringify(wechatNoticeTemplates));
    if(!Array.isArray(value)||value.length>3)throw Error();
    templates=value.map(t=>{
      if(!t||typeof t.id!=='string'||!/^[\w-]{10,200}$/.test(t.id)||!['all','reply','task'].includes(t.kind)||!t.fields||typeof t.fields!=='object'||Array.isArray(t.fields)||!Object.keys(t.fields).length||Object.keys(t.fields).length>5)throw Error();
      for(const [key,field] of Object.entries(t.fields))if(!/^(?:thing|time|phrase|character_string)\d+$/.test(key)||!['title','result','time','status','jobId'].includes(String(field))||key.startsWith('time')&&field!=='time'||key.startsWith('phrase')&&field!=='status'||key.startsWith('character_string')&&field!=='jobId'||key.startsWith('thing')&&!['title','result'].includes(String(field)))throw Error();
      return t;
    });
  }catch{templates=[];}
  const stage=process.env.QINGJIAN_WECHAT_NOTICE_STAGE;
  return{appId:process.env.QINGJIAN_WECHAT_APP_ID,appSecret:process.env.QINGJIAN_WECHAT_APP_SECRET,templates,stage:stage==='developer'||stage==='trial'?stage:'formal'};
}
const short=(value:string,n:number)=>Array.from(value).slice(0,n).join('');
class NoticePreparationError extends Error {}
export function noticeData(notice:CompletionNotice,template:Template){
  const time=new Date(Date.parse(notice.at)+8*3600000).toISOString().slice(0,19).replace('T',' ');
  const values={title:notice.kind==='reply'?'轻喵对话回复':notice.title,result:notice.result,time,status:notice.status==='failed'?'未完成':notice.kind==='reply'?'已回复':'已完成',jobId:notice.jobId.replace(/[^\w-]/g,'')};
  return Object.fromEntries(Object.entries(template.fields).map(([key,field])=>[key,{value:short(values[field],key.startsWith('thing')?20:key.startsWith('phrase')?5:key.startsWith('character_string')?32:32)}]));
}
export function createWeChatNoticeSender(options:{fetch?:typeof fetch;config?:()=>Configuration}={}){
  const request=options.fetch||fetch,config=options.config||notificationConfig;let token='',expires=0,pending:Promise<string>|undefined;
  async function access(force=false):Promise<string>{
    if(!force&&token&&Date.now()<expires)return token;if(pending)return pending;
    const c=config();if(!c.appId||!c.appSecret)throw Error('微信消息服务未配置。');
    pending=(async()=>{
      const response=await request('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),body:JSON.stringify({grant_type:'client_credential',appid:c.appId,secret:c.appSecret,force_refresh:force})});
      const body=await response.json();if(!response.ok||body.errcode||typeof body.access_token!=='string'||!Number.isFinite(body.expires_in))throw Error('微信消息凭证获取失败。');
      token=body.access_token;expires=Date.now()+Math.max(0,body.expires_in-300)*1000;return token;
    })();
    try{return await pending;}finally{pending=undefined;}
  }
  return async(identity:WeChatIdentity,notice:CompletionNotice,template:Template)=>{
    if(identity.appId!==config().appId)throw Error('微信账号与消息应用不匹配。');
    for(let attempt=0;attempt<2;attempt++){
      let key:string;try{key=await access(attempt>0);}catch{throw new NoticePreparationError('微信消息凭证暂不可用。');}
      const response=await request('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),body:JSON.stringify({touser:identity.openId,template_id:template.id,page:'pages/chat/index?noticeId='+encodeURIComponent(notice.id),miniprogram_state:config().stage,lang:'zh_CN',data:noticeData(notice,template)})});
      const body=await response.json();if(!response.ok||!Number.isInteger(body.errcode))throw Error('微信消息返回状态不明。');
      if(!attempt&&[40001,40014,42001].includes(body.errcode)){token='';expires=0;continue;}
      return body.errcode as number;
    }
    return -1;
  };
}
export async function createNotifications(file:string,options:{identity:(ownerId:string)=>WeChatIdentity|undefined;config?:()=>Configuration;send?:ReturnType<typeof createWeChatNoticeSender>;clock?:()=>number}){
  const config=options.config||notificationConfig,clock=options.clock||Date.now,send=options.send||createWeChatNoticeSender({config});
  const empty=():Store=>({items:[],grants:{},receipts:{}});
  let store:Store;try{store=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;store=empty();}
  if(!store||!Array.isArray(store.items)||!store.grants||typeof store.grants!=='object'||!store.receipts||typeof store.receipts!=='object')throw Error('消息记录格式无效，原件已保留。');
  async function update<T>(action:(s:Store)=>T){return withoutJobSignal(()=>withFileLock(file,async()=>{
    let next:Store;try{next=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;next=empty();}
    const result=action(next);next.revision=(next.revision||0)+1;await atomicStateWrite(file,next);store=next;return result;
  }));}
  if(store.items.some(n=>n.push==='sending'))await update(s=>{for(const n of s.items)if(n.push==='sending')n.push='unknown';});
  const presence=new Map<string,{ownerId:string;sequence:number;foreground:boolean;at:number}>();
  const active=(ownerId:string)=>[...presence.values()].some(p=>p.ownerId===ownerId&&p.foreground&&clock()-p.at<60000);
  const templates=()=>{const c=config();return c.appId&&c.appSecret?c.templates:[];};
  let flushing:Promise<void>|undefined,retryAfter=0;
  function flush():Promise<void>{
    if(flushing)return flushing;
    if(clock()<retryAfter)return Promise.resolve();
    flushing=withoutJobSignal(async()=>{
      for(const candidate of [...store.items]){
        if(candidate.push!=='pending'||candidate.readAt||active(candidate.ownerId)||clock()-Date.parse(candidate.at)>86400000)continue;
        const template=templates().find(t=>t.kind===candidate.kind)||templates().find(t=>t.kind==='all');
        const identity=options.identity(candidate.ownerId);if(!template||!identity)continue;
        const claimed=await update(s=>{
          const n=s.items.find(v=>v.id===candidate.id),grant=s.grants[candidate.ownerId]?.[template.id];
          if(!n||n.push!=='pending'||n.readAt||!grant?.count||Date.parse(n.at)<Date.parse(grant.at))return undefined;
          grant.count--;n.push='sending';return structuredClone(n);
        });
        if(!claimed)continue;
        let code:number|undefined,prepared=false;try{code=await send(identity,claimed,template);}catch(error){prepared=error instanceof NoticePreparationError;/* Never replay an ambiguous delivery. */}
        if(prepared){await update(s=>{const n=s.items.find(v=>v.id===claimed.id)!;n.push='pending';s.grants[n.ownerId][template.id].count++;});retryAfter=clock()+60000;return;}
        await update(s=>{const n=s.items.find(v=>v.id===claimed.id)!;n.push=code===0?'sent':code===43101?'unsubscribed':code===undefined?'unknown':'failed';n.pushCode=code;if(code===43101&&s.grants[n.ownerId]?.[template.id])s.grants[n.ownerId][template.id].count=0;});
      }
    }).finally(()=>{flushing=undefined;});
    return flushing;
  }
  return{
    ready:true,
    flush,
    list(ownerId:string,limit=40):NoticeInbox{const own=store.items.filter(n=>n.ownerId===ownerId),unread=own.filter(n=>!n.readAt),unreadBySession:Record<string,number>=Object.create(null);for(const n of unread)unreadBySession[n.sessionId]=(unreadBySession[n.sessionId]||0)+1;return{items:own.slice().reverse().slice(0,Math.max(1,Math.min(200,limit))).map(({ownerId:_owner,...n})=>n),unread:unread.length,unreadBySession,cursor:own.at(-1)?.id||'',revision:store.revision||0};},
    get(ownerId:string,id:string){const value=store.items.find(n=>n.ownerId===ownerId&&n.id===id);if(!value)return;const{ownerId:_owner,...notice}=value;return notice;},
    configuration(ownerId:string){const own=store.grants[ownerId]||{};return{available:Boolean(options.identity(ownerId)?.appId===config().appId&&templates().length),templates:templates().map(t=>({id:t.id,kind:t.kind,label:t.kind==='reply'?'回复提醒':t.kind==='task'?'任务提醒':'回复与任务提醒',remaining:own[t.id]?.count||0}))};},
    async record(input:Omit<CompletionNotice,'push'>){await update(s=>{if(!s.items.some(n=>n.id===input.id))s.items.push({...input,push:'pending'});});},
    async read(ownerId:string,ids:string[],all=false){await update(s=>{for(const n of s.items)if(n.ownerId===ownerId&&(all||ids.includes(n.id)))n.readAt||=new Date(clock()).toISOString();});},
    async readSession(ownerId:string,sessionId:string,cursor:string){await update(s=>{const last=s.items.findIndex(n=>n.ownerId===ownerId&&n.id===cursor);if(last<0)return;for(const n of s.items.slice(0,last+1))if(n.ownerId===ownerId&&n.sessionId===sessionId)n.readAt||=new Date(clock()).toISOString();});},
    async grant(ownerId:string,requestId:string,accepted:string[]){
      if(!/^[\w-]{8,100}$/.test(requestId)||!options.identity(ownerId)||options.identity(ownerId)?.appId!==config().appId||accepted.some(id=>!templates().some(t=>t.id===id)))throw Error('订阅回执无效。');
      await update(s=>{const receipt=ownerId+':'+requestId;if(s.receipts[receipt])return;s.receipts[receipt]=new Date(clock()).toISOString();const grants=s.grants[ownerId]||={};for(const id of new Set(accepted)){const g=grants[id]||{count:0,at:new Date(clock()).toISOString()};if(!g.count)g.at=new Date(clock()).toISOString();g.count++;grants[id]=g;}});
    },
    async disable(ownerId:string){await update(s=>{s.grants[ownerId]={};});},
    presence(ownerId:string,device:string,sequence:number,foreground:boolean){
      if(!/^[\w-]{8,80}$/.test(device)||!Number.isSafeInteger(sequence)||sequence<0)throw Error('在线状态无效。');
      const key=ownerId+':'+device,old=presence.get(key);if(!old||old.sequence<sequence)presence.set(key,{ownerId,sequence,foreground,at:clock()});
      for(const [id,p]of presence)if(clock()-p.at>120000)presence.delete(id);
    },
  };
}
export function disabledNotifications(){
  const unavailable=async(..._args:unknown[])=>{throw Error('消息服务暂不可用。');};
  return{ready:false,flush:async()=>{},list:(_ownerId:string,_limit?:number):NoticeInbox=>({items:[],unread:0,unreadBySession:{},cursor:'',revision:0}),get:(_ownerId:string,_id:string)=>undefined,configuration:(_ownerId:string)=>({available:false,templates:[]}),record:unavailable,read:unavailable,readSession:unavailable,grant:unavailable,disable:unavailable,presence:(..._args:unknown[])=>{}};
}
