import {useEffect,useState,useRef} from 'react';
import './creativeGame.css';
export default function CreativeGamePreview({endpoint,token}:{endpoint:string;token?:string}){
 const frame=useRef<HTMLIFrameElement>(null);
 const [url,setUrl]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{const controller=new AbortController();setUrl('');setError('');void fetch(endpoint,{signal:controller.signal,headers:token?{Authorization:`Bearer ${token}`}:{}}).then(async r=>{if(!r.ok)throw Error('试玩加载失败，请刷新登录后重试。');return r.json();}).then(v=>{if(!controller.signal.aborted)setUrl(v.url)}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[endpoint,token,reload]);
 const enlarge=()=>{const active=frame.current;if(!active?.requestFullscreen){setNotice('浏览器暂不支持全屏，可在卡片内试玩。');return;}void active.requestFullscreen().catch(()=>setNotice('浏览器暂不支持全屏，可在卡片内试玩。'));};
 return <div className="creative-game-preview">{error?<p role="alert">{error}</p>:url?<iframe ref={frame} title="Defold游戏试玩" src={url} sandbox="allow-scripts allow-pointer-lock" allow="fullscreen *" allowFullScreen style={{border:0,width:'100%',aspectRatio:'3/2',minHeight:280,background:'#09121f'}}/>:<p>正在加载游戏…</p>}<div className="creative-game-controls">{url?<button type="button" onClick={enlarge}>放大试玩</button>:null}<button type="button" onClick={()=>setReload(n=>n+1)}>重新加载试玩</button></div>{notice?<p>{notice}</p>:null}</div>;
}
