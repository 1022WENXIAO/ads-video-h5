import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { defaultAgentCapabilities } from '../shared/agentCapabilities';
import type { Job, Session, WorkflowEvent } from '../shared/types';
import { forkSession } from '../server/sessionFork';
import { createExtensions } from '../server/extensions';
import { McpClient, validateMcpUrl } from '../server/mcpClient';
import { withAgentRuntime } from '../server/agentRuntime';
import { getAgent } from '../server/core';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';
import { beginJobAttempt, finishJobAttempt } from '../server/jobAttempts';
import { createAntBrowserClient, antLocalUrl } from '../server/antBrowserClient';

const at = '2026-10-31T00:00:00.000Z';
const session = (): Session => ({
  id: 'original',
  ownerId: 'owner',
  title: '宣传视频',
  modelId: null,
  createdAt: at,
  updatedAt: at,
  plan: null,
  capabilities: defaultAgentCapabilities(),
  messages: [
    { id: 'm1', role: 'user', text: '第一版', createdAt: at, jobId: 'j1' },
    { id: 'm2', role: 'assistant', text: '已保存脚本', createdAt: at, jobId: 'j1' },
    { id: 'm3', role: 'user', text: '接着修改', createdAt: at, jobId: 'j2' },
  ],
});
const job = (id: string, status: Job['status'] = 'succeeded'): Job => ({
  id,
  ownerId: 'owner',
  sessionId: 'original',
  messageId: 'm1',
  kind: 'plan',
  status,
  createdAt: at,
  updatedAt: at,
});
const config = {
  ...TEXT_MODEL_PRESETS[0],
  kind: 'text' as const,
  provider: 'ark',
  baseUrl: ARK_BASE_URL,
  enabled: true,
  apiKey: 'fixture-model-key',
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function temporary(t: any) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qingjian-capabilities-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('fork copies only selected history, uses fresh message IDs and never mutates the original', () => {
  const source = session(),
    before = structuredClone(source);
  const fork = forkSession(source, [job('j1')], 'm2', at);
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.ownerId, 'owner');
  assert.deepEqual(
    fork.messages.map((m) => m.text),
    ['第一版', '已保存脚本'],
  );
  assert(fork.messages.every((m) => !m.jobId && !source.messages.some((original) => original.id === m.id)));
  fork.capabilities!.skillIds.push('custom');
  assert.deepEqual(source, before);
  assert.equal(fork.forkedFrom?.messageId, 'm2');
  assert.throws(() => forkSession(source, [], 'other-owner-message'), /不存在/);
});
test('fork of an active conversation excludes unfinished work and cannot inherit a partial draft', () => {
  const source = session();
  source.lessonDraft = { title: '未完成' } as any;
  const fork = forkSession(source, [job('j2', 'running')]);
  assert.deepEqual(
    fork.messages.map((m) => m.text),
    ['第一版', '已保存脚本'],
  );
  assert.equal(fork.lessonDraft, undefined);
});
test('skills, declarative plugins and MCP secrets persist privately and remain owner-isolated', async (t) => {
  const dir = await temporary(t),
    store = createExtensions(dir);
  await store.load();
  const skill = await store.addSkill('owner', { name: '写作要求', content: '# 写作\n先给结论。' });
  const server = await store.addMcp('owner', {
    name: '查询服务',
    url: 'https://tools.example.test/mcp',
    token: 'private-mcp-key',
  });
  const plugin = await store.addPlugin('owner', {
    name: '研究插件',
    skills: [{ name: '引用规则', content: '# 引用\n优先一手来源。' }],
    mcpServers: [],
  });
  assert.doesNotMatch(JSON.stringify(store.catalog('owner')), /private-mcp-key|先给结论/);
  assert(!store.catalog('other').skills.some((s) => s.id === skill));
  assert.equal(store.catalog('other').mcps.length, 0);
  assert.throws(
    () => store.validate('other', { ...defaultAgentCapabilities(), skillIds: [skill] }),
    /不属于/,
  );
  assert.throws(
    () => store.validate('owner', { ...defaultAgentCapabilities(), browserProfile: 'guessed-profile' }),
    /不属于/,
  );
  const settings = store.validate('owner', {
    ...defaultAgentCapabilities(),
    skillIds: [skill],
    mcpIds: [server],
    pluginIds: [plugin],
  });
  const reloaded = createExtensions(dir);
  await reloaded.load();
  assert.deepEqual(reloaded.catalog('owner'), store.catalog('owner'));
  const runtime = await reloaded.runtime('owner', settings, async () => {});
  assert.match(runtime.instructions, /先给结论/);
  assert.match(runtime.instructions, /优先一手来源/);
  assert(runtime.tools.some((tool) => tool.name === 'read_mcp_tool'));
  assert.equal((await stat(path.join(dir, 'extensions.json'))).mode & 0o777, 0o600);
  await assert.rejects(
    store.addPlugin('owner', { name: '不可执行', hooks: ['shell'], skills: [] }),
    /不执行/,
  );
});
test('corrupt extension state fails closed and is not overwritten with an empty registry', async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, 'extensions.json');
  await writeFile(file, '{broken');
  const store = createExtensions(dir);
  await assert.rejects(store.load());
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('parallel limit applies across agents in the same job; legacy writes remain sequential', async () => {
  let live = 0,
    peak = 0;
  const tool: AgentTool = {
    name: 'read_fixture',
    label: '只读',
    description: 'read',
    parameters: Type.Object({}),
    executionMode: 'parallel',
    execute: async () => {
      live++;
      peak = Math.max(peak, live);
      await delay(20);
      live--;
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  };
  await withAgentRuntime(
    {
      settings: { ...defaultAgentCapabilities(), maxParallel: 2 },
      instructions: '测试上下文',
      tools: [tool],
    },
    async () => {
      const first = getAgent(config, [], 'test'),
        second = getAgent(config, [], 'test');
      assert.equal(first.toolExecution, 'parallel');
      assert.match(first.state.systemPrompt, /测试上下文/);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => (i % 2 ? first : second).state.tools[0].execute(String(i), {})),
      );
      assert.equal(peak, 2);
      const legacy = getAgent(config, [{ ...tool, name: 'write_fixture', executionMode: undefined }], 'test');
      assert.equal(legacy.state.tools[0].executionMode, 'sequential');
    },
  );
});
test('attempt histories freeze tool settings separately for each retry', () => {
  const item = { ...job('j'), capabilities: defaultAgentCapabilities() };
  item.status = 'running';
  const first = beginJobAttempt(item, 'release', at);
  item.status = 'failed';
  finishJobAttempt(item, at);
  item.capabilities = { ...defaultAgentCapabilities(), maxParallel: 5 };
  const second = beginJobAttempt(item, 'next-release', at);
  assert.equal(first.capabilities?.maxParallel, 3);
  assert.equal(second.capabilities?.maxParallel, 5);
});

