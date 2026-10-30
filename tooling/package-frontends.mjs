import { cp, rm } from 'node:fs/promises';

// Keep independent build outputs; package both for the existing atomic release.
const destination = new URL('../dist/admin/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await cp(new URL('../apps/admin/dist/', import.meta.url), destination, { recursive: true });
const desktop = new URL('../dist/desktop/', import.meta.url);
await rm(desktop, { recursive: true, force: true });
await cp(new URL('../apps/desktop/dist/', import.meta.url), desktop, { recursive: true });
