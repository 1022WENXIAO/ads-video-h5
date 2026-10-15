import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { executionFailure, isTransientExecutionError, TextTransportError, type ExecutionFailure } from './executionErrors';

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

// Keep normal DNS resolution, dual-stack fallback and TLS verification. The
// Node 22 default (250ms) prematurely abandons reachable international IPv4
// routes before trying an unreachable IPv6 route on the production host.
setDefaultAutoSelectFamilyAttemptTimeout(integerSetting('QINGJIAN_CONNECT_ATTEMPT_TIMEOUT_MS', 1500, 250, 10000));

export const providerTransportSettings = () => ({
  connectAttemptTimeoutMs: getDefaultAutoSelectFamilyAttemptTimeout(),
  textMaxRetries: integerSetting('QINGJIAN_TEXT_MAX_RETRIES', 2, 0, 3),
});

export interface TransportDiagnostic {
  at: string;
  origin: string;
  path: string;
  attempts: number;
  durationMs: number;
  outcome: 'recovered' | 'failed';
  failure: ExecutionFailure;
  status?: number;
  requestId?: string;
  recoveryKind?: 'audio-rate-limit' | 'audio-connect-timeout' | 'audio-mixed';
  retryDelaysMs?: number[];
  queueWaitMs?: number;
}

function abort(signal?: AbortSignal | null) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
}

export async function transportDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  abort(signal);
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function retryDelay(response: Response | undefined, attempt: number): number | undefined {
  const value = response?.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    // A long rate-limit is reported rather than holding the task or retrying
    // before the provider's requested time.
    if (ms > 5000) return undefined;
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return Math.min(2000, 300 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.2);
}

export async function fetchWithTextRecovery(
  request: typeof fetch, input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1],
  publish: (diagnostic: TransportDiagnostic) => void,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  // Never replay an image, audio, video or other paid submission. Retrying a
  // model decision happens before response headers; stream/tool execution is
  // outside this loop, so completed tools and recorded usage cannot replay.
  const text = method === 'POST' && /\/(?:chat\/completions|responses)\/?$/.test(url.pathname);
  const replayable = !init?.body || typeof init.body === 'string';
  const maxRetries = text && replayable ? providerTransportSettings().textMaxRetries : 0;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const secrets = [...headers].filter(([name]) => /authorization|api.?key|token|secret/i.test(name)).flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, '')]);
  const started = Date.now();
  let lastFailure: unknown;
  const report = (attempts: number, outcome: TransportDiagnostic['outcome'], failure: unknown, response?: Response) => {
    const requestId = response?.headers.get('x-request-id') || response?.headers.get('x-tt-logid') || response?.headers.get('request-id');
    publish({
      at: new Date().toISOString(), origin: url.origin, path: url.pathname.slice(0, 200), attempts, durationMs: Date.now() - started,
      outcome, failure: executionFailure(failure, secrets), ...(response ? { status: response.status } : {}),
      ...(requestId ? { requestId: requestId.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160) } : {}),
    });
  };
  for (let attempt = 1; ; attempt++) {
    abort(signal);
    let response: Response;
    try { response = await request(input instanceof Request ? input.clone() : input, init); }
    catch (error) {
      abort(signal);
      lastFailure = error;
      const retryable = text && replayable && isTransientExecutionError(error);
      if (!retryable || attempt > maxRetries) {
        const failure = retryable ? new TextTransportError(attempt, error, secrets) : error;
        report(attempt, 'failed', failure);
        throw failure;
      }
      await transportDelay(retryDelay(undefined, attempt)!, signal);
      continue;
    }
    if (response.ok) {
      if (lastFailure) report(attempt, 'recovered', lastFailure, response);
      if (!text || !response.body) return response;
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
          } catch (error) {
            // Once headers arrived, the provider may have billed or emitted
            // useful content. Retain the cause but never replay this request.
            if (signal?.aborted) { controller.error(signal.reason ?? error); return; }
            const failure = new TextTransportError(attempt, error, secrets);
            report(attempt, 'failed', failure, response);
            controller.error(failure);
          }
        },
        async cancel(reason) { await reader.cancel(reason); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const failure = Object.assign(new Error(`模型服务 HTTP ${response.status}`), { status: response.status });
    const delay = retryDelay(response, attempt);
    const retryable = text && replayable && ![401, 403].includes(response.status)
      && response.headers.get('x-should-retry') !== 'false' && [408, 429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt > maxRetries || delay === undefined) {
      // Exhaustion is carried across SDK normalization, preventing an outer
      // workflow from multiplying retries by replaying this whole stage.
      if (retryable) {
        await response.body?.cancel();
        const exhausted = new TextTransportError(attempt, failure, secrets);
        report(attempt, 'failed', exhausted, response);
        throw exhausted;
      }
      report(attempt, 'failed', failure, response);
      return response;
    }
    lastFailure = failure;
    await response.body?.cancel();
    await transportDelay(delay, signal);
  }
}
