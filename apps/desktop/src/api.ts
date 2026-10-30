const prefix = (import.meta.env.VITE_API_BASE_PATH || '/').replace(/\/$/, '');
export const apiUrl = (path: string) => prefix + path;
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || `请求失败（${response.status}）`), {
      status: response.status,
    });
  return result as T;
}
