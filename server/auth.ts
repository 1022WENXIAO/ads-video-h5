import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Express, NextFunction, Request, Response } from 'express';
import { sendRegistrationCode } from './resend';
import type { CreditWallet } from '../shared/creditTypes';
import { createWeChatExchange, WeChatLoginError, type WeChatIdentity } from './wechatAuth';
import { providerTransportSettings } from './providerTransport';
import { createLoginLimiter } from './loginRateLimit';

const scrypt = promisify(scryptCallback);
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const cookieName = 'qingjian_session';
const releaseRevision = readFile(new URL('../dist/release.json', import.meta.url), 'utf8').then((text) => {
  const revision: unknown = JSON.parse(text).revision;
  return typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision) ? revision : null;
}).catch(() => null);

export interface PublicUser { id: string; email: string; displayName: string; authProvider?: 'email' | 'wechat'; }
interface UserRecord extends PublicUser { passwordHash?: string; createdAt: string; wechat?: WeChatIdentity; }
interface LoginSession { userId: string; tokenHash: string; expiresAt: number; }
interface VerificationRecord { email: string; hash: string; salt: string; expiresAt: number; sentAt: number; attempts: number; }
interface AuthStore { users: UserRecord[]; sessions: LoginSession[]; verifications: VerificationRecord[]; }

