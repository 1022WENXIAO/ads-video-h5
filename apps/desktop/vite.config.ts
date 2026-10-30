import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { releasePlugin } from '../../tooling/releasePlugin';
export default defineConfig(({command}) => {
  const webBase = `${(process.env.VITE_BASE_PATH || '/').replace(/\/$/,'')}/`;
  const apiBase = `${(process.env.VITE_API_BASE_PATH || (command === 'build' ? webBase : '/')).replace(/\/+$/,'')}/`;
  return { base: command === 'build' ? `${webBase}desktop/` : '/desktop/', plugins:[react(),releasePlugin()], define:{'import.meta.env.VITE_API_BASE_PATH':JSON.stringify(apiBase)}, server:{proxy:{[`${apiBase.replace(/\/$/,'')}/api`]:{target:process.env.VITE_API_TARGET || 'http://127.0.0.1:8787',changeOrigin:false,rewrite:p=>apiBase==='/'?p:p.slice(apiBase.length-1)}}} };
});
