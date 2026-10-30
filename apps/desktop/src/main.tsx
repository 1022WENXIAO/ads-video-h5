import React, { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { PublicUser } from '../../../shared/types';
import DesktopApp from './DesktopApp';
import { api } from './api';
import './workspace.css';
function DesktopAuth() {
  const [user, setUser] = useState<PublicUser | null>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{
      user: PublicUser;
    }>('/api/auth/me', 'GET', undefined, controller.signal)
      .then((result) => setUser(result.user))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          if (cause.status !== 401) setError('无法连接服务器，请重试。');
          setUser(null);
        }
      });
    return () => controller.abort();
  }, []);
  if (user)
    return (
      <DesktopApp
        user={user}
        logout={async () => {
          await api('/api/auth/logout', 'POST', {});
          setUser(null);
        }}
      />
    );
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{
        user: PublicUser;
      }>('/api/auth/login', 'POST', { email: data.get('email'), password: data.get('password') });
      setUser(result.user);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="desktop-login">
      <div className="desktop-wordmark">
        轻剪<span>桌面工作台</span>
      </div>
      {user === undefined ? (
        <p role="status">正在加载账号…</p>
      ) : (
        <form onSubmit={login}>
          <h1>继续你的创作</h1>
          <p>与移动端共用账号、会话和成片。</p>
          <label>
            邮箱
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error ? (
            <p role="alert" className="inline-error">
              {error}
            </p>
          ) : null}
          <button className="primary" disabled={busy}>
            {busy ? '正在登录…' : '登录工作台'}
          </button>
          <a href={apiUrlHome()}>前往轻剪移动版 / 注册账号</a>
        </form>
      )}
    </main>
  );
}
function apiUrlHome() {
  return import.meta.env.VITE_API_BASE_PATH || '/';
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopAuth />
  </React.StrictMode>,
);
