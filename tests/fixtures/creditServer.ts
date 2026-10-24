import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../server/auth';
import { defaultTokenPrices } from '../../server/tokenPricing';
import { disposeOwnedFixture, waitForOwnedFixtureReady } from './ownedProcess';

// Real Express/queue/Pi transport, disposable local users and a controllable
// token provider. No production credentials or external services are used.
export async function startCreditServer(options: { wechat?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qj-credit-service-'));
  const password = 'Credit-QA-user-123', adminPassword = 'Credit-QA-admin-123';
  const providerState = { calls: 0, outputTokens: 100, delay: 0, multiTurn: false, fail: false, wechatCalls: 0 };
  const provider = createServer(async (request, response) => {
    if (options.wechat && request.url?.startsWith('/wechat-session?')) {
      providerState.wechatCalls++;
      const query = new URL(request.url, 'http://fixture.test').searchParams;
      const who = /^(alice|bob)-[A-Za-z0-9_-]+$/.exec(query.get('js_code') || '')?.[1];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(who && query.get('appid') === 'wxf5dfb5d144bcd684' && query.get('secret') === 'fixture-wechat-secret'
        ? { openid: 'fixture-openid-' + who, session_key: 'fixture-session-key-must-not-persist', unionid: 'fixture-unionid' }
        : { errcode: 40029, errmsg: 'invalid fixture code' }));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); const id = 'fixture-' + (++providerState.calls);
    if (providerState.fail) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"fixture failure"}}'); return; }
    if (providerState.delay) await new Promise(r => setTimeout(r, providerState.delay));
    if (response.destroyed) return;
    const audioRequest = body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'input_audio'));
    const usage = { prompt_tokens: 1000, completion_tokens: providerState.outputTokens, prompt_tokens_details: { cached_tokens: 500, ...(audioRequest ? { audio_tokens: 1000, audio_cached_tokens: 500 } : {}) } };
    if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id, usage, choices: [{ message: { content: '{"text":"用一句话介绍功能"}' } }] })); return; }
    const reply = !providerState.multiTurn || body.messages.some((m: any) => m.role === 'assistant');
    const delta = reply ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name: 'reply', arguments: JSON.stringify({ sections: [], summary: '测试任务已完成。' }) } }] } : { role: 'assistant', content: '继续完成指令。' };
    const base = { id, object: 'chat.completion.chunk', model: body.model, created: 1 };
    const chunks = [{ ...base, choices: [{ index: 0, delta, finish_reason: null }] }, { ...base, usage, choices: [{ index: 0, delta: {}, finish_reason: reply ? 'tool_calls' : 'stop' }] }];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  let child: ChildProcess | undefined, closing: Promise<void> | undefined;
  const close = () => closing ||= disposeOwnedFixture(child, provider, directory);
  try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const modelToken = randomBytes(32).toString('hex');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(`qingjian-model-registry:${modelToken}`).digest(), iv);
  const encrypted = Buffer.concat([cipher.update('fixture-key'), cipher.final()]);
  const apiKeyCiphertext = [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64url')).join('.');
  const users = [{ id: 'ordinary', email: 'ordinary@example.test', displayName: '普通用户' }, { id: 'special', email: 'shikanon@example.test', displayName: 'shikanon' }];
  const passwordHash = await hashPassword(password), createdAt = new Date().toISOString();
  // Pre-seeded verification exercises real registration without sending email.
  const registrationEmail = 'new@example.test', verificationCode = '123456', verificationSalt = randomBytes(16).toString('hex');
  const verification = { email: registrationEmail, salt: verificationSalt, hash: scryptSync(verificationCode, Buffer.from(verificationSalt, 'hex'), 32).toString('hex'), sentAt: Date.now(), expiresAt: Date.now() + 10 * 60_000, attempts: 0 };
  const models = [{ id: 'text', name: 'QA text', kind: 'text', provider: 'ark', modelId: defaultTokenPrices()[0].modelId, baseUrl: providerBase, apiKeyCiphertext, enabled: true }, { id: 'understanding', name: 'QA ASR', kind: 'understanding', provider: 'ark', modelId: defaultTokenPrices()[3].modelId, baseUrl: providerBase, apiKeyCiphertext, enabled: true }];
  const session = { id: 'ordinary-session', ownerId: 'ordinary', title: '新会话', modelId: 'text', createdAt, updatedAt: createdAt, messages: [{ id: 'failed-message', role: 'user', text: '你好', attachmentIds: [], jobId: 'failed-job', createdAt }], plan: null };
  const seeded = { sessions: [session], activeSessionId: session.id, media: [{ id: 'video-fixture', ownerId: 'ordinary', name: '视频', kind: 'video', mimeType: 'video/mp4', url: '/api/media/video-fixture', createdAt }, { id: 'avatar-fixture', ownerId: 'ordinary', name: '作者', kind: 'image', mimeType: 'image/png', url: '/api/media/avatar-fixture', createdAt, character: { role: 'reference' } }], artifacts: [], jobs: [{ id: 'failed-job', ownerId: 'ordinary', sessionId: session.id, messageId: 'failed-message', kind: 'chat', status: 'failed', createdAt, updatedAt: createdAt }], settings: { language: 'zh-CN', chatBackground: null }, profiles: { ordinary: { activeSessionId: session.id, settings: { language: 'zh-CN', chatBackground: null, defaultModelId: 'text' } } }, artifactFiles: {}, narrationBySession: {}, bgmBySession: {} };
  await Promise.all([
    writeFile(path.join(directory, 'admin-token'), modelToken, { mode: 0o600 }),
    writeFile(path.join(directory, 'provider-models.json'), JSON.stringify({ version: 1, textModelPresetsVersion: 1, defaultTextModelId: 'text', models }), { mode: 0o600 }),
    writeFile(path.join(directory, 'auth.json'), JSON.stringify({ users: users.map(u => ({ ...u, passwordHash, createdAt })), sessions: [], verifications: [verification] }), { mode: 0o600 }),
    writeFile(path.join(directory, 'app-state.json'), JSON.stringify(seeded), { mode: 0o600 }),
  ]);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(r => reserve.close(() => r()));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const imports = options.wechat ? ['--import', './tests/fixtures/wechatFetch.ts'] : [];
  child = spawn(process.execPath, ['--import', 'tsx', ...imports, 'server/index.ts'], { cwd: root, env: { ...process.env, QINGJIAN_DATA_DIR: directory, PORT: String(port), PUBLIC_BASE_PATH: '', QINGJIAN_ADMIN_PASSWORD: adminPassword,
    ...(options.wechat ? { QINGJIAN_TEST_WECHAT_PROVIDER: providerBase, QINGJIAN_WECHAT_APP_ID: 'wxf5dfb5d144bcd684', QINGJIAN_WECHAT_APP_SECRET: 'fixture-wechat-secret' } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError: Error | undefined, spawned = false;
  const startupStarted = Date.now();
  child.once('spawn', () => { spawned = true; });
  child.once('error', error => { spawnError = error; });
  let logs = ''; child.stdout!.on('data', bytes => { logs += bytes; }); child.stderr!.on('data', bytes => { logs += bytes; });
  const base = `http://127.0.0.1:${port}`;
  const ready = await waitForOwnedFixtureReady(async signal => {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('QA server failed: ' + (spawnError?.message || logs));
    try { return (await fetch(base + '/api/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })).ok; } catch { return false; }
  });
  if (!ready) throw new Error(`QA server did not start: ${JSON.stringify({ spawned, elapsedMs: Date.now() - startupStarted, exitCode: child.exitCode, signalCode: child.signalCode })}; output: ${logs || '(no startup stdout/stderr)'}`);
  async function login(email = users[0].email) {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Fixture login failed');
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  const request = (cookie: string, route: string, body?: unknown, method = body ? 'POST' : 'GET') => fetch(base + route, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  return { base, directory, child, providerState, password, adminPassword, registrationEmail, verificationCode, login, request, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture startup and cleanup failed.'); }
    throw error;
  }
}
