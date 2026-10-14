import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Format, NewsPublicationAnnotation, NewsPublicationLayout } from '../src/types';
import { newsPublicationCanvasDimensions } from './newsPublicationProof';
import { newsPublicationNoteHtml } from './newsTime';
import { onJobAbort, throwIfJobCancelled } from './jobExecution';

// Use the renderer's existing browser/dependencies. Never download a browser or
// rely on a development-only Playwright installation in production.
async function installedBrowser() {
  const require = createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{ default: puppeteer }, browsers] = await Promise.all([import(require.resolve('puppeteer-core')), import(require.resolve('@puppeteer/browsers'))]);
  const explicit = process.env.HYPERFRAMES_BROWSER_PATH || process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if (explicit) { await access(explicit); return { puppeteer, executablePath: explicit }; }
  for (const cacheDir of [path.join(homedir(), '.cache/hyperframes/chrome'), path.join(homedir(), '.cache/puppeteer')]) {
    const installed = await browsers.getInstalledBrowsers({ cacheDir }).catch(() => []);
    const platform = browsers.detectBrowserPlatform();
    const match = installed.filter((item: any) => item.platform === platform && ['chrome-headless-shell', 'chrome'].includes(item.browser)).sort((a: any, b: any) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))[0];
    if (match) { await access(match.executablePath); return { puppeteer, executablePath: match.executablePath }; }
  }
  throw new Error('新闻日期真实布局检查缺少已安装的渲染浏览器。');
}

/** Inspect actual Chromium glyph geometry throughout the scene, before the
 * same immutable HTML is rendered. A source attribute or regex alone cannot pass. */
