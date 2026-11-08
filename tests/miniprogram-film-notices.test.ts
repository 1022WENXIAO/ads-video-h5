import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePage,loadNativeApp,recorderFixture} from './fixtures/nativeClient';

const templateId='ukUfWhwb-ZiXh1YUuIosMEGmDTvmgHIi9wuF9EqJj2Y';
const inbox=(revision=1,sessionId='b',cursor='notice-1')=>({items:[],unread:1,unreadBySession:{[sessionId]:1},cursor,revision});
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
async function fixture(t:any,name:string){
  const calls:any[]=[],storage=new Map(),wx:any={getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:any)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),getRecorderManager:()=>recorderFixture(),getWindowInfo:()=>({windowHeight:700,windowWidth:390}),showToast:(o:any)=>calls.push(['toast',o.title]),navigateTo:(o:any)=>calls.push(['navigate',o.url]),switchTab:(o:any)=>calls.push(['tab',o.url]),requirePrivacyAuthorize:(o:any)=>o.success(),reLaunch(){}};
  const app=await loadNativeApp(wx);
  app.state={account:{id:'owner',displayName:'原昵称',authProvider:'wechat'},features:{conversationModes:true,accountAvatars:true,notifications:true,filmAnalysis:true},activeSessionId:'a',sessions:[{id:'a',mode:'chat',title:'A',messages:[]},{id:'b',mode:'work',title:'B',messages:[{id:'bm',role:'user',text:'任务',createdAt:'2026-11-08T00:00:00Z'}]}],media:[],artifacts:[],jobs:[],models:[],settings:{},credits:{balance:1000}};
  app.client={hasSession:()=>true,clear(){},previewUrl:()=>'',cachedDownload:()=>'',download:async()=>'/local-cover',request:async(route:string,body:any,method:string)=>{
    calls.push(['request',route,body,method]);
    if(route==='/api/notifications/config')return{available:true,templates:[{id:templateId,kind:'all',remaining:0}]};
    if(route==='/api/notifications/presence')return{ok:true};
    if(route.endsWith('/activate'))return{activeSessionId:app.state.activeSessionId};
    return app.state;
  }};
  app._foreground=true;
  const page=await capturePage(name,app,wx);page.onLoad?.({});page.onShow();await flush();
  t.after(()=>{page.onUnload?.();app.onHide();});
  return{app,page,wx,calls};
}

test('an unread completion is a dot on its own session, with no extra message channel or global alert',async t=>{
  const f=await fixture(t,'chat'),p=f.page;
  f.app.apply({...f.app.state,notifications:inbox()});p.openSidebar();
  const rows=p.data.sidebarGroups.flatMap((g:any)=>g.items);
  assert.equal(rows.find((s:any)=>s.id==='a').unread,false);assert.equal(rows.find((s:any)=>s.id==='b').unread,true);
  assert.equal(f.calls.filter((c:any)=>c[0]==='toast').length,0);
  assert.equal(f.calls.filter((c:any)=>c[1]==='/api/notifications/read-session').length,0,'looking at the list does not read other sessions');
});

test('opening B marks only the viewed cursor; a stale read receipt cannot remove a later completion or steal selection A',async t=>{
  const f=await fixture(t,'chat'),p=f.page;let finish!:(value:any)=>void;
  f.app.apply({...f.app.state,notifications:inbox(10,'b','old-notice')});
  const request=f.app.client.request;f.app.client.request=(route:string,body:any,method:string)=>{
    if(route==='/api/notifications/read-session'){f.calls.push(['read',body]);return new Promise(resolve=>{finish=resolve;});}return request(route,body,method);
  };
  p.openSidebar();p.sidebarActivate({currentTarget:{dataset:{id:'b'}}});
  assert.equal(p.data.sessionId,'b');assert.deepEqual(f.calls.find(c=>c[0]==='read')[1],{sessionId:'b',cursor:'old-notice'});
  p.sidebarActivate({currentTarget:{dataset:{id:'a'}}});p.setData({prompt:'A草稿'});
  f.app.apply({...f.app.state,notifications:inbox(12,'b','new-notice')});
  finish({items:[],unread:0,unreadBySession:{},cursor:'old-notice',revision:11});await flush();
  assert.equal(f.app.state.notifications.revision,12);assert.equal(f.app.state.notifications.unreadBySession.b,1);assert.equal(p.data.sessionId,'a');assert.equal(p.data.prompt,'A草稿');
});

