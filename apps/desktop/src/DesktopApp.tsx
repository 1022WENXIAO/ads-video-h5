import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Plus,
  MessageSquare,
  Folder,
  Video,
  Clock3,
  Puzzle,
  Settings,
  GitBranch,
  Check,
  PanelRight,
  Paperclip,
  ArrowUp,
  Square,
  Globe,
  Plug,
  Search,
  X,
  LoaderCircle,
  LogOut,
  Scissors,
  ChevronDown,
} from 'lucide-react';
import type { PublicUser, Session, Job, ChatMessage } from '../../../shared/types';
import type { DesktopState as AppState } from './types';
import { defaultAgentCapabilities, type AgentCapabilities } from '../../../shared/agentCapabilities';
import CapabilityPanel, { type CapabilityTab } from './CapabilityPanel';
import ExecutionList from './ExecutionList';
import ScheduleWorkspace from './ScheduleWorkspace';
import { api, apiUrl } from './api';
type Page = 'chat' | 'media' | 'films' | 'schedules' | 'settings';
const active = (job: Job) => ['queued', 'running', 'stopping'].includes(job.status);
const navigation = [
  { page: 'chat', name: '对话', icon: MessageSquare },
  { page: 'media', name: '素材库', icon: Folder },
  { page: 'films', name: '成片库', icon: Video },
  { page: 'schedules', name: '定时任务', icon: Clock3 },
] as const;
export default function DesktopApp({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [state, setState] = useState<AppState>(),
    [page, setPage] = useState<Page>('chat'),
    [panel, setPanel] = useState<CapabilityTab | null>(null),
    [error, setError] = useState(''),
    [offline, setOffline] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [attachments, setAttachments] = useState<Record<string, string[]>>({});
  const follow = useRef(true);
  const epoch = useRef(0),
    current = useRef<AppState | undefined>(undefined),
    file = useRef<HTMLInputElement>(null),
    end = useRef<HTMLDivElement>(null);
  const apply = useCallback((next: AppState) => {
    current.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const version = epoch.current;
      try {
        const next = await api<AppState>('/api/state', 'GET', undefined, signal);
        if (version === epoch.current) apply(next);
        setOffline(false);
      } catch (cause) {
        if (!signal?.aborted) {
          setOffline(true);
          setError((cause as Error).message);
        }
      }
    },
    [apply],
  );
  const hasActive = Boolean(state?.jobs.some(active));
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const sync = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        await refresh(controller.signal);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void sync(), hasActive ? 2200 : offline ? 5000 : 15000);
    const focus = () => void sync();
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refresh, hasActive, offline]);
  const session = state?.sessions.find((item) => item.id === state.activeSessionId),
    id = session?.id || '',
    draft = drafts[id] || '',
    selected = attachments[id] || [];
  const jobs = state?.jobs.filter((item) => item.sessionId === id) || [],
    running = jobs.some(active),
    settings = session?.capabilities || defaultAgentCapabilities();
  const lastMessage = session?.messages.at(-1);
  useEffect(() => {
    follow.current = true;
  }, [id]);
  useEffect(() => {
    if (follow.current) end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [id, lastMessage?.id, lastMessage?.text]);
  async function mutate(path: string, method = 'POST', body: unknown = {}) {
    epoch.current++;
    setBusy(true);
    setError('');
    try {
      const next = await api<AppState>(path, method, body);
      apply(next);
      setOffline(false);
      return next;
    } catch (cause) {
      setError((cause as Error).message);
      throw cause;
    } finally {
      epoch.current++;
      setBusy(false);
    }
  }
  const action = (work: () => Promise<unknown>) => {
    void work().catch((cause) => setError(cause instanceof Error ? cause.message : '操作失败，请重试。'));
  };
  async function activate(target: string) {
    await mutate(`/api/sessions/${target}/activate`);
    setPage('chat');
  }
  async function newChat() {
    await mutate('/api/sessions');
    setPage('chat');
  }
  async function fork(messageId?: string) {
    if (!session) return;
    await mutate(`/api/sessions/${session.id}/fork`, 'POST', messageId ? { messageId } : {});
    setPage('chat');
  }
  async function saveCapabilities(next: AgentCapabilities) {
    if (!id) return;
    await mutate(`/api/sessions/${id}/capabilities`, 'PATCH', next);
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!id || !draft.trim() || busy) return;
    try {
      await mutate('/api/chat', 'POST', { sessionId: id, message: draft, attachmentIds: selected });
      setDrafts((value) => ({ ...value, [id]: '' }));
      setAttachments((value) => ({ ...value, [id]: [] }));
    } catch {
      /* Input remains available for retry. */
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    epoch.current++;
    setBusy(true);
    setError('');
    try {
      const data = new FormData();
      Array.from(files).forEach((item) => data.append('files', item));
      const response = await fetch(apiUrl('/api/media'), { method: 'POST', body: data });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || '上传失败。');
      apply(next);
      if (page === 'chat')
        setAttachments((value) => ({
          ...value,
          [id]: [...new Set([...(value[id] || []), ...(next.uploadedMediaIds || [])])].slice(0, 6),
        }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      epoch.current++;
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }
  const title =
    page === 'chat'
      ? session?.title || '新建对话'
      : navigation.find((item) => item.page === page)?.name || '工作台设置';
  return (
    <div className={`desktop-workspace${panel ? ' with-panel' : ''}`}>
      <aside className="workspace-sidebar">
        <button className="desktop-wordmark" onClick={() => setPage('chat')}>
          轻剪
        </button>
        <button className="new-chat primary" onClick={() => action(newChat)} disabled={busy}>
          <Plus size={18} />
          新建对话
        </button>
        <nav>
          {navigation.filter(item=>item.page!=='schedules'||state?.schedules!==undefined).map((item) => (
            <button
              className={page === item.page ? 'selected' : ''}
              onClick={() => setPage(item.page)}
              key={item.page}
            >
              <item.icon size={18} />
              {item.name}
            </button>
          ))}
          <button className={panel ? 'selected' : ''} onClick={() => setPanel(panel ? null : 'Skills')}>
            <Puzzle size={18} />
            能力中心
          </button>
        </nav>
        <div className="sidebar-divider" />
        <div className="history-heading">
          最近会话<span>{state?.sessions.length || 0}</span>
        </div>
        <label className="history-search">
          <Search size={14} />
          <input
            aria-label="搜索会话"
            value={query}
            placeholder="搜索会话"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="history-list">
          {state?.sessions
            .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((item) => (
              <button
                key={item.id}
                className={item.id === id && page === 'chat' ? 'selected' : ''}
                onClick={() => action(() => activate(item.id))}
                disabled={busy}
              >
                {item.forkedFrom ? <GitBranch size={15} /> : <MessageSquare size={15} />}
                <span>{item.title}</span>
                {state.jobs.some((job) => job.sessionId === item.id && active(job)) ? (
                  <i className="activity-dot" />
                ) : null}
              </button>
            ))}
        </div>
        <div className="sidebar-account">
          <span className="account-avatar">{(user.displayName || '我').slice(0, 1)}</span>
          <div>
            <strong>{user.displayName || '我的账号'}</strong>
            <small>
              {state?.credits
                ? `${state.credits.balance.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 积分`
                : '个人工作台'}
            </small>
          </div>
          <button className="icon-button" aria-label="工作台设置" onClick={() => setPage('settings')}>
            <Settings size={17} />
          </button>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="workspace-topbar">
          <div className="workspace-title">
            <h1 title={title}>{title}</h1>
            {session?.forkedFrom && page === 'chat' ? (
              <small>
                <GitBranch size={12} />
                来自已有会话的分叉
              </small>
            ) : null}
          </div>
          <div className="workspace-actions">
            {page === 'chat' ? (
              <button className="secondary" onClick={() => action(() => fork())} disabled={busy || !session}>
                <GitBranch size={15} />
                分叉
              </button>
            ) : null}
            <span className={`save-status${offline ? ' offline' : ''}`}>
              {offline ? <X size={14} /> : <Check size={14} />}{' '}
              {offline ? '连接中断' : !state ? '正在连接…' : busy ? '正在保存…' : '已自动保存'}
            </span>
            <button
              className="icon-button"
              aria-label="打开能力中心"
              onClick={() => setPanel(panel ? null : 'Skills')}
            >
              <PanelRight size={18} />
            </button>
          </div>
        </header>
        {error ? (
          <div className="workspace-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="关闭错误" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        ) : null}
        {!state ? (
          <div className="workspace-loading">
            <LoaderCircle size={22} className="spin" />
            <p>正在恢复你的工作台…</p>
            <button className="secondary" onClick={() => void refresh()}>
              重新连接
            </button>
          </div>
        ) : page === 'chat' ? (
          <>
            <div
              className="conversation"
              role="log"
              aria-label="对话消息"
              onScroll={(event) => {
                const view = event.currentTarget;
                follow.current = view.scrollHeight - view.clientHeight - view.scrollTop < 90;
              }}
            >
              {!session?.messages.length ? (
                <div className="conversation-empty">
                  <div className="empty-symbol">
                    <Scissors size={27} />
                  </div>
                  <h2>从一个想法，开始创作</h2>
                  <p>描述你想完成的事，轻剪会规划步骤、调用工具并保存结果。</p>
                  <div className="prompt-suggestions">
                    {['帮我整理一个视频脚本', '分析素材里的精彩片段', '搜索并核验一个热点主题'].map(
                      (text) => (
                        <button key={text} onClick={() => setDrafts((value) => ({ ...value, [id]: text }))}>
                          {text}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              ) : (
                session.messages.map((message) => {
                  const job = jobs.find((item) => item.id === message.jobId);
                  const artifact = state.artifacts.find((item) => message.artifactIds?.includes(item.id));
                  const final = message.parts?.find((part) => part.phase === 'final')?.text || message.text;
                  return (
                    <article className={`desktop-message ${message.role}`} key={message.id}>
                      <div className="message-avatar">
                        {message.role === 'user' ? (
                          (user.displayName || '我').slice(0, 1)
                        ) : (
                          <Scissors size={18} />
                        )}
                      </div>
                      <div className="message-content">
                        {message.role === 'assistant' && job && active(job) ? (
                          <p className="message-stage">
                            <LoaderCircle size={13} className="spin" />
                            {job.stage || '正在处理你的请求…'}
                          </p>
                        ) : null}
                        {final ? <div className="message-prose">{final}</div> : null}
                        {message.attachmentIds?.length ? (
                          <div className="message-files">
                            {message.attachmentIds.map((mediaId) => (
                              <span key={mediaId}>
                                <Paperclip size={12} />
                                {state.media.find((item) => item.id === mediaId)?.name || '素材'}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {message.role === 'assistant' && job ? (
                          <ExecutionList
                            job={job}
                            retry={() => action(() => mutate(`/api/jobs/${job.id}/retry`))}
                          />
                        ) : null}
                        {artifact ? (
                          <div className="artifact-preview">
                            {artifact.kind === 'video' ? (
                              <video controls src={artifact.url} preload="metadata" />
                            ) : artifact.kind === 'image' ? (
                              <img src={artifact.url} alt={artifact.name} />
                            ) : (
                              <audio controls src={artifact.url} />
                            )}
                            <a href={artifact.downloadUrl || artifact.url} download>
                              {artifact.name}
                            </a>
                          </div>
                        ) : null}
                        <button
                          className="message-fork"
                          aria-label="从这条消息分叉"
                          title="从这条消息创建独立会话"
                          onClick={() => action(() => fork(message.id))}
                          disabled={busy}
                        >
                          <GitBranch size={12} />
                          从这里分叉
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={end} />
            </div>
            <div className="composer-region">
              <div className="execution-policy">
                <select
                  aria-label="工具执行方式"
                  value={settings.toolMode}
                  disabled={busy || running}
                  onChange={(event) =>
                    action(() =>
                      saveCapabilities({
                        ...settings,
                        toolMode: event.target.value as AgentCapabilities['toolMode'],
                      }),
                    )
                  }
                >
                  <option value="parallel">并行工具</option>
                  <option value="sequential">顺序执行</option>
                </select>
                {settings.toolMode === 'parallel' ? (
                  <select
                    aria-label="最大并行工具数"
                    value={settings.maxParallel}
                    disabled={busy || running}
                    onChange={(event) =>
                      action(() => saveCapabilities({ ...settings, maxParallel: Number(event.target.value) }))
                    }
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option value={n} key={n}>
                        最多 {n} 个
                      </option>
                    ))}
                  </select>
                ) : null}
                {state.models.filter((item) => item.kind === 'text' && item.enabled).length ? (
                  <select
                    aria-label="对话模型"
                    value={session?.modelId || ''}
                    disabled={busy || running}
                    onChange={(event) =>
                      action(() =>
                        mutate(`/api/sessions/${id}/model`, 'PATCH', { modelId: event.target.value }),
                      )
                    }
                  >
                    <option value="" disabled>
                      系统默认模型
                    </option>
                    {state.models
                      .filter((item) => item.kind === 'text' && item.enabled)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                ) : null}
              </div>
              <form className="desktop-composer" onSubmit={send}>
                {selected.length ? (
                  <div className="composer-attachments">
                    {selected.map((mediaId) => (
                      <button
                        type="button"
                        key={mediaId}
                        onClick={() =>
                          setAttachments((value) => ({
                            ...value,
                            [id]: selected.filter((item) => item !== mediaId),
                          }))
                        }
                      >
                        {state.media.find((item) => item.id === mediaId)?.name || '素材'}
                        <X size={11} />
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  aria-label="对话指令"
                  placeholder="描述你想完成的事…"
                  value={draft}
                  onChange={(event) => setDrafts((value) => ({ ...value, [id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={2}
                  maxLength={2000}
                />
                <div className="composer-toolbar">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="添加素材"
                    onClick={() => file.current?.click()}
                    disabled={busy}
                  >
                    <Paperclip size={18} />
                  </button>
                  <div className="composer-tools">
                    <button
                      type="button"
                      className={panel === 'Skills' ? 'active' : ''}
                      onClick={() => setPanel('Skills')}
                    >
                      <Scissors size={14} />
                      Skills{settings.skillIds.length ? ` · ${settings.skillIds.length}` : ''}
                    </button>
                    <button
                      type="button"
                      className={panel === 'MCP' ? 'active' : ''}
                      onClick={() => setPanel('MCP')}
                    >
                      <Plug size={14} />
                      MCP{settings.mcpIds.length ? ` · ${settings.mcpIds.length}` : ''}
                    </button>
                    <button
                      type="button"
                      className={settings.browserProfile ? 'active' : ''}
                      onClick={() => setPanel('浏览器')}
                    >
                      <Globe size={14} />
                      浏览器
                    </button>
                    {running && !draft.trim() ? (
                      <button
                        type="button"
                        className="send-message"
                        aria-label="停止运行"
                        disabled={busy}
                        onClick={() => action(() => mutate(`/api/sessions/${id}/stop`))}
                      >
                        <Square size={15} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="send-message"
                        type="submit"
                        aria-label="发送指令"
                        disabled={busy || !id || !draft.trim()}
                      >
                        {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="composer-hint">
                已启用的能力将用于当前对话<span>Enter 发送 · Shift Enter 换行</span>
              </p>
            </div>
          </>
        ) : page === 'media' ? (
          <section className="library-workspace">
            <div className="section-heading">
              <div>
                <h2>素材库</h2>
                <p>上传的素材与生成结果，均按账号保存。</p>
              </div>
              <button className="primary" onClick={() => file.current?.click()} disabled={busy}>
                <Plus size={15} />
                上传素材
              </button>
            </div>
            <div className="asset-grid">
              {state.media.map((item) => (
                <article key={item.id}>
                  {item.kind === 'image' ? (
                    <img src={item.url} alt={item.name} loading="lazy" />
                  ) : item.kind === 'video' ? (
                    <video src={item.url} controls preload="metadata" />
                  ) : (
                    <audio src={item.url} controls preload="metadata" />
                  )}
                  <strong>{item.name}</strong>
                  <button
                    className="secondary"
                    onClick={() => {
                      setAttachments((value) => ({
                        ...value,
                        [id]: [...new Set([...(value[id] || []), item.id])].slice(0, 6),
                      }));
                      setPage('chat');
                    }}
                  >
                    加入当前对话
                  </button>
                </article>
              ))}
            </div>
            {!state.media.length ? (
              <p className="empty-list">还没有素材。上传视频、图片或音频开始创作。</p>
            ) : null}
          </section>
        ) : page === 'films' ? (
          <section className="library-workspace">
            <div className="section-heading">
              <div>
                <h2>成片库</h2>
                <p>查看、播放和下载已生成的作品。</p>
              </div>
            </div>
            <div className="asset-grid">
              {state.artifacts.map((item) => (
                <article key={item.id}>
                  {item.kind === 'video' ? (
                    <video src={item.url} controls preload="metadata" />
                  ) : item.kind === 'image' ? (
                    <img src={item.url} alt={item.name} loading="lazy" />
                  ) : (
                    <audio src={item.url} controls preload="metadata" />
                  )}
                  <strong>{item.name}</strong>
                  <a href={item.downloadUrl || item.url} download>
                    下载文件
                  </a>
                </article>
              ))}
            </div>
            {!state.artifacts.length ? <p className="empty-list">生成的作品会保存在这里。</p> : null}
          </section>
        ) : page === 'schedules' ? (
          <ScheduleWorkspace state={state} busy={busy} mutate={mutate} />
        ) : (
          <section className="library-workspace">
            <h2>工作台设置</h2>
            <div className="settings-row">
              <div>
                <strong>桌面端、移动端与小程序</strong>
                <p>独立客户端，共用账号、持久化会话、素材和任务。</p>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>能力中心</strong>
                <p>配置当前会话使用的 Skills、MCP、插件和指纹浏览器。</p>
              </div>
              <button className="secondary" onClick={() => setPanel('Skills')}>
                打开
              </button>
            </div>
            <button className="secondary" onClick={() => action(logout)}>
              <LogOut size={15} />
              退出账号
            </button>
          </section>
        )}
      </main>
      {panel ? (
        <CapabilityPanel
          session={session}
          tab={panel}
          onTab={setPanel}
          close={() => setPanel(null)}
          save={saveCapabilities}
          locked={busy || running}
        />
      ) : null}
      <input
        hidden
        type="file"
        multiple
        ref={file}
        onChange={(event) => void upload(event.target.files)}
        accept="video/*,image/*,audio/*"
      />
    </div>
  );
}
