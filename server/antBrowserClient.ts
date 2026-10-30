import { chromium, type Browser } from 'playwright';
import { currentJobSignal, throwIfJobCancelled } from './jobExecution';
export type BrowserOperation = 'profiles' | 'status' | 'open' | 'read' | 'click' | 'fill' | 'stop';
export interface BrowserCommand {
  operation: BrowserOperation;
  profile: string;
  args: Record<string, string>;
}
export function antLocalUrl(value: string) {
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Ant-Browser API 仅允许本机 HTTP 地址。');
  return url.origin;
}
export function createAntBrowserClient(baseUrl: string, apiKey?: string) {
  const base = antLocalUrl(baseUrl);
  const connections = new Map<string, Browser>();
  let tail = Promise.resolve();
  async function api(route: string, body?: unknown) {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(65000),
        ...(currentJobSignal() ? [currentJobSignal()!] : []),
      ]),
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-Ant-Api-Key': apiKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Ant-Browser API 返回 HTTP ${response.status}。`);
    }
    return response.json() as Promise<any>;
  }
  async function page(profile: string) {
    let browser = connections.get(profile);
    if (!browser?.isConnected()) {
      const limit = Math.max(1, Math.min(8, Number(process.env.ANT_BROWSER_MAX_RUNNING || 1) || 1));
      const list = await api('/api/profiles');
      const running = (list.items || list.profiles || []).filter(
        (item: any) => item.running && String(item.launchCode || item.code).toUpperCase() !== profile,
      );
      if (running.length >= limit) throw new Error('服务器的浏览器实例已达到运行上限，请先停止不用的实例。');
      const result = await api('/api/runtime/session', {
        selector: { code: profile, matchMode: 'unique' },
        timeoutMs: 45000,
        skipDefaultStartUrls: true,
      });
      if (!result.ready || !result.debugReady || !result.cdpUrl)
        throw new Error('Ant-Browser 实例尚未就绪，请稍后查询状态。');
      const endpoint = antLocalUrl(result.cdpUrl);
      browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
      connections.set(profile, browser);
      browser.on('disconnected', () => {
        if (connections.get(profile) === browser) connections.delete(profile);
      });
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('Ant-Browser 未提供可接管的上下文。');
    return context.pages().find((page) => !page.isClosed()) || context.newPage();
  }
  return {
    async health() {
      const result = await api('/api/health');
      if (result.ok !== true) throw new Error('Ant-Browser 健康检查未通过。');
      return { ok: true };
    },
    async createProfile(code: string, name: string) {
      return api('/api/profiles', { profile: { profileName: name }, launchCode: code.toUpperCase(), autoLaunch: false });
    },
    async execute(command: BrowserCommand) {
      const pending = tail.then(async () => {
        throwIfJobCancelled();
        const { operation, args } = command;
        // Native Ant canonicalizes launch codes when an instance starts. Use
        // the same identity for connection reuse, selectors and capacity checks.
        const profile = command.profile.trim().toUpperCase();
        if (operation === 'profiles') {
          const result = await api('/api/profiles');
          const items = result.items || result.profiles;
          if (!Array.isArray(items)) throw new Error('Ant-Browser 实例列表格式不兼容。');
          return {
            profiles: items.slice(0, 200).map((p: any) => ({
              id: p.profileId || p.id,
              code: p.launchCode || p.launch_code || p.code || p.profileId || p.id,
              name: p.name || p.profileName,
              running: p.running === true,
            })),
          };
        }
        if (!profile || profile.length > 160) throw new Error('浏览器实例标识无效。');
        if (operation === 'status' || operation === 'stop') {
          const result = await api('/api/runtime/' + operation, {
            selector: { code: profile, matchMode: 'unique' },
          });
          if (operation === 'stop') connections.delete(profile);
          return {
            running: result.running,
            ready: result.ready ?? result.debugReady,
            profileName: result.profileName,
            ok: result.ok,
          };
        }
        if (!['open', 'read', 'click', 'fill'].includes(operation)) throw new Error('不支持此浏览器操作。');
        const tab = await page(profile);
        throwIfJobCancelled();
        if (operation === 'open') {
          const url = new URL(args.url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
            throw new Error('只能打开普通 HTTP/HTTPS 网页。');
          await tab.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        if (operation === 'click')
          await tab
            .getByRole((args.role || 'button') as 'button', { name: args.name, exact: true })
            .click({ timeout: 15000 });
        if (operation === 'fill') {
          const field = tab.getByLabel(args.label, { exact: true });
          if ((await field.getAttribute('type')) === 'password')
            throw new Error('密码请在 Ant-Browser 中手动填写，连接器不会代填。');
          await field.fill(args.text, { timeout: 15000 });
        }
        // Reading page text is bounded and cannot execute instructions returned by a page.
        return {
          url: tab.url(),
          title: await tab.title(),
          text: await tab
            .locator('body')
            .evaluate((element) => (element as HTMLElement).innerText.slice(0, 18000), undefined, {
              timeout: 10000,
            }),
        };
      });
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
