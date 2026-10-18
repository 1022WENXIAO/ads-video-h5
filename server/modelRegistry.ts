import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelKind, PublicModel } from '../src/types';
import { frozenModel } from './modelContext';
import { ARK_BASE_URL as arkBaseUrl, TEXT_MODEL_PRESETS } from '../shared/textModels';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.QINGJIAN_DATA_DIR ? path.resolve(process.env.QINGJIAN_DATA_DIR) : path.join(root, 'data');
const registryFile = path.join(dataDir, 'provider-models.json');
const tokenFile = path.join(dataDir, 'admin-token');

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  kind: ModelKind;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

interface StoredModel extends Omit<ModelConfig, 'apiKey'> {
  apiKeyCiphertext?: string;
  apiKeySourceId?: string;
}

interface RegistryData {
  version: 1;
  defaultTextModelId: string | null;
  models: StoredModel[];
  textModelPresetsVersion?: 1;
}

export type AdminModel = Omit<ModelConfig, 'apiKey'> & { hasApiKey: boolean };

const initialRegistry = (): RegistryData => ({
  version: 1,
  defaultTextModelId: 'ark-text',
  textModelPresetsVersion: 1,
  models: [
    ...TEXT_MODEL_PRESETS.map((preset): StoredModel => ({ ...preset, provider: 'ark', kind: 'text', baseUrl: arkBaseUrl, enabled: true, ...(preset.id !== 'ark-text' ? { apiKeySourceId: 'ark-text' } : {}) })),
    { id: 'ark-understanding', name: 'Seed 2.1 Lite 音频理解', provider: 'ark', kind: 'understanding', modelId: 'doubao-seed-2-1-lite-260915', baseUrl: arkBaseUrl, enabled: true },
    { id: 'ark-image', name: '豆包 Seedream 5.0 Flash', provider: 'ark', kind: 'image', modelId: 'doubao-seedream-5-0-flash-260915', baseUrl: arkBaseUrl, enabled: true },
    { id: 'volc-audio', name: 'Seed Audio 1.0', provider: 'volcengine-voice', kind: 'audio', modelId: 'seed-audio-1.0', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/create', enabled: true },
  ],
});

let tokenPromise: Promise<string> | undefined;
let registryPromise: Promise<RegistryData> | undefined;
let mutationQueue = Promise.resolve();

async function getAdminToken(): Promise<string> {
  tokenPromise ??= (async () => {
    await mkdir(dataDir, { recursive: true });
    try {
      return (await readFile(tokenFile, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const token = process.env.QINGJIAN_ADMIN_TOKEN?.trim() || randomBytes(32).toString('hex');
      try {
        await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        return (await readFile(tokenFile, 'utf8')).trim();
      }
      await chmod(tokenFile, 0o600);
      return token;
    }
  })();
  return tokenPromise;
}

function keyFor(token: string): Buffer {
  return createHash('sha256').update(`qingjian-model-registry:${token}`).digest();
}

function encrypt(secret: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(token), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((value) => value.toString('base64url')).join('.');
}

function decrypt(value: string, token: string): string {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) throw new Error('模型密钥存储格式无效。');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(token), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function loadRegistry(): Promise<RegistryData> {
  registryPromise ??= (async () => {
    await mkdir(dataDir, { recursive: true });
    await getAdminToken();
    try {
      const loaded = JSON.parse(await readFile(registryFile, 'utf8')) as RegistryData;
      if (loaded.version !== 1 || !Array.isArray(loaded.models)) throw new Error('模型配置文件格式无效。');
      let changed = false;
      if (!loaded.models.some((model) => model.kind === 'understanding')) {
        const credentials = loaded.models.find((model) => model.provider === 'ark' && model.baseUrl.replace(/\/$/, '') === arkBaseUrl && model.enabled && model.apiKeyCiphertext);
        loaded.models.push({ ...initialRegistry().models.find((model) => model.kind === 'understanding')!, apiKeyCiphertext: credentials?.apiKeyCiphertext });
        changed = true;
      }
      if (loaded.textModelPresetsVersion !== 1) {
        const candidates = loaded.models.filter(model => model.kind === 'text' && model.provider === 'ark' && model.baseUrl.replace(/\/$/, '') === arkBaseUrl);
        const source = candidates.find(model => model.id === loaded.defaultTextModelId) || candidates.find(model => model.apiKeyCiphertext) || candidates[0];
        for (const preset of TEXT_MODEL_PRESETS) {
          if (loaded.models.some(model => model.kind === 'text' && model.modelId === preset.modelId)) continue;
          loaded.models.push({ ...preset, id: loaded.models.some(model => model.id === preset.id) ? randomUUID() : preset.id, provider: 'ark', kind: 'text', baseUrl: arkBaseUrl, enabled: true, ...(source ? { apiKeySourceId: source.id } : {}) });
        }
        loaded.textModelPresetsVersion = 1;
        changed = true;
      }
      if (changed) await persist(loaded);
      return loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial = initialRegistry();
      await persist(initial);
      return initial;
    }
  })();
  return registryPromise;
}

async function persist(data: RegistryData): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temp = `${registryFile}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, registryFile);
  await chmod(registryFile, 0o600);
}

async function mutate<T>(fn: (data: RegistryData, token: string) => Promise<T> | T): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const data = await loadRegistry();
    const result = await fn(data, await getAdminToken());
    await persist(data);
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function isAdminToken(value: string): Promise<boolean> {
  const expected = Buffer.from(await getAdminToken());
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function adminTokenLocation(): string {
  return tokenFile;
}

export async function listAdminModels(): Promise<AdminModel[]> {
  const data = await loadRegistry();
  return data.models.map((item) => {
    const { apiKeyCiphertext: _key, apiKeySourceId: _source, ...model } = item;
    return { ...model, hasApiKey: Boolean(modelKey(item, data)) };
  });
}

function modelKey(model: StoredModel, data: RegistryData): string | undefined {
  if (model.apiKeyCiphertext) return model.apiKeyCiphertext;
  const source = data.models.find(item => item.id === model.apiKeySourceId);
  // Inherited Ark credentials stay on the server and follow key rotation.
  if (model.kind === 'text' && source?.kind === 'text' && model.provider === source.provider && model.baseUrl.replace(/\/$/, '') === source.baseUrl.replace(/\/$/, '')) return source.apiKeyCiphertext;
  return undefined;
}

export async function listPublicModels(): Promise<PublicModel[]> {
  const data = await loadRegistry();
  return data.models.filter((item) => item.enabled && modelKey(item, data)).map(({ id, name, provider, modelId, kind, enabled }) => ({ id, name, provider, modelId, kind, enabled }));
}

export async function getModelConfig(kind: ModelKind, preferredId?: string | null): Promise<ModelConfig | null> {
  const pinned = frozenModel(kind, preferredId);
  if (pinned !== undefined) return pinned;
  const data = await loadRegistry();
  const id = preferredId || (kind === 'text' ? data.defaultTextModelId : null);
  const model = id ? data.models.find((item) => item.id === id && item.kind === kind) : data.models.find((item) => item.kind === kind && item.enabled && modelKey(item, data));
  const apiKeyCiphertext = model && modelKey(model, data);
  if (!model?.enabled || !apiKeyCiphertext) return null;
  const { apiKeyCiphertext: _key, apiKeySourceId: _source, ...publicFields } = model;
  return { ...publicFields, apiKey: decrypt(apiKeyCiphertext, await getAdminToken()) };
}

export async function getDefaultTextModelId(): Promise<string | null> {
  return (await loadRegistry()).defaultTextModelId;
}

/** Capture alternatives once, before a job starts; running jobs never follow
 * later registry edits or obtain a newly configured credential. */
export async function getTextFallbackConfigs(primary:ModelConfig|null):Promise<ModelConfig[]>{
  if(!primary||new URL(primary.baseUrl).hostname!=='ark.cn-beijing.volces.com')return [];
  const data=await loadRegistry(),token=await getAdminToken();
  return data.models.filter(model=>model.kind==='text'&&model.enabled&&model.id!==primary.id&&model.baseUrl.replace(/\/$/,'')===primary.baseUrl.replace(/\/$/,'')&&modelKey(model,data)).slice(0,2).map(model=>{
    const {apiKeyCiphertext:_key,apiKeySourceId:_source,...fields}=model;
    return {...fields,apiKey:decrypt(modelKey(model,data)!,token)};
  });
}

export async function setDefaultTextModelId(id: string | null): Promise<void> {
  await mutate((data) => {
    if (id !== null && !data.models.some((model) => model.id === id && model.kind === 'text' && model.enabled && modelKey(model, data))) {
      throw new Error('请选择已启用且配置了密钥的文本模型。');
    }
    data.defaultTextModelId = id;
  });
}

export async function upsertModel(input: Partial<ModelConfig> & Pick<ModelConfig, 'name' | 'provider' | 'kind' | 'modelId' | 'baseUrl' | 'enabled'>): Promise<AdminModel> {
  return mutate((data, token) => {
    const existing = input.id ? data.models.find((model) => model.id === input.id) : undefined;
    const id = existing?.id || randomUUID();
    const item: StoredModel = {
      id,
      name: input.name.trim(),
      provider: input.provider.trim(),
      kind: input.kind,
      modelId: input.modelId.trim(),
      baseUrl: input.baseUrl.trim(),
      enabled: input.enabled,
      apiKeyCiphertext: input.apiKey?.trim() ? encrypt(input.apiKey.trim(), token) : existing?.apiKeyCiphertext,
      apiKeySourceId: input.apiKey?.trim() ? undefined : existing?.apiKeySourceId,
    };
    if (!item.name || !item.provider || !item.modelId || !['text', 'image', 'audio', 'understanding'].includes(item.kind)) throw new Error('请填写有效的模型名称、厂商、用途与模型 ID。');
    if (item.kind === 'understanding' && item.modelId !== 'doubao-seed-2-1-lite-260915') throw new Error('音频理解请使用已验证的 doubao-seed-2-1-lite-260915。');
    if (item.baseUrl && !/^https:\/\//.test(item.baseUrl)) throw new Error('服务地址必须使用 HTTPS。');
    if (existing) data.models[data.models.indexOf(existing)] = item;
    else data.models.push(item);
    return { id, name: item.name, provider: item.provider, kind: item.kind, modelId: item.modelId, baseUrl: item.baseUrl, enabled: item.enabled, hasApiKey: Boolean(modelKey(item, data)) };
  });
}

export async function deleteModel(id: string): Promise<void> {
  await mutate((data) => {
    const index = data.models.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('模型不存在。');
    data.models.splice(index, 1);
    if (data.defaultTextModelId === id) data.defaultTextModelId = null;
  });
}
