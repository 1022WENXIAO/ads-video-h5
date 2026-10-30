import express, { type Express } from 'express';
import path from 'node:path';

export function mountFrontendRoutes(app: Express, directory: string, publicBase = ''): void {
  const desktopDirectory = path.join(directory, 'desktop');
  app.get(/^\/desktop$/, (request,response) => response.redirect(308,`${publicBase}/desktop/${request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : ''}`));
  app.use('/desktop', express.static(desktopDirectory));
  app.get('/desktop/{*path}', (request,response) => {
    if(request.path.startsWith('/desktop/assets/') || path.extname(request.path)){ response.sendStatus(404);return; }
    response.sendFile(path.join(desktopDirectory,'index.html'), error=>{if(error&&!response.headersSent)response.status(404).send('桌面工作台尚未构建，请运行 pnpm build:desktop。');});
  });
  const adminDirectory = path.join(directory, 'admin');
  app.get(/^\/admin$/, (request, response) => response.redirect(308, `${publicBase}/admin/${request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : ''}`));
  app.use('/admin', express.static(adminDirectory));
  app.get('/admin/{*path}', (request, response) => {
    // Missing admin assets must never fall through to the phone application.
    if (request.path.startsWith('/admin/assets/') || path.extname(request.path)) { response.sendStatus(404); return; }
    response.sendFile(path.join(adminDirectory, 'index.html'), error => { if (error && !response.headersSent) response.status(404).send('管理控制台尚未构建，请运行 pnpm build。'); });
  });
  app.use(express.static(directory));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(directory, 'index.html')));
}
