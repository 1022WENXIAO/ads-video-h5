import { cp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyFrontendBuilds } from './verify-frontends.mjs';

// Keep independent build outputs; package both for the existing atomic release.
const destination = new URL('../dist/admin/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await cp(new URL('../apps/admin/dist/', import.meta.url), destination, { recursive: true });
const desktop = new URL('../dist/desktop/', import.meta.url);
await rm(desktop, { recursive: true, force: true });
await cp(new URL('../apps/desktop/dist/', import.meta.url), desktop, { recursive: true });
const directory = new URL('../dist/', import.meta.url);
const { revision } = JSON.parse(await readFile(new URL('release.json', directory), 'utf8'));
const checked = await verifyFrontendBuilds(fileURLToPath(directory), { revision, basePath: process.env.VITE_BASE_PATH || '/' });
console.log(JSON.stringify({ event: 'frontend-build-verified', checked }));
