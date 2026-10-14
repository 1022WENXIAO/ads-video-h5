// SDKs often replace a socket/DNS error with "Connection error". Keep a small,
// credential-free diagnostic before that replacement, and use one classifier
// for recovery and operator traces.
export const TEXT_TRANSPORT_FINAL = 'TEXT_TRANSPORT_FINAL';

export interface ExecutionFailure {
  name: string;
  message: string;
  code?: string;
  status?: number;
  retryable: boolean;
  retryExhausted: boolean;
  causes?: ExecutionFailure[];
}

export function safeErrorText(value: unknown, secrets: string[] = []): string {
  let text = String(value);
  for (const secret of secrets) if (secret.length >= 6) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
      try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[url omitted]'; }
    })
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 600);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function errorParts(value: unknown, seen = new Set<unknown>(), depth = 0): Record<string, unknown>[] {
  if (depth > 4 || seen.has(value)) return [];
  seen.add(value);
  const error = record(value);
  return [error, ...errorParts(error.cause, seen, depth + 1),
    ...(Array.isArray(error.errors) ? error.errors.slice(0, 6).flatMap(child => errorParts(child, seen, depth + 1)) : [])];
}

export function isTransientExecutionError(value: unknown): boolean {
  const parts = errorParts(value);
  const text = typeof value === 'string' ? value : parts.map(p => [p.message, p.code, p.name].join(' ')).join(' ');
  const authStatus = /(?:^|\bHTTP\s*|\bstatus(?:\s+code)?\s*[:=]?\s*)(?:401|403)\b/i;
  // Authentication/configuration/cancellation never become retries because a
  // nested error or user-facing sentence happens to mention the network.
  if (parts.some(p => [401, 403].includes(Number(p.status)) || authStatus.test(String(p.message)) || p.retryable === false || p.name === 'CreditError' || p.name === 'JobCancelledError' || p.name === 'AbortError') || authStatus.test(text)) return false;
  return parts.some(p => p.retryable === true || Number(p.status) === 429 || Number(p.status) >= 500)
    || /(?:^|\bHTTP\s*|\bstatus(?:\s+code)?\s*[:=]?\s*)(?:408|429|5\d\d)\b|connection error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT)|timeout|timed out|temporarily unavailable|fetch failed|network|限流|服务繁忙|超时|网络|无法连接/i.test(text);
}

export function retryBudgetExhausted(value: unknown): boolean {
  return (typeof value === 'string' && value.includes(TEXT_TRANSPORT_FINAL))
    || errorParts(value).some(p => p.retryExhausted === true || String(p.message).includes(TEXT_TRANSPORT_FINAL));
}

export const canRetryWorkflowError = (value: unknown): boolean => !retryBudgetExhausted(value) && isTransientExecutionError(value);

// Output repair loops may change malformed JSON or time codes. Transport,
// authorization and cancellation are not malformed output and must not trigger
// more calls or recursive subdivision of the same audio.
export function blocksModelOutputRecovery(value: unknown): boolean {
  const parts = errorParts(value);
  return retryBudgetExhausted(value) || isTransientExecutionError(value)
    || parts.some(p => Number(p.status) >= 400 || ['CreditError', 'JobCancelledError', 'AbortError'].includes(String(p.name)))
    || /(?:^|\bHTTP\s*|\bstatus(?:\s+code)?\s*[:=]?\s*)[45]\d\d\b/i.test(typeof value === 'string' ? value : parts.map(p => p.message).join(' '));
}

export function executionFailure(value: unknown, secrets: string[] = [], depth = 0, seen = new Set<unknown>()): ExecutionFailure {
  const error = record(value);
  const children = [error.cause, ...(Array.isArray(error.errors) ? error.errors.slice(0, 6) : [])].filter(v => v !== undefined && !seen.has(v));
  seen.add(value);
  const status = Number(error.status);
  return {
    name: safeErrorText(error.name || 'Error', secrets),
    message: safeErrorText(error.message ?? value, secrets),
    ...(typeof error.code === 'string' ? { code: safeErrorText(error.code, secrets) } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    retryable: isTransientExecutionError(value), retryExhausted: retryBudgetExhausted(value),
    ...(depth < 3 && children.length ? { causes: children.map(v => executionFailure(v, secrets, depth + 1, seen)) } : {}),
  };
}

export class TextTransportError extends Error {
  readonly retryExhausted = true;
  readonly code = TEXT_TRANSPORT_FINAL;
  constructor(readonly attempts: number, cause: unknown, secrets: string[] = []) {
    super(`模型服务暂时不可用，已尝试 ${attempts} 次（${TEXT_TRANSPORT_FINAL}）：${safeErrorText(record(cause).message ?? cause, secrets)}`, { cause });
    this.name = 'TextTransportError';
  }
}