const normalizeEmail = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const safeUser = ({ id, email, displayName, authProvider }: UserRecord): PublicUser => ({ id, email, displayName, authProvider: authProvider ?? 'email' });
const passwordValid = (value: unknown): value is string => typeof value === 'string' && value.length >= 10 && value.length <= 256;
const emailValid = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const codeHash = async (code: string, salt: string) => (await scrypt(code, Buffer.from(salt, 'hex'), 32) as Buffer).toString('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, Buffer.from(salt, 'hex'), 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createAuth(dataDir: string, publicBase: string, options: { exchangeWeChatCode?: (code: string) => Promise<WeChatIdentity> } = {}) {
  const filename = path.join(dataDir, 'auth.json');
  let store: AuthStore = { users: [], sessions: [], verifications: [] };
  let saveTail = Promise.resolve();
  const failures = new Map<string, { count: number; until: number }>();
  const admitLogin = createLoginLimiter();
  let invalidPasswordHash: Promise<string> | undefined;
  const sendLimits = new Map<string, { count: number; since: number }>();
  const sending = new Set<string>();
  const cookiePath = publicBase || '/';
  const exchangeWeChatCode = options.exchangeWeChatCode ?? createWeChatExchange();
  const claimedWeChatCodes = new Map<string, number>();

  async function load() {
    store = await readFile(filename, 'utf8').then((value) => JSON.parse(value) as AuthStore).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return { users: [], sessions: [], verifications: [] };
      throw error;
    });
    if (!Array.isArray(store.users) || !Array.isArray(store.sessions)) throw new Error('帐号数据格式无效。');
    store.verifications ||= [];
  }
  function save() {
    const snapshot = JSON.stringify(store, null, 2);
    saveTail = saveTail.catch(() => undefined).then(async () => {
      const temp = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, filename);
    });
    return saveTail;
  }
  function issueSession(response: Response, request: Request, userId: string) {
    const token = randomBytes(32).toString('base64url');
    store.sessions = store.sessions.filter((item) => item.expiresAt > Date.now());
    store.sessions.push({ userId, tokenHash: tokenHash(token), expiresAt: Date.now() + sessionLifetime });
    response.cookie(cookieName, token, { httpOnly: true, secure: request.secure, sameSite: 'lax', path: cookiePath, maxAge: sessionLifetime });
  }
  function currentUser(request: Request): PublicUser | null {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!cookie) return null;
    const session = store.sessions.find((item) => item.tokenHash === tokenHash(cookie) && item.expiresAt > Date.now());
    const user = store.users.find((item) => item.id === session?.userId);
    return user ? safeUser(user) : null;
  }
  function sameOrigin(request: Request): boolean {
    const origin = request.get('origin');
    if (!origin) return true;
    try {
      const source = new URL(origin);
      const host = request.get('host');
      return source.host === host && source.protocol === (request.secure ? 'https:' : 'http:');
    } catch { return false; }
  }
  function mutationGuard(request: Request, response: Response, next: NextFunction) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
      response.status(403).json({ error: '请求来源无效。' });
      return;
    }
    next();
  }
  function requireAuth(request: Request, response: Response, next: NextFunction) {
    const user = currentUser(request);
    if (!user) { response.status(401).json({ error: '请先登录轻剪帐号。' }); return; }
    (request as Request & { user: PublicUser }).user = user;
    next();
  }
  function rateKey(request: Request, email: string) { return `${request.ip}:${email}`; }
  function pruneFailures() { for (const [key, attempt] of failures) if (attempt.until <= Date.now()) failures.delete(key); }
  function isLimited(key: string) {
    pruneFailures();
    const attempt = failures.get(key);
    return Boolean(attempt && attempt.count >= 5) || !attempt && failures.size >= 10_000;
  }
  function failed(key: string) {
    pruneFailures();
    const previous = failures.get(key);
    if (!previous && failures.size >= 10_000) return;
    const count = previous && previous.until > Date.now() ? previous.count + 1 : 1;
    failures.set(key, { count, until: Date.now() + (count >= 5 ? Math.min(15 * 60_000, 30_000 * 2 ** Math.min(count - 5, 5)) : 60_000) });
  }
  function sendCount(key: string) {
    const limit = sendLimits.get(key);
    return limit && Date.now() - limit.since < 60 * 60_000 ? limit.count : 0;
  }
  function countSend(key: string) {
    const limit = sendLimits.get(key);
    sendLimits.set(key, limit && Date.now() - limit.since < 60 * 60_000 ? { ...limit, count: limit.count + 1 } : { count: 1, since: Date.now() });
  }
  async function sendCode(request: Request, response: Response) {
    const email = normalizeEmail(request.body?.email);
    if (!emailValid(email)) { response.status(400).json({ error: '请输入有效的邮箱地址。' }); return; }
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) { response.status(503).json({ error: '邮箱验证暂未配置，请稍后重试。' }); return; }
    if (store.users.some((user) => user.email === email)) { response.status(409).json({ error: '该邮箱已注册，请直接登录。' }); return; }
    const ipKey = `ip:${request.ip}`;
    const emailKey = `email:${email}`;
    const previous = store.verifications.find((item) => item.email === email);
    if (sending.has(email) || (previous && Date.now() - previous.sentAt < 60_000) || sendCount(ipKey) >= 8 || sendCount(emailKey) >= 4) {
      response.status(429).json({ error: '验证码发送过于频繁，请稍后再试。' }); return;
    }
    sending.add(email);
    try {
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const salt = randomBytes(16).toString('hex');
      const hash = await codeHash(code, salt);
      await sendRegistrationCode(email, code);
      store.verifications = store.verifications.filter((item) => item.email !== email && item.expiresAt > Date.now());
      store.verifications.push({ email, hash, salt, expiresAt: Date.now() + 10 * 60_000, sentAt: Date.now(), attempts: 0 });
      countSend(ipKey); countSend(emailKey);
      await save();
      response.json({ ok: true, expiresInSeconds: 600, resendAfterSeconds: 60 });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : '验证码发送失败，请稍后重试。' });
    } finally { sending.delete(email); }
  }
  async function register(request: Request, response: Response, registrationCredits?: (user: PublicUser) => Promise<CreditWallet>) {
    const email = normalizeEmail(request.body?.email);
    const displayName = typeof request.body?.displayName === 'string' ? request.body.displayName.trim().slice(0, 40) : '';
    const password = request.body?.password;
    const verificationCode = typeof request.body?.verificationCode === 'string' ? request.body.verificationCode.trim() : '';
    if (!emailValid(email) || !displayName || !passwordValid(password)) {
      response.status(400).json({ error: '请填写名称、有效邮箱和至少 10 位密码。' }); return;
    }
    if (!/^\d{6}$/.test(verificationCode)) { response.status(400).json({ error: '请输入邮件中的 6 位验证码。' }); return; }
    const key = rateKey(request, email);
    const ipKey = `register:${request.ip}`;
    if (isLimited(key)) { response.status(429).json({ error: '尝试过于频繁，请稍后再试。' }); return; }
    if (isLimited(ipKey)) { response.status(429).json({ error: '注册过于频繁，请稍后再试。' }); return; }
    if (store.users.some((user) => user.email === email)) { failed(key); response.status(409).json({ error: '该邮箱已注册，请直接登录。' }); return; }
    const verification = store.verifications.find((item) => item.email === email);
    if (!verification || verification.expiresAt <= Date.now() || verification.attempts >= 5) {
      response.status(400).json({ error: '验证码已失效，请重新获取。' }); return;
    }
    const expected = Buffer.from(verification.hash, 'hex');
    const actual = Buffer.from(await codeHash(verificationCode, verification.salt), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      verification.attempts++;
      failed(key);
      await save();
      response.status(400).json({ error: '验证码错误，请检查后重试。' }); return;
    }
    const passwordHash = await hashPassword(password);
    if (store.users.some((user) => user.email === email)) { response.status(409).json({ error: '该邮箱已注册，请直接登录。' }); return; }
    if (!store.verifications.includes(verification) || verification.expiresAt <= Date.now()) { response.status(400).json({ error: '验证码已失效，请重新获取。' }); return; }
    const user: UserRecord = { id: randomUUID(), email, displayName, passwordHash, createdAt: new Date().toISOString() };
    store.users.push(user);
    store.verifications = store.verifications.filter((item) => item.email !== email);
    failed(ipKey);
    issueSession(response, request, user.id);
    await save();
    const credits = await registrationCredits?.(safeUser(user));
    response.status(201).json({ user: safeUser(user), ...(credits ? { credits } : {}) });
  }
  async function login(request: Request, response: Response) {
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (!emailValid(email) || typeof password !== 'string' || password.length > 256) { response.status(400).json({ error: '请输入邮箱和密码。' }); return; }
    const key = rateKey(request, email);
    if (isLimited(key)) { response.status(429).json({ error: '尝试过于频繁，请稍后再试。' }); return; }
    const admission = admitLogin(request.ip || 'unknown');
    if (!admission.allowed) {
      response.set('Retry-After', String(admission.retryAfterSeconds)).status(429).json({ error: '登录请求过于频繁，请稍后再试。' });
      return;
    }
    try {
      const user = store.users.find((item) => item.email === email);
      const fallback = () => invalidPasswordHash ??= hashPassword(randomBytes(32).toString('base64url'));
      const valid = await verifyPassword(password, user?.passwordHash || await fallback());
      if (!user || !valid) { failed(key); response.status(401).json({ error: '邮箱或密码错误。' }); return; }
      failures.delete(key);
      issueSession(response, request, user.id);
      await save();
      response.json({ user: safeUser(user) });
    } finally { admission.release(); }
  }
  async function logout(request: Request, response: Response) {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (cookie) store.sessions = store.sessions.filter((item) => item.tokenHash !== tokenHash(cookie));
    response.clearCookie(cookieName, { httpOnly: true, secure: request.secure, sameSite: 'lax', path: cookiePath });
    await save();
    response.json({ ok: true });
  }
  async function changePassword(request: Request, response: Response) {
    const user = store.users.find((item) => item.id === userOf(request).id)!;
    if (user.authProvider === 'wechat' || !user.passwordHash) { response.status(403).json({ error: '微信账号使用微信登录，无需设置邮箱密码。' }); return; }
    const current = request.body?.currentPassword;
    const next = request.body?.newPassword;
    if (typeof current !== 'string' || !passwordValid(next)) { response.status(400).json({ error: '请输入当前密码和至少 10 位新密码。' }); return; }
    if (!(await verifyPassword(current, user.passwordHash))) { response.status(401).json({ error: '当前密码错误。' }); return; }
    user.passwordHash = await hashPassword(next);
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    store.sessions = store.sessions.filter((item) => item.userId !== user.id || item.tokenHash === tokenHash(cookie || ''));
    await save();
    response.json({ ok: true });
  }
  async function wechatLogin(request: Request, response: Response, registrationCredits?: (user: PublicUser) => Promise<CreditWallet>) {
    const code = request.body?.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) { response.status(400).json({ error: '请通过微信登录获取有效凭证。', code: 'WECHAT_CODE_INVALID' }); return; }
    const limitKey = `wechat:${request.ip}`;
    if (sendCount(limitKey) >= 60) { response.status(429).json({ error: '微信登录过于频繁，请稍后重试。', code: 'WECHAT_LOGIN_LIMITED' }); return; }
    countSend(limitKey);
    for (const [key, expires] of claimedWeChatCodes) if (expires <= Date.now()) claimedWeChatCodes.delete(key);
    const hash = tokenHash(code);
    if (claimedWeChatCodes.has(hash)) { response.status(400).json({ error: '微信登录凭证已使用，请重新点击微信登录。', code: 'WECHAT_CODE_INVALID' }); return; }
    if (claimedWeChatCodes.size >= 10_000) { response.status(429).json({ error: '微信登录繁忙，请稍后重试。', code: 'WECHAT_LOGIN_LIMITED' }); return; }
    claimedWeChatCodes.set(hash, Date.now() + 5 * 60_000);
    try {
      const identity = await exchangeWeChatCode(code);
      let user = store.users.find(item => item.authProvider === 'wechat' && item.wechat?.appId === identity.appId && item.wechat.openId === identity.openId);
      const created = !user;
      if (!user) {
        user = { id: randomUUID(), email: '', displayName: '微信创作者', authProvider: 'wechat', wechat: identity, createdAt: new Date().toISOString() };
        store.users.push(user);
      }
      // Persist identity before minting credits; an interrupted first login can
      // retry safely, and wallet creation is already an idempotent transaction.
      await save();
      const credits = await registrationCredits?.(safeUser(user));
      issueSession(response, request, user.id);
      await save();
      response.status(created ? 201 : 200).json({ user: safeUser(user), created, ...(credits ? { credits } : {}) });
    } catch (error) {
      if (!(error instanceof WeChatLoginError)) throw error;
      response.status(error.status).json({ error: error.message, code: error.code });
    }
  }
  async function wechatProfile(request: Request, response: Response) {
    const user = store.users.find(item => item.id === userOf(request).id)!;
    if (user.authProvider !== 'wechat') { response.status(403).json({ error: '请使用微信账号修改微信昵称。' }); return; }
    const displayName = typeof request.body?.displayName === 'string' ? request.body.displayName.trim() : '';
    if (!displayName || displayName.length > 40 || /[\u0000-\u001f\u007f]/.test(displayName)) { response.status(400).json({ error: '请填写 1 至 40 个字符的昵称。' }); return; }
    user.displayName = displayName;
    await save();
    response.json({ user: safeUser(user) });
  }
  function mount(app: Express, creditReadiness?: () => Promise<{ ready: boolean; initialSpecialAccountApplied: boolean }>, registrationCredits?: (user: PublicUser) => Promise<CreditWallet>) {
    app.get('/api/health', async (_request, response) => response.set('Cache-Control', 'no-store').json({ ok: true, revision: await releaseRevision, transport: providerTransportSettings(), ...(creditReadiness ? { credits: await creditReadiness() } : {}) }));
    app.get('/api/auth/me', (request, response) => { const user = currentUser(request); response.status(user ? 200 : 401).json(user ? { user } : { error: '未登录。' }); });
    app.post('/api/auth/send-code', mutationGuard, (request, response, next) => { void sendCode(request, response).catch(next); });
    app.post('/api/auth/register', mutationGuard, (request, response, next) => { void register(request, response, registrationCredits).catch(next); });
    app.post('/api/auth/login', mutationGuard, (request, response, next) => { void login(request, response).catch(next); });
    app.post('/api/auth/wechat/login', mutationGuard, (request, response, next) => { void wechatLogin(request, response, registrationCredits).catch(next); });
    app.patch('/api/auth/wechat/profile', mutationGuard, requireAuth, (request, response, next) => { void wechatProfile(request, response).catch(next); });
    app.post('/api/auth/logout', mutationGuard, (request, response, next) => { void logout(request, response).catch(next); });
    app.patch('/api/auth/password', mutationGuard, requireAuth, (request, response, next) => { void changePassword(request, response).catch(next); });
    app.use('/api', mutationGuard, requireAuth);
  }
  return { load, mount, currentUser, listUsers: () => store.users.map(safeUser) };
}

export function userOf(request: Request): PublicUser { return (request as Request & { user: PublicUser }).user; }
