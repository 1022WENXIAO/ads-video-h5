import { readFile } from 'node:fs/promises';

// Only a genuinely absent file is a new installation. Permission failures and
// malformed data must never become an empty state that startup overwrites.
export async function loadApplicationState<T extends object>(filename: string, initial: () => T): Promise<T> {
  let text: string;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initial();
    throw new Error('会话存储无法读取，已保留原文件；请检查文件权限和磁盘。', { cause: error });
  }
  let stored: unknown;
  try { stored = JSON.parse(text); }
  catch { throw new Error('会话存储 JSON 已损坏，已保留原文件；请从备份核对修复。'); }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('会话存储结构无效，已保留原文件。');
  const value = stored as Record<string, unknown>;
  for (const key of ['sessions', 'media', 'artifacts', 'jobs']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || (value[key] as unknown[]).some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw new Error(`会话存储 ${key} 结构无效，已保留原文件。`);
  }
  for (const key of ['settings', 'profiles', 'artifactFiles', 'narrationBySession', 'bgmBySession']) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) throw new Error(`会话存储 ${key} 结构无效，已保留原文件。`);
  }
  if (value.activeSessionId !== undefined && typeof value.activeSessionId !== 'string') throw new Error('会话存储 activeSessionId 结构无效，已保留原文件。');
  return { ...initial(), ...value } as T;
}
