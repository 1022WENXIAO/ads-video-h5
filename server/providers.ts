import { jobFetch, throwIfJobCancelled } from './jobExecution';
import { randomUUID } from 'node:crypto';
import type { ModelConfig } from './modelRegistry';
import { markAudioRateLimitRefusal, recoverAudioRequest, type AudioRecovery } from './audioRateLimit';

const IMAGE_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const AUDIO_URL = 'https://openspeech.bytedance.com/api/v3/tts/create';
const IMAGE_LIMIT = 48 * 1024 * 1024;
const AUDIO_LIMIT = 32 * 1024 * 1024;
const JSON_LIMIT = 68 * 1024 * 1024;

export type GeneratedMedia = { bytes: Buffer; mimeType: string; durationSec?: number; audioRecovery?:AudioRecovery };
export type ImageReference = { bytes: Buffer; mimeType: string };

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

function endpoint(config: ModelConfig, expected: string): string {
  // These clients use vendor-specific wire formats. A saved URL must not turn a
  // generation request (and its credential) into an arbitrary outbound request.
  const expectedUrl = new URL(expected);
  let candidate: URL;
  try {
    candidate = new URL(config.baseUrl || expected);
  } catch {
    throw new ProviderError('模型服务地址无效。', 'INVALID_CONFIG');
  }
  if (candidate.protocol !== 'https:' || candidate.host !== expectedUrl.host ||
      candidate.username || candidate.password || candidate.search || candidate.hash ||
      !['/', '/api/v3', expectedUrl.pathname].includes(candidate.pathname.replace(/\/$/, '') || '/')) {
    throw new ProviderError('此模型只能使用官方 HTTPS 接口地址。', 'INVALID_CONFIG');
  }
  return expected;
}