async function mcpFixture(t: any, sse = false) {
  const old = process.env.QINGJIAN_LOCAL_MCP;
  process.env.QINGJIAN_LOCAL_MCP = '1';
  t.after(() => {
    if (old === undefined) delete process.env.QINGJIAN_LOCAL_MCP;
    else process.env.QINGJIAN_LOCAL_MCP = old;
  });
  let calls = 0,
    live = 0,
    peak = 0;
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const value = JSON.parse(raw);
    methods.push(value.method);
    assert.equal(request.headers.authorization, 'Bearer fixture-mcp-secret');
    if (value.method !== 'initialize') {
      assert.equal(request.headers['mcp-session-id'], 'fixture-session');
      assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
    }
    if (value.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    let result: any;
    if (value.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'fixture-session');
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    } else if (value.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'read',
            description: '查询',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          { name: 'write', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
        ],
      };
    else {
      calls++;
      if (value.params.arguments.fail) {
        response.writeHead(503).end();
        return;
      }
      live++;
      peak = Math.max(peak, live);
      await delay(30);
      live--;
      result = { content: [{ type: 'text', text: 'fixture result' }] };
    }
    const message = JSON.stringify({ jsonrpc: '2.0', id: value.id, result });
    if (sse) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(': comment\r');
      await delay(1);
      response.write('\n\r');
      await delay(1);
      response.end('\ndata: ' + message + '\r\n\r\n');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    calls: () => calls,
    peak: () => peak,
    methods,
  };
}
for (const sse of [false, true])
  test(`MCP ${sse ? 'SSE' : 'JSON'} negotiates sessions and executes real parallel reads without replaying writes`, async (t) => {
    const fixture = await mcpFixture(t, sse);
    const client = new McpClient({
      id: 'mcp',
      name: 'fixture',
      url: fixture.url,
      token: 'fixture-mcp-secret',
    });
    await Promise.all([client.call('read', {}, true), client.call('read', {}, true)]);
    assert.equal(fixture.peak(), 2);
    assert.equal(fixture.methods.filter((m) => m === 'initialize').length, 1);
    await assert.rejects(client.call('write', {}, true), /未声明只读/);
    assert.equal(fixture.calls(), 2);
    await assert.rejects(client.call('write', { fail: true }), /HTTP 503/);
    assert.equal(fixture.calls(), 3);
    await client.close();
  });
