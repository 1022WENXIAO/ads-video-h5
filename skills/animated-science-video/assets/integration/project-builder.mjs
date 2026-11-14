const json=(v)=>JSON.stringify(v).replace(/</g,'\\u003c');
const attr=(v)=>v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const script=(v)=>v.replace(/<\/script/gi,'<\\/script');
/** Generated code exists only in an opaque-origin iframe, without host APIs or network. */
export function buildScienceDocument(parts,config){
  const {renderer,scene,motion,reference,metrics}=parts;
  const strip=(s)=>s.replace(/^import [^\r\n]*(?:\r?\n|$)/gm,'').replace(/\bexport /g,'');
  const normalized={...config,scene:'authored',fps:30,footerLeft:'教学示意 · 非真实模型推理'};
  const child=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#070b13}canvas{display:block;width:100%;height:100%}</style></head><body><canvas id="canvas" width="1080" height="1920"></canvas><script>
globalThis.__name=fn=>fn;
window.addEventListener('error',event=>{window.__sceneError=event.message});
const config=${json(normalized)};
const api=(()=>{${script(strip(motion))};return createMotionAPI();})();
api.config=config;
api.references=(()=>{${script(strip(reference))};return {compression:createCompressionReference()};})();
const authored=(()=>{${config.program?script(config.program.source)+'\nconst result=createScene(api);if(!result||typeof result.stateAt!=="function"||typeof result.paintPanel!=="function"||typeof result.checkModels!=="function")throw Error("createScene必须返回stateAt、paintPanel、checkModels");return {...result,paintPanel:(ui,...args)=>result.paintPanel(api.extendUI(ui),...args)};':script(strip(scene))+';return {stateAt,stepTime,paintPanel};'}})();
${script(strip(renderer))}
${script(strip(metrics))}
const canvas=document.getElementById('canvas'),renderer=createRenderer(canvas,config);
window.science={renderer,config,panelRects,authored,api,createMotionMeter};
try{renderer.draw(0)}catch(error){window.__sceneError=String(error.message||error)}
window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='qingjian:science:seek'&&Number.isFinite(event.data.time))renderer.draw(event.data.time)});
</script></body></html>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' about:; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${attr(config.title)}</title><style>body{margin:0;background:#070b13;color:#eff4fc;font-family:system-ui;text-align:center}iframe{border:0;display:block;margin:auto;width:min(100vw,calc(88vh * 9 / 16));height:min(calc(100vw * 16 / 9),88vh)}button,input{margin:12px}input{width:min(50vw,360px)}</style></head><body><iframe id="stage" title="同屏动态科普" sandbox="allow-scripts" srcdoc="${attr(child)}"></iframe><button id="play" type="button">播放</button><input aria-label="播放进度" id="seek" type="range" min="0" max="${config.duration}" step="0.0333333" value="0"><span id="time">0.0s</span>${config.bgm?'<audio id="music" loop src="bgm.wav"></audio>':''}<script>
const duration=${config.duration},stage=document.getElementById('stage'),play=document.getElementById('play'),seek=document.getElementById('seek'),music=document.getElementById('music');let playing=false,start=0,current=0,raf;
function draw(t){current=t;stage.contentWindow.postMessage({type:'qingjian:science:seek',time:t},'*');seek.value=String(t);document.getElementById('time').textContent=t.toFixed(1)+'s'}
function tick(now){if(!playing)return;draw(((now-start)/1000)%duration);raf=requestAnimationFrame(tick)}
play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放';if(playing){start=performance.now()-current*1000;if(music){music.currentTime=current%16;music.play().catch(()=>{})}raf=requestAnimationFrame(tick)}else{cancelAnimationFrame(raf);music?.pause()}};
seek.oninput=()=>{draw(Number(seek.value));start=performance.now()-current*1000;if(music)music.currentTime=current%16};stage.onload=()=>draw(0);
</script></body></html>`;
}