function ensureConfig(config: ModelConfig, kind: 'image' | 'audio'): void {
  if (!config.enabled || config.kind !== kind || !config.modelId?.trim() || !config.apiKey?.trim()) {
    throw new ProviderError(`请先在管理后台配置并启用${kind === 'image' ? '图片' : '音频'}模型。`, 'INVALID_CONFIG');
  }
  if (kind === 'image' && !config.modelId.startsWith('doubao-seedream-')) {
    throw new ProviderError('图片模型与方舟图片生成协议不匹配。', 'INVALID_CONFIG');
  }
  if (kind === 'audio' && config.modelId !== 'seed-audio-1.0') {
    throw new ProviderError('音频模型与豆包音频生成协议不匹配。', 'INVALID_CONFIG');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ProviderError('模型返回的文件超过大小限制。', 'RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new ProviderError('模型返回了空文件。', 'INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProviderError('模型返回的文件超过大小限制。', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function postJson(url: string, key: string, body: object, kind: 'image' | 'audio', requestId?:string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await jobFetch(url, {
      method: 'POST',
      redirect: 'error',
      // Reference-image inference can exceed two minutes. Jobs remain async,
      // so allow the same five-minute window used by the vendor audio example.
      signal: AbortSignal.timeout(300_000),
      headers: {
        'Content-Type': 'application/json',
        ...(kind === 'image' ? { Authorization: `Bearer ${key}` } : { 'X-Api-Key': key, 'X-Api-Request-Id': requestId||randomUUID() }),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throwIfJobCancelled();
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ProviderError('模型请求超时，请稍后重试。', 'TIMEOUT', undefined, true);
    }
    throw new ProviderError('无法连接模型服务，请稍后重试。', 'NETWORK_ERROR', undefined, true);
  }
  const raw = await readLimited(response, JSON_LIMIT);
  let result: Record<string, unknown> | null = null;
  try { result = asRecord(JSON.parse(raw.toString('utf8'))); } catch { /* handled below */ }
  if (!response.ok) {
    const error = asRecord(result?.error);
    const rawCode = typeof error?.code === 'string' ? error.code : typeof result?.code === 'string' ? result.code : 'UPSTREAM_ERROR';
    const code = rawCode.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'UPSTREAM_ERROR';
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const failure=new ProviderError(`模型服务请求失败（HTTP ${response.status}，${code}）。`, code, response.status, retryable);
    if(kind==='audio')markAudioRateLimitRefusal(failure,response,result);
    throw failure;
  }
  if (!result) throw new ProviderError('模型返回了无法解析的数据。', 'INVALID_RESPONSE', response.status);
  if (typeof result.code === 'number' && result.code !== 0) {
    throw new ProviderError(`模型服务返回错误码 ${result.code}。`, String(result.code), response.status);
  }
  return result;
}

function decodeBase64(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(limit * 4 / 3) + 8) {
    throw new ProviderError('模型未返回有效的媒体数据。', 'INVALID_RESPONSE');
  }
  const input = value.replace(/^data:[^,]+,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 === 1) {
    throw new ProviderError('模型返回的媒体编码无效。', 'INVALID_RESPONSE');
  }
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length === 0 || bytes.length > limit) {
    throw new ProviderError('模型返回的文件为空或过大。', 'INVALID_RESPONSE');
  }
  return bytes;
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function audioMime(bytes: Buffer): string | null {
  if (bytes.length < 256) return null;
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  return null;
}

function safeVendorMediaUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new ProviderError('模型未返回有效的音频。', 'INVALID_RESPONSE');
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('模型返回的音频链接无效。', 'INVALID_RESPONSE'); }
  const host = url.hostname.toLowerCase();
  const allowed = ['volces.com', 'volcengine.com', 'bytedance.com', 'byteimg.com'];
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new ProviderError('模型返回的音频链接不在允许的服务域名内。', 'INVALID_RESPONSE');
  }
  return url;
}

async function downloadVendorAudio(value: unknown): Promise<Buffer> {
  const url = safeVendorMediaUrl(value);
  let response: Response;
  try {
    response = await jobFetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new ProviderError('无法下载模型生成的音频。', 'DOWNLOAD_ERROR', undefined, true);
  }
  if (!response.ok) throw new ProviderError(`音频下载失败（HTTP ${response.status}）。`, 'DOWNLOAD_ERROR', response.status, response.status >= 500);
  const bytes = await readLimited(response, AUDIO_LIMIT);
  if (!audioMime(bytes)) throw new ProviderError('下载内容不是支持的音频格式。', 'INVALID_RESPONSE');
  return bytes;
}

export async function generateImage(prompt: string, config: ModelConfig, reference?: ImageReference, options?: { size?: string; outputFormat?: 'png' | 'jpeg'; background?: 'transparent' | 'opaque' }): Promise<GeneratedMedia> {
  ensureConfig(config, 'image');
  const url = endpoint(config, IMAGE_URL);
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt || cleanPrompt.length > 3000) throw new ProviderError('图片提示词应为 1 到 3000 个字符。', 'INVALID_INPUT');
  const body: Record<string, unknown> = {
    model: config.modelId,
    prompt: cleanPrompt,
    size: options?.size || '2K',
    response_format: 'b64_json',
    output_format: options?.outputFormat || 'jpeg',
    watermark: false,
  };
  if (options?.background) body.background = options.background;
  if (reference) {
    if (reference.bytes.length > 30 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(reference.mimeType) ||
        imageMime(reference.bytes) !== reference.mimeType) {
      throw new ProviderError('参考图片格式或大小不受支持。', 'INVALID_INPUT');
    }
    body.image = `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}`;
  }
  const result = await postJson(url, config.apiKey, body, 'image');
  const first = Array.isArray(result.data) ? asRecord(result.data[0]) : null;
  if (first?.error) throw new ProviderError('图片生成失败，请调整描述后重试。', 'UPSTREAM_ERROR');
  const bytes = decodeBase64(first?.b64_json, IMAGE_LIMIT);
  const mimeType = imageMime(bytes);
  if (!mimeType) throw new ProviderError('模型返回了不支持的图片格式。', 'INVALID_RESPONSE');
  return { bytes, mimeType };
}

export async function generateAudio(text: string, config: ModelConfig, reference?: Buffer): Promise<GeneratedMedia> {
  ensureConfig(config, 'audio');
  const url = endpoint(config, AUDIO_URL);
  const key = config.apiKey;
  const cleanText = text.trim();
  if (!cleanText || cleanText.length > 3000) throw new ProviderError('口播文本应为 1 到 3000 个字符。', 'INVALID_INPUT');
  if (reference && (!audioMime(reference) || reference.length > 10 * 1024 * 1024)) throw new ProviderError('声音参考须为有效音频且小于10MB。', 'INVALID_INPUT');
  const body = {
    model: config.modelId,
    text_prompt: cleanText,
    ...(reference ? { references: [{ audio_data: reference.toString('base64') }] } : {}),
    audio_config: { format: 'mp3', sample_rate: 48000 },
  };
  const {value:result,recovery}=await recoverAudioRequest(url,key,requestId=>postJson(url,key,body,'audio',requestId));
  const bytes = typeof result.audio === 'string' && result.audio.length
    ? decodeBase64(result.audio, AUDIO_LIMIT)
    : await downloadVendorAudio(result.url);
  const mimeType = audioMime(bytes);
  if (mimeType !== 'audio/mpeg') throw new ProviderError('模型返回了与请求不一致的音频格式。', 'INVALID_RESPONSE');
  const durationSec = typeof result.duration === 'number' && Number.isFinite(result.duration) && result.duration > 0
    ? result.duration : undefined;
  return { bytes, mimeType, durationSec, audioRecovery:recovery };
}
