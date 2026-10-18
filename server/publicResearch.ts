import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { currentJobSignal, throwIfJobCancelled } from './jobExecution';

export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Global unicast only; exclude documentation, transition and protocol ranges.
  return isIP(ip) === 6 && /^[23][\da-f]{3}:/i.test(ip) && !/^2001:db8:|^2002:/i.test(ip) && !(/^2001:/i.test(ip) && parseInt(ip.split(':')[1] || '0',16)<0x200);
}

export function publicResearchUrl(value: string): string | undefined {
  try {
    const u = new URL(value), host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:' || u.username || u.password || u.port || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || !host.includes('.') && !isIP(host) || isIP(host) && !publicAddress(host)) return;
    u.hash = ''; return u.href;
  } catch { return; }
}

/** A search engine may return an old HTTP spelling. Upgrade it before any
 * connection; the original host, public-address checks and TLS stay required. */
export function publicArticleUrl(value:string):string|undefined{
  try{const url=new URL(value);if(url.protocol==='http:'&&!url.port)url.protocol='https:';return publicResearchUrl(url.href);}catch{return;}
}

export interface PublicPage { url: string; text: string; contentType: string; }
export interface PublicReadOptions { signal?: AbortSignal; timeoutMs?: number; }
export type PublicReader = (url: string, options?: PublicReadOptions) => Promise<PublicPage>;

const pageLimit = 1500000;
// HTTPS can return compressed bytes even without content negotiation. Keep
// both the wire and expanded size bounded before decoding the declared text.
export function decodePublicPageBody(body: Buffer, contentType: string, contentEncoding = ''): string {
  if (body.length > pageLimit) throw new Error('研究页面超过 1.5 MB 上限。');
  const encodings = contentEncoding.toLowerCase().split(',').map(v => v.trim()).filter(v => v && v !== 'identity');
  let decoded = body;
  for (const encoding of encodings.reverse()) {
    try {
      const options = { maxOutputLength: pageLimit };
      if (encoding === 'gzip' || encoding === 'x-gzip') decoded = gunzipSync(decoded, options);
      else if (encoding === 'deflate') decoded = inflateSync(decoded, options);
      else if (encoding === 'br') decoded = brotliDecompressSync(decoded, options);
      else throw new Error('不支持的压缩编码。');
    } catch { throw new Error('研究页面解压失败或解压后超过 1.5 MB 上限。'); }
  }
  const headerCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = decoded.subarray(0, 4096).toString('latin1');
  const metaCharset = /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const charset = headerCharset || metaCharset || 'utf-8';
  try { return new TextDecoder(/^gb(?:2312|k)$/i.test(charset) ? 'gb18030' : charset).decode(decoded); }
  catch { throw new Error('研究页面的文字编码无法读取。'); }
}

// Validate and pin every resolved connection, including redirects. No proxy,
// cookies, TLS exceptions or access to private addresses for external sources.
export async function readPublicPage(value: string, options: PublicReadOptions = {}, redirects = 0): Promise<PublicPage> {
  throwIfJobCancelled();
  const safe = publicResearchUrl(value);
  if (!safe || redirects > 3) throw new Error('研究资料 URL 必须是公开 HTTPS 页面。');
  return new Promise((resolve, reject) => {
    const req = request(safe, {
      signal: currentJobSignal() && options.signal ? AbortSignal.any([currentJobSignal()!, options.signal]) : options.signal || currentJobSignal(),
      headers: { Accept: 'text/html,application/xhtml+xml,application/json,text/plain', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Qingjian-Research/1.0' },
      lookup: (host, options, cb) => lookup(host, { all: true }, (error, addresses) => {
        if (error) return cb(error, '', 4);
        if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return cb(new Error('研究页面解析到非公开地址。'), '', 4);
        const selected = addresses.find(a => a.family === 4) || addresses[0];
        if (options.all) (cb as Function)(null, [selected]);
        else cb(null, selected.address, selected.family);
      }),
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next=publicArticleUrl(new URL(res.headers.location,safe).href);
        res.resume(); if(!next){reject(new Error('研究页面跳转不是公开 HTTPS 地址。'));return;}readPublicPage(next, options, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`研究页面 HTTP ${res.statusCode}`)); return; }
      const contentType = String(res.headers['content-type'] || '');
      if (!/text\/html|application\/(?:json|ld\+json|xhtml\+xml)|text\/plain/.test(contentType)) { res.resume(); reject(new Error('研究页面不是可读取的网页或 JSON。')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > pageLimit) req.destroy(new Error('研究页面超过 1.5 MB 上限。')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ url: safe, text: decodePublicPageBody(Buffer.concat(chunks), contentType, String(res.headers['content-encoding'] || '')), contentType }); }
        catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('研究页面读取超时。')), options.timeoutMs ?? 20000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
  });
}
