import type { Express, NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { userOf, type PublicUser } from './auth';
import { detectImage, runFFmpeg } from './core';

export async function mountAccountAvatar(app: Express, dataDir: string, publicBase: string, save: (id: string, url: string) => Promise<PublicUser>) {
  const directory = path.join(dataDir, 'account-avatars');
  await mkdir(directory, { recursive: true });
  const prefix = publicBase + '/api/account/avatar/';
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 0 } }).single('avatar');
  app.post('/api/account/avatar', (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, error => {
      if (error) { res.status(400).json({ error: '请选择一张不超过 4 MB 的 PNG、JPEG 或 WebP 头像。' }); return; }
      void (async () => {
        const file = req.file;
        if (!file || !detectImage(file.buffer)) { res.status(400).json({ error: '头像仅支持 PNG、JPEG 或 WebP 图片。' }); return; }
        const id = randomUUID(), source = path.join(directory, id + '.source'), target = path.join(directory, id + '.jpg');
        let committed = false;
        try {
          await writeFile(source, file.buffer, { mode: 0o600, flag: 'wx' });
          try { await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=increase,crop=256:256', '-q:v', '3', target], 15000); }
          catch { res.status(400).json({ error: '这张图片无法用作头像，请换一张重试。' }); return; }
          const user = userOf(req), previous = user.avatarUrl;
          const updated = await save(user.id, prefix + id);
          committed = true;
          res.json({ user: updated });
          // Only the previously owned, normalized avatar may be removed.
          const previousId = previous && previous.startsWith(prefix) ? previous.slice(prefix.length) : '';
          if (/^[a-f0-9-]{36}$/.test(previousId)) await rm(path.join(directory, previousId + '.jpg'), { force: true }).catch(() => {});
        } finally {
          await rm(source, { force: true });
          if (!committed) await rm(target, { force: true });
        }
      })().catch(next);
    });
  });
  app.get('/api/account/avatar/:id', (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9-]{36}$/.test(id) || userOf(req).avatarUrl !== prefix + id) { res.status(404).json({ error: '头像不存在。' }); return; }
    res.set('Cache-Control', 'private, max-age=86400').type('image/jpeg').sendFile(path.join(directory, id + '.jpg'));
  });
}