test('MCP runtime tools are discovered, invoked and traced through the actual agent wrapper', async (t) => {
  const fixture = await mcpFixture(t),
    dir = await temporary(t),
    store = createExtensions(dir);
  await store.load();
  const id = await store.addMcp('owner', { name: '服务', url: fixture.url, token: 'fixture-mcp-secret' });
  let events: WorkflowEvent[] = [];
  const runtime = await store.runtime(
    'owner',
    { ...defaultAgentCapabilities(), mcpIds: [id] },
    async (rows) => {
      events = structuredClone(rows);
    },
  );
  await withAgentRuntime(runtime, async () => {
    const agent = getAgent(config, [], 'test');
    const discover = agent.state.tools.find((tool) => tool.name === 'discover_mcp_tools')!;
    await discover.execute('discover', {});
    const read = agent.state.tools.find((tool) => tool.name === 'read_mcp_tool')!;
    await Promise.all(
      [1, 2].map((index) =>
        read.execute('read-' + index, {
          serverId: id,
          name: 'read',
          arguments: { query: 'fixture-mcp-secret' },
        }),
      ),
    );
  });
  assert.equal(fixture.peak(), 2);
  assert.equal(events.filter((e) => e.status === 'succeeded').length, 3);
  assert.doesNotMatch(JSON.stringify(events), /fixture-mcp-secret/);
});
test('MCP endpoint validation and Ant endpoint validation reject credential or host escapes', () => {
  assert.throws(() => validateMcpUrl('https://unapproved.example/mcp', 'approved.example'), /允许/);
  assert.throws(() => validateMcpUrl('https://name:secret@approved.example/mcp', 'approved.example'), /允许/);
  assert.throws(() => antLocalUrl('http://remote.example:19876'), /本机/);
  assert.throws(() => antLocalUrl('http://127.0.0.1:19876?key=secret'), /本机/);
});
test('Ant-Browser adapter uses the documented API key and profile envelope', async (t) => {
  const requests: any[] = [];
  let active=0,peak=0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    requests.push({ url: request.url, body: raw ? JSON.parse(raw) : undefined });
    assert.equal(request.headers['x-ant-api-key'], 'ant-fixture-secret');
    if(request.url==='/api/runtime/status'){active++;peak=Math.max(peak,active);await delay(15);active--;}
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/api/profiles' && request.method === 'GET'
          ? { ok: true, items: [{ profileId: 'p1', profileName: '测试实例', launchCode: 'QJ_owner' }] }
          : { ok: true, running: false },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const ant = createAntBrowserClient(
    `http://127.0.0.1:${(server.address() as any).port}`,
    'ant-fixture-secret',
  );
  await ant.health();
  const profiles = (await ant.execute({ operation: 'profiles', profile: '', args: {} })) as any;
  assert.equal(profiles.profiles[0].code, 'QJ_owner');
  await ant.createProfile('QJ_owner', '测试实例');
  assert.deepEqual(requests.at(-1).body, {
    profile: { profileName: '测试实例' },
    launchCode: 'QJ_owner',
    autoLaunch: false,
  });
  await ant.execute({ operation: 'status', profile: 'QJ_owner', args: {} });
  assert.deepEqual(requests.at(-1).body.selector, { code: 'QJ_owner', matchMode: 'unique' });
  await Promise.all(Array.from({length:3},()=>ant.execute({operation:'status',profile:'QJ_owner',args:{}})));
  assert.equal(peak,1,'Ant commands from multiple agents must remain ordered');
});