test('a drawer covering the current conversation does not silently read a new reply behind it',async t=>{
  const f=await fixture(t,'chat'),p=f.page;p.openSidebar();
  const request=f.app.client.request;f.app.client.request=async(route:string,body:any,method:string)=>{if(route==='/api/notifications/read-session'){f.calls.push(['read',body]);return{items:[],unread:0,unreadBySession:{},cursor:'n-a',revision:3};}return request(route,body,method);};
  f.app.apply({...f.app.state,notifications:inbox(2,'a','n-a')});assert.equal(f.calls.some(c=>c[0]==='read'),false);
  p.closeSidebar();await flush();assert.equal(f.calls.filter(c=>c[0]==='read').length,1);assert.equal(f.app.state.notifications.unread,0);
});

test('profile edits open from the top identity, preserve an active nickname draft through polls and close only after saving',async t=>{
  const f=await fixture(t,'profile'),p=f.page;
  p.editAvatar();assert.equal(p.data.avatarEditor,true);p.closeEditors();assert.equal(p.data.avatarEditor,false);
  p.editName();p.nickname({detail:{value:'新昵称'}});p.render({...f.app.state,account:{...f.app.state.account,displayName:'服务器旧值'}});assert.equal(p.data.nickname,'新昵称');
  let finish!:(value:any)=>void;const request=f.app.client.request;
  f.app.client.request=(route:string,body:any,method:string)=>{if(route==='/api/auth/wechat/profile'){assert.equal(body.displayName,'新昵称');assert.equal(method,'PATCH');return new Promise(resolve=>{finish=resolve;});}return request(route,body,method);};
  const saving=p.saveName();p.closeEditors();assert.equal(p.data.nameEditor,true);finish({user:{...f.app.state.account,displayName:'新昵称'}});await saving;
  assert.equal(p.data.nameEditor,false);assert.equal(p.data.user.displayName,'新昵称');assert.equal(p.data.savingName,false);
});

test('an old account nickname response is ignored after the login changes',async t=>{
  const f=await fixture(t,'profile'),p=f.page;let finish!:(value:any)=>void;
  p.editName();p.nickname({detail:{value:'旧账号草稿'}});f.app.client.request=()=>new Promise(resolve=>{finish=resolve;});
  const saving=p.saveName();f.app._generation++;f.app.user={id:'new-owner',displayName:'新账号'};finish({user:{id:'owner',displayName:'旧账号草稿'}});await saving;
  assert.equal(f.app.user.id,'new-owner');assert.notEqual(p.data.user.displayName,'旧账号草稿');
});

test('generated teaching intermediates are retained in production archive; real archived source clips stay reusable and searchable',async t=>{
  const f=await fixture(t,'library'),p=f.page;
  f.app.apply({...f.app.state,media:[{id:'raw',name:'原片',kind:'video',origin:'upload'},{id:'generated',name:'教学分镜-泛泛的示例.mp4',kind:'video',origin:'generated'},{id:'clip',name:'教学分镜-用户选中的真实镜头',kind:'video',origin:'imported',archive:{tags:['对照'],sourceId:'raw'}}]});
  assert.deepEqual(Array.from(p.data.items,(m:any)=>m.id).sort(),['clip','raw']);assert.equal(p.data.productionCount,1);assert.equal(f.app.state.media.length,3);
  p.collection({currentTarget:{dataset:{collection:'production'}}});assert.equal(p.data.items[0].id,'generated');
  p.collection({currentTarget:{dataset:{collection:'clips'}}});p.search({detail:{value:'对照'}});assert.equal(p.data.items.length,1);assert.equal(p.data.items[0].id,'clip');
  p.use({currentTarget:{dataset:{id:'clip'}}});assert.deepEqual(Array.from(f.app.pendingAttachments),['clip']);
});

test('WeChat subscription is requested only on the settings tap, before posting the accepted receipt',async t=>{
  const f=await fixture(t,'settings'),p=f.page;const events:any[]=[];
  f.wx.requestSubscribeMessage=(o:any)=>{events.push('sdk');assert.deepEqual(Array.from(o.tmplIds),[templateId]);o.success({[templateId]:'accept'});};
  assert.equal(events.length,0,'opening settings cannot prompt for permission');
  const request=f.app.client.request;f.app.client.request=async(route:string,body:any,method:string)=>{if(route==='/api/notifications/subscribe'){events.push('receipt');assert.deepEqual(Array.from(body.accepted),[templateId]);return{ok:true};}return request(route,body,method);};
  const subscribing=p.subscribeNotice();assert.equal(events[0],'sdk');await subscribing;assert.deepEqual(events,['sdk','receipt']);
  f.wx.requestSubscribeMessage=(o:any)=>o.success({[templateId]:'reject'});await p.subscribeNotice();assert.deepEqual(events,['sdk','receipt'],'declining does not register a grant or block other functions');
});
