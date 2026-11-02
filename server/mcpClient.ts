import {currentTaskExecution} from './taskRuntime';
import {stateHash} from './durableState';
import { randomUUID } from 'node:crypto';
import { currentJobSignal } from './jobExecution';
export interface McpConnection {
  id: string;
  name: string;
  url: string;
  token?: string;
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}
export function validateMcpUrl(value: string, allowed = process.env.QINGJIAN_MCP_ALLOWED_HOSTS || '') {
  const url = new URL(value);
  const hosts = allowed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const local =
    ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && process.env.QINGJIAN_LOCAL_MCP === '1';
  if (
    url.username ||
    url.search ||
    url.password ||
    url.hash ||
    !((local && url.protocol === 'http:') || (url.protocol === 'https:' && hosts.includes(url.host)))
  )
    throw new Error('MCP 地址须为服务器允许的 HTTPS 域名；本地 MCP 需启用 QINGJIAN_LOCAL_MCP。');
  return url.toString();
}
export class McpClient {
  private session?: string;
  private protocol = '2025-06-18';
  private ready?: Promise<void>;
  constructor(private connection: McpConnection) {}
  private async rpc(method: string, params?: unknown, notification = false) {
    const url = validateMcpUrl(this.connection.url);
    const id = notification ? undefined : randomUUID();
    const signal = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(currentJobSignal() ? [currentJobSignal()!] : []),
    ]);
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
        ...(method !== 'initialize' ? { 'MCP-Protocol-Version': this.protocol } : {}),
        ...(this.connection.token ? { Authorization: `Bearer ${this.connection.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(id ? { id } : {}),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`MCP ${this.connection.name} 返回 HTTP ${response.status}；未自动重放工具调用。`);
    }
    if (method === 'initialize') this.session = response.headers.get('mcp-session-id') || undefined;
    if (notification) {
      await response.body?.cancel();
      return;
    }
    let result: any;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '',
        bytes = 0;
      try {
        outer: while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2000000) throw new Error('MCP 响应超过大小限制。');
          buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const candidate = JSON.parse(data);
            if (candidate.id === id) {
              result = candidate;
              break outer;
            }
          }
        }
      } finally {
        await reader.cancel();
      }
    } else {
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 2000000) throw new Error('MCP 响应超过大小限制。');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    if (!result || result.id !== id || result.error)
      throw new Error(`MCP ${this.connection.name} 未返回匹配的成功结果。`);
    return result.result;
  }
  private initialize() {
    return (this.ready ??= this.rpc('initialize', {
      protocolVersion: this.protocol,
      capabilities: {},
      clientInfo: { name: 'qingjian', version: '1.0' },
    }).then(async (result) => {
      if (!['2025-06-18', '2025-03-26', '2024-11-05'].includes(result?.protocolVersion))
        throw new Error('MCP 协议版本不兼容。');
      this.protocol = result.protocolVersion;
      await this.rpc('notifications/initialized', undefined, true);
    }));
  }
  private catalogHash?:string;
  async list(): Promise<McpTool[]> {
    await this.initialize();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new Error('MCP 工具列表无效。');
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (tools.length > 200) throw new Error('MCP 工具数量超过限制。');
    } while (cursor);
    const fingerprint=stateHash([...tools].sort((a,b)=>a.name.localeCompare(b.name)));if(this.catalogHash&&this.catalogHash!==fingerprint)throw Error('MCP工具定义在运行期间变化，已停止调用；请重新发现能力并启动新任务。');this.catalogHash=fingerprint;await currentTaskExecution()?.observeDependency('mcp-catalog:'+this.connection.id,tools.map(t=>({name:t.name,inputSchema:t.inputSchema,annotations:t.annotations})).sort((a,b)=>a.name.localeCompare(b.name)));return tools;
  }
  async call(name: string, args: Record<string, unknown>, readOnly = false) {
    const tool = (await this.list()).find((item) => item.name === name);
    if (!tool) throw new Error('MCP 工具不存在，请先发现可用工具。');
    if (readOnly && (tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true))
      throw new Error('此工具未声明只读，须使用顺序调用入口。');
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error('MCP 工具执行失败，请查看连接器状态或调整参数；未自动重放。');
    return result;
  }
  async close() {
    if (!this.session) return;
    const session = this.session;
    this.session = undefined;
    try {
      const response = await fetch(validateMcpUrl(this.connection.url), {
        method: 'DELETE',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: {
          'Mcp-Session-Id': session,
          'MCP-Protocol-Version': this.protocol,
          ...(this.connection.token ? { Authorization: `Bearer ${this.connection.token}` } : {}),
        },
      });
      await response.body?.cancel();
    } catch {
      /* Cleanup does not replace the execution outcome. */
    }
  }
}
