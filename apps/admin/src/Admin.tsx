import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Plus, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import type { ModelKind } from '../../../shared/types';
import type { AdminAccount, AdminLogin as LoginResult } from '../../../shared/adminAuthTypes';
import { api as request, ApiError } from './api';
import AdminLogin from './AdminLogin';
const TemplateAdmin = lazy(() => import('./TemplateAdmin'));
const EffectAdmin = lazy(() => import('./EffectAdmin'));
const EvaluationAdmin = lazy(() => import('./EvaluationAdmin'));
const AccountSecurity = lazy(() => import('./AccountSecurity'));
const CreditAdmin = lazy(() => import('./CreditAdmin'));

interface AdminModel {
  id: string;
  name: string;
  provider: string;
  kind: ModelKind;
  modelId: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
}

interface ModelForm {
  id: string | null;
  name: string;
  provider: string;
  kind: ModelKind;
  modelId: string;
  baseUrl: string;
  enabled: boolean;
  apiKey: string;
}

const blankForm = (): ModelForm => ({ id: null, name: '', provider: 'ark', kind: 'text', modelId: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', enabled: true, apiKey: '' });
const kindName: Record<ModelKind, string> = { text: '文本对话', image: '图片生成', audio: '口播音频', understanding: '音频理解 / ASR' };
const tokenKey = 'qingjian-admin-session';

export default function Admin() {
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey) || '');
  const tokenRef = useRef(token);
  const [account, setAccount] = useState<AdminAccount | null>(null);
  const [loginNotice, setLoginNotice] = useState('');
  const [models, setModels] = useState<AdminModel[]>([]);
  const [defaultTextModelId, setDefaultTextModelId] = useState<string | null>(null);
  const [form, setForm] = useState<ModelForm>(blankForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'models' | 'effects' | 'templates' | 'evaluations' | 'credits' | 'security'>('models');

  const load = useCallback(async (accessToken: string, signal?: AbortSignal) => {
    const data = await request<{ models: AdminModel[]; defaultTextModelId: string | null }>('/api/admin/models', accessToken, { signal });
    setModels(data.models);
    setDefaultTextModelId(data.defaultTextModelId);
  }, []);

  const clearSession = useCallback(() => {
    tokenRef.current = ''; sessionStorage.removeItem(tokenKey); setToken(''); setAccount(null); setModels([]); setForm(blankForm()); setError(''); setNotice(''); setTab('models');
  }, []);

  useEffect(() => {
    sessionStorage.removeItem('qingjian-admin-token');
    const expired = (event: Event) => { if ((event as CustomEvent<{ token: string }>).detail?.token !== tokenRef.current) return; clearSession(); setLoginNotice('管理员登录已失效，请重新登录。'); };
    window.addEventListener('qingjian:admin:unauthorized', expired);
    return () => window.removeEventListener('qingjian:admin:unauthorized', expired);
  }, [clearSession]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const controller = new AbortController();
    void request<{ account: AdminAccount }>('/api/admin/auth/session', token, { signal: controller.signal }).then(async data => {
      if (!active) return;
      setAccount(data.account);
      if (data.account.mustChangePassword) setTab('security');
      else await load(token, controller.signal);
    }).catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) { clearSession(); setLoginNotice(cause.message); }
      else { setError(cause instanceof Error ? cause.message : '无法连接管理后台。'); }
    });
    return () => { active = false; controller.abort(); };
  }, [load, token, clearSession]);

  function loggedIn(result: LoginResult) {
    tokenRef.current = result.token; sessionStorage.setItem(tokenKey, result.token); setToken(result.token); setAccount(result.account); setError(''); setLoginNotice('');
    if (result.account.mustChangePassword || result.usedRecoveryCode) setTab('security');
    if (result.usedRecoveryCode) setNotice('已使用一次性恢复码登录，请检查 Authenticator 绑定状态。');
  }

  async function signOut() {
    setBusy(true); setError('');
    try { await request('/api/admin/auth/logout', token, { method: 'POST' }); clearSession(); setLoginNotice('已退出管理后台。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出失败，请重试。'); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const url = form.id ? `/api/admin/models/${form.id}` : '/api/admin/models';
      const method = form.id ? 'PUT' : 'POST';
      await request(url, token, { method, body: JSON.stringify({ ...form, apiKey: form.apiKey || undefined }) });
      await load(token);
      setForm(blankForm());
      setNotice('模型配置已保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function remove(model: AdminModel) {
    if (!window.confirm(`确定删除「${model.name}」？使用它的生成任务可能无法重试。`)) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/admin/models/${model.id}`, token, { method: 'DELETE' });
      await load(token);
      if (form.id === model.id) setForm(blankForm());
      setNotice('模型已删除。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败。');
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(model: AdminModel) {
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/default-text-model', token, { method: 'PUT', body: JSON.stringify({ id: model.id }) });
      setDefaultTextModelId(model.id);
      setNotice(`「${model.name}」已设为新对话的默认模型。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置失败。');
    } finally {
      setBusy(false);
    }
  }

  function edit(model: AdminModel) {
    setForm({ id: model.id, name: model.name, provider: model.provider, kind: model.kind, modelId: model.modelId, baseUrl: model.baseUrl, enabled: model.enabled, apiKey: '' });
    setNotice('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="admin-page">
      <header className="admin-topbar">
        <a href={import.meta.env.VITE_WEB_URL} className="admin-back"><ArrowLeft size={18} /> 返回轻剪</a>
        <div className="admin-brand">轻剪<span>.</span> <small>管理后台</small></div>
        {token ? <button type="button" className="admin-signout" disabled={busy} onClick={() => void signOut()}>退出管理</button> : <span />}
      </header>

      {!token ? (
        <AdminLogin onLogin={loggedIn} notice={loginNotice} />
      ) : !account ? <main className="admin-login"><h1>正在验证登录…</h1>{error ? <div className="admin-alert" role="alert">{error}</div> : null}</main> : (
        <main className="admin-layout">
          <nav className="admin-tabs" aria-label="管理功能"><button type="button" disabled={account.mustChangePassword} className={tab === 'models' ? 'is-active' : ''} onClick={() => setTab('models')}>模型与密钥</button><button type="button" disabled={account.mustChangePassword} className={tab === 'effects' ? 'is-active' : ''} onClick={() => setTab('effects')}>HTML 视频特效</button><button type="button" disabled={account.mustChangePassword} className={tab === 'templates' ? 'is-active' : ''} onClick={() => setTab('templates')}>视频模板</button><button type="button" disabled={account.mustChangePassword} className={tab === 'evaluations' ? 'is-active' : ''} onClick={() => setTab('evaluations')}>Agent 能力评测</button><button type="button" disabled={account.mustChangePassword} className={tab === 'credits' ? 'is-active' : ''} onClick={() => setTab('credits')}>用户与积分</button><button type="button" className={tab === 'security' ? 'is-active' : ''} onClick={() => setTab('security')}>账号安全</button></nav>
          {error && tab !== 'models' ? <div className="admin-alert" role="alert">{error}</div> : null}
          {notice && tab === 'security' ? <div className="admin-notice" role="status"><Check size={16} />{notice}</div> : null}
          {tab === 'templates' ? <Suspense fallback={<p>正在加载视频模板…</p>}><TemplateAdmin token={token} models={models}/></Suspense> : tab === 'credits' ? <Suspense fallback={<p>正在加载用户与积分…</p>}><CreditAdmin token={token} /></Suspense> : tab === 'security' ? <Suspense fallback={<p>正在加载账号安全…</p>}><AccountSecurity token={token} account={account} onLogin={loggedIn} /></Suspense> : tab === 'effects' ? <Suspense fallback={<p>正在加载特效库…</p>}><EffectAdmin token={token} /></Suspense> : tab === 'evaluations' ? <Suspense fallback={<p>正在加载评测台…</p>}><EvaluationAdmin token={token} models={models}/></Suspense> : <>
          <div className="admin-heading"><div><h1>模型与密钥</h1><p>配置对话、图片和口播模型。新密钥保存后仅显示配置状态。</p></div><ShieldCheck size={28} /></div>
          {error ? <div className="admin-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误"><X size={16} /></button></div> : null}
          {notice ? <div className="admin-notice" role="status"><Check size={16} />{notice}</div> : null}
          <div className="admin-columns">
            <section className="admin-panel admin-editor">
              <div className="admin-panel-heading"><h2>{form.id ? '编辑模型' : '添加模型'}</h2>{form.id ? <button type="button" onClick={() => setForm(blankForm())}>取消编辑</button> : null}</div>
              <form onSubmit={(event) => void save(event)}>
                <div className="admin-form-grid">
                  <label>显示名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 豆包 Seed 2.1 Pro" required maxLength={80} /></label>
                  <label>用途<select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ModelKind, ...(event.target.value === 'understanding' ? { modelId: 'doubao-seed-2-1-lite-260915' } : {}) })}><option value="text">文本对话</option><option value="image">图片生成</option><option value="audio">口播音频</option><option value="understanding">音频理解 / ASR</option></select></label>
                  <label>厂商或适配器<input value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} placeholder="ark / volcengine-voice" required maxLength={80} /></label>
                  <label>模型 ID<input value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} placeholder="填写厂商提供的模型 ID" required maxLength={160} /></label>
                  <label className="admin-wide">服务地址<input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://..." type="url" /></label>
                  <label className="admin-wide">API Key<input value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} type="password" autoComplete="new-password" placeholder={form.id ? '留空表示保持原密钥' : '输入厂商 API Key'} /></label>
                </div>
                <label className="admin-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 启用此模型</label>
                <button className="admin-save" type="submit" disabled={busy}><Save size={17} />{busy ? '保存中…' : '保存模型'}</button>
              </form>
            </section>
            <section className="admin-panel admin-model-list">
              <div className="admin-panel-heading"><h2>已配置模型</h2><span>{models.length} 个</span></div>
              {models.length ? models.map((model) => (
                <article className="admin-model" key={model.id}>
                  <div className="admin-model-title"><strong>{model.name}</strong><span className={model.enabled && model.hasApiKey ? 'admin-ready' : 'admin-muted'}>{model.enabled ? model.hasApiKey ? '可用' : '待填密钥' : '已停用'}</span></div>
                  <p>{kindName[model.kind]} · {model.provider}</p>
                  <code>{model.modelId}</code>
                  <div className="admin-model-actions">
                    {model.kind === 'text' && model.enabled && model.hasApiKey ? <button type="button" disabled={busy || defaultTextModelId === model.id} onClick={() => void makeDefault(model)}>{defaultTextModelId === model.id ? '当前默认' : '设为默认'}</button> : null}
                    <button type="button" onClick={() => edit(model)}>编辑</button>
                    <button type="button" className="admin-delete" onClick={() => void remove(model)} aria-label={`删除 ${model.name}`}><Trash2 size={16} /></button>
                  </div>
                </article>
              )) : <div className="admin-empty"><Plus size={22} /><p>还没有模型配置</p></div>}
            </section>
          </div>
          </>}
        </main>
      )}
    </div>
  );
}
