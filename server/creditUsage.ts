import {currentTaskExecution} from './taskRuntime';
import {tokenCostMicros} from './tokenPricing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Credits } from './credits';
import type { TokenUsage } from '../shared/creditTypes';
import { tokenUsage } from './tokenPricing';

interface Context { credits: Credits; userId: string; taskId: string; }
const context = new AsyncLocalStorage<Context>();
export const withCreditUsage = <T>(credits: Credits, userId: string, taskId: string, action: () => Promise<T>) => context.run({ credits, userId, taskId }, action);

// All token providers pass through jobFetch, including Pi's streaming transport.
// Inspect only model response metadata; prompts, media and credentials never
// enter the ledger. Each request freezes its price before going upstream.
export const creditFetch: typeof fetch = async (input, init) => {
  const owner = context.getStore();
  if (!owner) return fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!/\/(?:chat\/completions|responses)\/?$/.test(url.pathname) || (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'POST') return fetch(input, init);
  const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (typeof rawBody !== 'string') throw new Error('模型计费无法读取请求。');
  const payload = JSON.parse(rawBody) as { model?: unknown; messages?: Array<{ content?: unknown }> };
  if (typeof payload.model !== 'string') throw new Error('模型计费缺少模型 ID。');
  const modelId = payload.model, price = await owner.credits.price(modelId);
  const hasAudio = payload.messages?.some(m => Array.isArray(m.content) && m.content.some(v => v?.type === 'input_audio')) ?? false;
  const task=currentTaskExecution();await task?.assertModelBudget();
  const response = await fetch(input, init);
  if (!response.body) return response;
  const sse = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  let usage: TokenUsage | undefined, requestId = randomUUID() as string, detail: string | undefined;
  let recorded: Promise<void> | undefined;
  let buffer = '', oversize = false, ended = false;
  const decoder = new TextDecoder(), reader = response.body.getReader();
  const capture = (value: any) => {
    const record = value?.response ?? value;
    if (typeof record?.id === 'string' && record.id.length <= 200) requestId = record.id;
    if (record?.usage) {
      const parsed = tokenUsage(record.usage);
      const details = record.usage.prompt_tokens_details ?? record.usage.input_tokens_details;
      if (hasAudio && (typeof details?.audio_tokens !== 'number' || (parsed?.cachedInput ?? 0) > 0 && typeof details?.audio_cached_tokens !== 'number')) {
        usage = undefined; detail = '音频请求缺少音频 token 明细，待供应商核对';
      } else { usage = parsed; detail = parsed ? undefined : '供应商返回的 token 明细无效，待核对'; }
    }
  };
  const finish = () => recorded ??= response.ok || usage ? owner.credits.recordUsage(owner.userId, owner.taskId, modelId, requestId, usage, price, detail).then(()=>task?.recordCost(modelId+':'+requestId,usage?tokenCostMicros(usage,price):undefined)) : Promise.resolve();
  const frame = (text: string) => {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data.trim() === '[DONE]') { ended = true; return; }
    if (data) { try { capture(JSON.parse(data)); } catch { /* Non-JSON keep-alive frames carry no usage. */ } }
  };
  const consume = (text: string, final = false) => {
    if (oversize) return;
    buffer += text;
    if (sse) {
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        frame(buffer.slice(0, match.index)); buffer = buffer.slice(match.index! + match[0].length);
      }
      if (final && buffer.trim()) { frame(buffer); buffer = ''; }
    } else if (final) { try { capture(JSON.parse(buffer)); } catch { detail = '供应商响应无法解析，待核对用量'; } buffer = ''; }
    if (buffer.length > 8 * 1024 * 1024) { buffer = ''; oversize = true; detail = '供应商响应超出用量解析上限，待核对'; }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        consume(decoder.decode(chunk.value, { stream: !chunk.done }), chunk.done);
        if (chunk.done || ended) await finish();
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value!);
      } catch (error) {
        try { await finish(); } catch (ledgerError) { controller.error(ledgerError); return; }
        controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(); } },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
