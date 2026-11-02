import {createRenderer} from './renderer.mjs';
const config=new URL(new URLSearchParams(location.search).get('config')||'configs/compression.json',location.href),cfg=await(await fetch(config)).json(),renderer=createRenderer(document.querySelector('canvas'),cfg);
document.title=cfg.title+' · 可编辑预览';document.querySelector('#title').textContent=cfg.title;document.querySelector('#note').textContent=cfg.boundary;
const audio=document.querySelector('#bgm'),slider=document.querySelector('#seek');slider.max=cfg.duration;audio.volume=Math.min(1,10**((cfg.bgmGainDb??-3)/20));if(cfg.bgm)audio.src=new URL(cfg.bgm,config).href;
let playing=false,current=0,start=0;
function draw(){renderer.draw(current);slider.value=current;document.querySelector('#time').textContent=current.toFixed(2)+' / '+cfg.duration+' 秒'}
function frame(now){if(playing){current=((now-start)/1000)%cfg.duration;draw();requestAnimationFrame(frame)}}
document.querySelector('#play').onclick=()=>{playing=!playing;if(playing){start=performance.now()-current*1000;if(cfg.bgm){if(Number.isFinite(audio.duration))audio.currentTime=current%audio.duration;audio.play().catch(()=>{})}requestAnimationFrame(frame)}else audio.pause()};
slider.oninput=()=>{current=Number(slider.value);start=performance.now()-current*1000;if(Number.isFinite(audio.duration))audio.currentTime=current%audio.duration;draw()};document.querySelector('#reset').onclick=()=>{current=0;start=performance.now();if(Number.isFinite(audio.duration))audio.currentTime=0;draw()};draw();
// Read-only QA hook; no dependence on accumulated frame history.
window.animation={seek(t){current=t;start=performance.now()-t*1000;draw()},get time(){return current},get playing(){return playing},cfg};
