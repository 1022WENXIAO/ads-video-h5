import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';

// Validate generated artifacts, including the URLs that browsers actually load.
export async function verifyFrontendBuilds(directory, { revision, basePath = '/' }) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw Error('前端发布需要明确的完整 Git 版本。');
  if (!basePath.startsWith('/') || basePath.startsWith('//') || /[?#\\]/.test(basePath) || basePath.split('/').includes('..')) throw Error('前端发布路径必须是站点内的绝对路径。');
  const base = basePath.endsWith('/') ? basePath : basePath + '/';
  const root = await realpath(directory), origin = 'https://frontend-build.invalid';
  const checked = [];
  for (const name of ['', 'admin', 'desktop']) {
    const label = name || 'H5', folder = path.join(root, name);
    const marker = JSON.parse(await readFile(path.join(folder, 'release.json'), 'utf8'));
    if (marker.revision !== revision) throw Error(`${label} 发布版本与本次发布不一致。`);
    const document = parse(await readFile(path.join(folder, 'index.html'), 'utf8'));
    const resources = [];
    function visit(node) {
      const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
      if (node.tagName === 'script' && attrs.src) resources.push({ type: 'script', url: attrs.src });
      const relations = (attrs.rel || '').toLowerCase().split(/\s+/);
      if (node.tagName === 'link' && attrs.href) for (const type of ['stylesheet', 'modulepreload']) if (relations.includes(type)) resources.push({ type, url: attrs.href });
      for (const child of node.childNodes || []) visit(child);
    }
    visit(document);
    if (!resources.some(r => r.type === 'script') || !resources.some(r => r.type === 'stylesheet')) throw Error(`${label} 页面缺少脚本或样式。`);
    const prefix = base + (name ? name + '/' : '');
    for (const resource of resources) {
      const url = new URL(resource.url, origin);
      if (url.origin !== origin || !resource.url.startsWith('/') || !url.pathname.startsWith(prefix)) throw Error(`${label} 资源路径错误：${resource.url}，应以 ${prefix} 开头。`);
      const decoded = decodeURIComponent(url.pathname), relative = decoded.slice(base.length);
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) throw Error(`${label} 资源路径越界。`);
      let actual;
      try { actual = await realpath(file); } catch { throw Error(`${label} 资源文件缺失：${resource.url}`); }
      if (!actual.startsWith(root + path.sep) || !(await stat(actual)).isFile()) throw Error(`${label} 资源文件无效：${resource.url}`);
    }
    checked.push({ entry: label, revision, basePath: prefix, resources: resources.length });
  }
  return checked;
}
