import { useEffect, useState } from 'react';
import {
  Search,
  X,
  Scissors,
  Globe,
  Plus,
  Plug,
  Puzzle,
  Check,
  LoaderCircle,
  Video,
  BarChart3,
  ShieldCheck,
} from 'lucide-react';
import {
  defaultAgentCapabilities,
  type AgentCapabilities,
  type CapabilityCatalog,
} from '../../../shared/agentCapabilities';
import type { Session } from '../../../shared/types';
import { api } from './api';
export type CapabilityTab = 'Skills' | 'MCP' | '插件' | '浏览器';
export default function CapabilityPanel({
  session,
  tab,
  onTab,
  close,
  save,
  locked,
}: {
  session?: Session;
  tab: CapabilityTab;
  onTab: (tab: CapabilityTab) => void;
  close: () => void;
  save: (settings: AgentCapabilities) => Promise<void>;
  locked: boolean;
}) {
  const [catalog, setCatalog] = useState<CapabilityCatalog>(),
    [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [adding, setAdding] = useState(false),
    [profiles, setProfiles] = useState<
      Array<{
        code: string;
        name: string;
        running: boolean;
      }>
    >([]);
  const settings = session?.capabilities || defaultAgentCapabilities();
  const refresh = () => api<CapabilityCatalog>('/api/capabilities').then(setCatalog);
  useEffect(() => {
    const controller = new AbortController();
    api<CapabilityCatalog>('/api/capabilities', 'GET', undefined, controller.signal)
      .then(setCatalog)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, []);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (key: 'skillIds' | 'mcpIds' | 'pluginIds', id: string) =>
    perform(() =>
      save({
        ...settings,
        [key]: settings[key].includes(id)
          ? settings[key].filter((item) => item !== id)
          : [...settings[key], id],
      }),
    );
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const input =
        tab === '插件'
          ? JSON.parse(String(form.get('manifest')))
          : tab === 'Skills'
            ? { name: form.get('name'), content: form.get('content') }
            : { name: form.get('name'), url: form.get('url'), token: form.get('token') };
      await api(
        `/api/capabilities/${tab === 'Skills' ? 'skills' : tab === 'MCP' ? 'mcp' : 'plugins'}`,
        'POST',
        input,
      );
      setAdding(false);
      setNotice('已添加，可为当前会话启用。');
    });
  }
  const [showAll, setShowAll] = useState(false);
  const allRows = catalog
    ? (tab === 'Skills' ? catalog.skills : tab === 'MCP' ? catalog.mcps : catalog.plugins).filter((item) =>
        (item.name + ' ' + item.description).toLowerCase().includes(search.toLowerCase()),
      )
    : [];
  const rows =
    tab === 'Skills' && !search && !showAll
      ? allRows.filter((item, index) => index < 4 || !item.builtin)
      : allRows;
  return (
    <aside className="capability-panel" aria-label="能力中心">
      <header>
        <h2>能力中心</h2>
        <button className="icon-button" onClick={close} aria-label="关闭能力中心">
          <X size={20} />
        </button>
      </header>
      <p className="panel-description">为当前对话选择技能与工具。</p>
      <div className="capability-tabs" role="tablist">
        {(['Skills', 'MCP', '插件', '浏览器'] as const).map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            onClick={() => {
              onTab(item);
              setAdding(false);
              setError('');
              setNotice('');
            }}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="panel-content">
        {locked ? <p className="panel-note">任务执行期间设置已冻结，完成或停止后可调整。</p> : null}
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="inline-success">
            {notice}
          </p>
        ) : null}
        {tab !== '浏览器' ? (
          <>
            <label className="search-box">
              <Search size={16} />
              <input
                aria-label="搜索能力"
                placeholder={`搜索${tab === 'Skills' ? '已安装技能' : tab}`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="capability-items">
              {rows.map((item) => {
                const key = tab === 'Skills' ? 'skillIds' : tab === 'MCP' ? 'mcpIds' : 'pluginIds';
                const selected = settings[key].includes(item.id);
                return (
                  <article className="capability-item" key={item.id}>
                    <div className="capability-icon">
                      {tab === 'Skills' ? (
                        item.id === 'qingjian-teaching-video' ? (
                          <Video size={20} />
                        ) : item.id === 'qingjian-hot-video' ? (
                          <BarChart3 size={20} />
                        ) : item.id === 'qingjian-render-review' ? (
                          <ShieldCheck size={20} />
                        ) : (
                          <Scissors size={20} />
                        )
                      ) : tab === 'MCP' ? (
                        <Plug size={20} />
                      ) : (
                        <Puzzle size={20} />
                      )}
                    </div>
                    <div className="capability-copy">
                      <strong>{item.name}</strong>
                      <p>{item.description}</p>
                      {!item.builtin ? (
                        <small>
                          {item.source ||
                            (tab === 'MCP'
                              ? 'Streamable HTTP'
                              : tab === '插件'
                                ? '声明式插件'
                                : '自定义 SKILL.md')}
                        </small>
                      ) : null}
                      {tab === 'MCP' ? (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const result = await api<{
                                tools: unknown[];
                              }>(`/api/capabilities/mcp/${item.id}/test`, 'POST', {});
                              setNotice(`连接成功，发现 ${result.tools.length} 个工具。`);
                            })
                          }
                        >
                          测试连接
                        </button>
                      ) : null}
                    </div>
                    <button
                      className={`toggle ${selected ? 'on' : ''}`}
                      role="switch"
                      aria-label={`启用${item.name}`}
                      aria-checked={selected}
                      disabled={busy || locked || !session}
                      onClick={() => void toggle(key, item.id)}
                    >
                      <span />
                    </button>
                  </article>
                );
              })}
              {catalog && !rows.length ? (
                <p className="empty-list">
                  {search
                    ? '没有匹配的能力。'
                    : `尚未添加${tab === 'MCP' ? ' MCP 服务' : tab === '插件' ? '插件' : '自定义技能'}。`}
                </p>
              ) : null}
            </div>
            {tab === 'Skills' && !search && allRows.length > rows.length ? (
              <button className="text-button" onClick={() => setShowAll(true)}>
                显示其余内置技能（{allRows.length - rows.length}）
              </button>
            ) : null}
            <button className="add-capability" onClick={() => setAdding(!adding)} disabled={busy}>
              <Plus size={16} />
              {tab === 'Skills' ? '导入 SKILL.md' : tab === 'MCP' ? '添加 MCP 服务' : '导入插件清单'}
            </button>
            {adding ? (
              <form className="capability-form" onSubmit={add}>
                {tab === '插件' ? (
                  <>
                    <label>
                      插件 JSON 清单
                      <textarea
                        name="manifest"
                        rows={9}
                        required
                        placeholder={
                          '{"name":"我的插件","skills":[{"name":"写作","content":"# 写作要求\\n…"}]}'
                        }
                      />
                    </label>
                    <p className="muted">支持 skills 与 mcpServers 组合，不运行安装脚本或 hooks。</p>
                  </>
                ) : (
                  <>
                    <label>
                      名称
                      <input name="name" required maxLength={80} />
                    </label>
                    {tab === 'Skills' ? (
                      <label>
                        SKILL.md 内容
                        <textarea name="content" rows={9} maxLength={64000} required />
                      </label>
                    ) : (
                      <>
                        <label>
                          HTTPS MCP 地址
                          <input name="url" type="url" required placeholder="https://example.com/mcp" />
                        </label>
                        <label>
                          Bearer Token（可选）
                          <input name="token" type="password" autoComplete="new-password" />
                        </label>
                        <p className="muted">服务器需允许该 MCP 域名。凭据仅存于后台，不回传给页面。</p>
                      </>
                    )}
                  </>
                )}
                <button className="primary" disabled={busy}>
                  保存{tab === 'Skills' ? '技能' : tab === 'MCP' ? '服务' : '插件'}
                </button>
              </form>
            ) : null}
            {tab === 'Skills' ? (
              <p className="muted small-note">内置技能仍按制作场景自动加载；开关可将额外技能加入当前对话。</p>
            ) : null}
          </>
        ) : (
          <section className="browser-settings">
            <div className="browser-logo">
              <Globe size={28} />
            </div>
            <h3>Ant-Browser</h3>
            <p>与轻剪后台同机运行。每个账号使用独立实例，登录态与指纹配置保存在服务器。</p>
            <div className="connection-state">
              <i className={catalog?.browser.connected ? 'online' : ''} />
              {catalog?.browser.connected
                ? '服务已连接'
                : catalog?.browser.configured
                  ? '尚未验证连接'
                  : '服务器尚未配置'}
            </div>
            {catalog?.browser.error ? <p className="inline-error">{catalog.browser.error}</p> : null}
            <button
              className="secondary"
              disabled={busy || !catalog?.browser.configured}
              onClick={() =>
                void perform(async () => {
                  const result = await api<{
                    profiles: typeof profiles;
                  }>('/api/capabilities/browser/profiles');
                  setProfiles(result.profiles);
                  setNotice(
                    result.profiles.length ? '已读取当前账号的实例。' : '服务已连接，请先创建独立实例。',
                  );
                })
              }
            >
              {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}检测服务并加载实例
            </button>
            <button
              className="secondary"
              disabled={busy || locked || !catalog?.browser.configured}
              onClick={() =>
                void perform(async () => {
                  const result = await api<{
                    code: string;
                  }>('/api/capabilities/browser/profiles', 'POST', { name: '轻剪创作浏览器' });
                  const list = await api<{
                    profiles: typeof profiles;
                  }>('/api/capabilities/browser/profiles');
                  setProfiles(list.profiles);
                  await save({ ...settings, browserProfile: result.code });
                  setNotice('实例已创建并绑定当前会话。');
                })
              }
            >
              <Plus size={14} />
              创建我的独立实例
            </button>
            {settings.browserProfile ? (
              <button
                className="secondary"
                disabled={busy || locked}
                onClick={() =>
                  void perform(async () => {
                    await api('/api/capabilities/browser/stop', 'POST', { profile: settings.browserProfile });
                    setNotice('已停止选中的浏览器实例，登录数据保留。');
                  })
                }
              >
                停止选中实例
              </button>
            ) : null}
            <label>
              当前对话使用的实例
              <select
                aria-label="浏览器实例"
                value={settings.browserProfile}
                disabled={busy || locked}
                onChange={(event) =>
                  void perform(() => save({ ...settings, browserProfile: event.target.value }))
                }
              >
                <option value="">不使用浏览器</option>
                {profiles.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name || item.code}
                  </option>
                ))}
                {settings.browserProfile &&
                !profiles.some((item) => item.code === settings.browserProfile) ? (
                  <option value={settings.browserProfile}>{settings.browserProfile}</option>
                ) : null}
              </select>
            </label>
            <p className="muted">
              实例不会随对话结束而关闭。创建分叉后继承实例选择；同一实例的浏览器操作按顺序执行。
            </p>
          </section>
        )}
      </div>
      {tab === 'Skills' ? (
        <div className="browser-quick-row">
          <Globe size={21} />
          <div>
            <strong>Ant-Browser</strong>
            <span>
              <i className={catalog?.browser.connected ? 'online' : ''} />
              {catalog?.browser.connected ? '服务已连接' : '未连接'}
            </span>
          </div>
          <button className="secondary" onClick={() => onTab('浏览器')}>
            配置连接
          </button>
        </div>
      ) : null}
      <footer className="panel-footer">设置随会话保存，分叉时继承。</footer>
    </aside>
  );
}