export async function inspectNewsPublicationHtml(project: string, annotation: NewsPublicationAnnotation, duration: number, format: Format): Promise<{ htmlHash: string; layout: NewsPublicationLayout }> {
  throwIfJobCancelled();
  newsPublicationNoteHtml(annotation);
  if (!Number.isFinite(duration) || duration < .1) throw new Error('新闻日期检查缺少有效分镜时长。');
  const htmlFile = path.join(project, 'index.html'), before = await readFile(htmlFile);
  const sizes=newsPublicationCanvasDimensions(format);
  let [width,height]=sizes[0];
  let expectedY = height > width ? 180 : 106;
  const times = [...new Set([0, .1, duration * .25, duration * .5, duration * .75, Math.max(0, duration - 1 / 30)].filter(time => time < duration).map(time => +time.toFixed(6)))];
  const { puppeteer, executablePath } = await installedBrowser();
  const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] });
  const removeAbort = onJobAbort(() => { void browser.close(); });
  const timer = setTimeout(() => { void browser.close(); }, 60000);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', (request: any) => { if (/^(?:file:|data:)/.test(request.url())) void request.continue(); else void request.abort(); });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load', timeout: 20000 });
    const canvas=await page.$eval('#main',(element:Element)=>({width:Number((element as HTMLElement).dataset.width),height:Number((element as HTMLElement).dataset.height)}));
    const matched=sizes.some(([w,h])=>canvas.width===w&&canvas.height===h);
    if(!matched)throw new Error('新闻报道日期检查画布与分镜画幅不一致。');
    width=canvas.width;height=canvas.height;expectedY=height>width?180:106;
    await page.setViewport({width,height,deviceScaleFactor:1});
    await page.evaluate(() => document.fonts.ready);
    let measured: NewsPublicationLayout | undefined;
    for (const time of times) {
      throwIfJobCancelled();
      const sample = await page.evaluate((input: { time: number; annotation: NewsPublicationAnnotation; expectedY: number; width: number; height: number }) => {
        const timeline = (window as any).__timelines?.main;
        if (!timeline?.seek) throw new Error('新闻日期检查缺少真实动画时间线。');
        timeline.pause().seek(input.time, false);
        const note = document.querySelector<HTMLElement>('#note');
        if (!note || document.querySelectorAll('#note').length !== 1 || note.dataset.newsSourceId !== input.annotation.referenceId || note.dataset.newsPublishedAt !== input.annotation.publishedAt || note.dataset.newsCutoff !== input.annotation.cutoffUtc || note.textContent !== input.annotation.label + ' · 画面示意') throw new Error('新闻报道日期实际HTML节点与来源不一致。');
        const rect = note.getBoundingClientRect(), style = getComputedStyle(note), range = document.createRange();
        range.selectNodeContents(note);
        const glyph = range.getBoundingClientRect();
        let opacity = 1;
        for (let parent: Element | null = note; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent); opacity *= Number(css.opacity);
          if (css.display === 'none' || css.visibility !== 'visible') throw new Error('新闻报道日期被隐藏：selector=#note,ancestor='+parent.tagName);
          const bounds = parent.getBoundingClientRect();
          if (/(?:hidden|clip|scroll|auto)/.test(css.overflowX + css.overflowY) && (glyph.left < bounds.left - .5 || glyph.right > bounds.right + .5 || glyph.top < bounds.top - .5 || glyph.bottom > bounds.bottom + .5)) throw new Error('新闻报道日期被裁切：selector=#note,ancestor='+parent.tagName+',rect='+JSON.stringify({x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}));
        }
        const fontSize = parseFloat(style.fontSize);
        if (fontSize < 24 || opacity < .99 || Math.abs(rect.x - 40) > .5 || Math.abs(rect.y - input.expectedY) > .5 || rect.width <= 0 || rect.height < 24 || rect.right > input.width - 39.5 || rect.bottom > (input.height > input.width ? 220 : 160) || glyph.left < rect.left - .5 || glyph.right > rect.right + .5 || glyph.top < rect.top - .5 || glyph.bottom > rect.bottom + .5) throw new Error('新闻报道日期未在预留安全区完整可读：'+JSON.stringify({fontSize,opacity,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},glyph:{left:glyph.left,right:glyph.right,top:glyph.top,bottom:glyph.bottom}}));
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, element = node.parentElement;
          if (!element || note.contains(element) || /^(?:SCRIPT|STYLE)$/.test(element.tagName) || !node.textContent?.trim()) continue;
          let visible = true, alpha = 1;
          for (let parent: Element | null = element; parent; parent = parent.parentElement) { const css = getComputedStyle(parent); alpha *= Number(css.opacity); if (css.display === 'none' || css.visibility !== 'visible') visible = false; }
          if (!visible || alpha < .01) continue;
          const otherRange = document.createRange(); otherRange.selectNodeContents(node);
          for (const other of Array.from(otherRange.getClientRects())) if (other.width > 0 && other.height > 0 && other.left < glyph.right - .5 && other.right > glyph.left + .5 && other.top < glyph.bottom - .5 && other.bottom > glyph.top + .5) throw new Error('新闻报道日期与实际文字碰撞：selector=#note,other='+(element.id?'#'+element.id:element.tagName)+',rect='+JSON.stringify({x:other.x,y:other.y,width:other.width,height:other.height}));
        }
        for (const x of [glyph.left + 2, (glyph.left + glyph.right) / 2, glyph.right - 2]) {
          const cover = document.elementFromPoint(x, (glyph.top + glyph.bottom) / 2);
          if (cover && cover !== note && !note.contains(cover)) throw new Error('新闻报道日期被其他画面元素遮挡：selector=#note,other='+(cover.id?'#'+cover.id:cover.tagName));
        }
        return { fontSize, x: rect.x, y: rect.y, width: rect.width, height: rect.height, minimumOpacity: opacity };
      }, { time, annotation, expectedY, width, height });
      if (!measured) measured = { ...sample, sampledTimes: times };
      else {
        if ((['fontSize', 'x', 'y', 'width', 'height'] as const).some(key => Math.abs(sample[key] - measured![key]) > .5)) throw new Error('新闻报道日期在动画中移动或改变可读布局。');
        measured.minimumOpacity = Math.min(measured.minimumOpacity, sample.minimumOpacity);
      }
    }
    throwIfJobCancelled();
    const after = await readFile(htmlFile);
    if (!before.equals(after)) throw new Error('新闻日期检查期间HTML发生改变。');
    return { htmlHash: createHash('sha256').update(before).digest('hex'), layout: measured! };
  } catch(error) {
    throwIfJobCancelled();
    const message=error instanceof Error?error.message:String(error);
    if(/新闻报道日期(?:被隐藏|被裁切|未在预留安全区|与实际文字碰撞|被其他画面元素遮挡|在动画中移动)/.test(message))throw new Error('HTML inspect 未通过：selector=#note；'+message,{cause:error});
    throw error;
  } finally { clearTimeout(timer); removeAbort(); await browser.close(); }
}
