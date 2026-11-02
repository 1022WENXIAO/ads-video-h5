import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url);
export function canvasRuntime(){
 let runtime;try{runtime=require('@napi-rs/canvas')}catch(e){if(!process.env.ANIMATED_VIDEO_NODE_MODULES)throw Error('Run npm install in this project, or set ANIMATED_VIDEO_NODE_MODULES to an existing node_modules directory');runtime=require(path.join(process.env.ANIMATED_VIDEO_NODE_MODULES,'@napi-rs/canvas'))}
 const candidates=[process.env.ANIMATED_VIDEO_FONT,'/System/Library/Fonts/Hiragino Sans GB.ttc','/System/Library/Fonts/PingFang.ttc','C:/Windows/Fonts/msyh.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'].filter(Boolean);
 const font=candidates.find(p=>fs.existsSync(p));if(!font||!runtime.GlobalFonts.registerFromPath(font,'Animated CJK'))throw Error('Set ANIMATED_VIDEO_FONT to an installed Chinese TTF/OTF/TTC font; no font is bundled');
 return {...runtime,font};
}
export const ffmpeg=()=>process.env.ANIMATED_VIDEO_FFMPEG||'ffmpeg';
export const sha256=async data=>(await import('node:crypto')).createHash('sha256').update(data).digest('hex');
