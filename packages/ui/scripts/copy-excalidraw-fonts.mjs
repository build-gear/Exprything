// Excalidraw loads its canvas fonts at runtime from window.EXCALIDRAW_ASSET_PATH (set in index.html)
// and falls back to a public CDN. Copying them into public/ keeps the canvas working offline.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const pkg = new URL('../node_modules/@excalidraw/excalidraw/', import.meta.url);
const dest = new URL('../public/fonts/', import.meta.url);
const marker = new URL('.excalidraw-version', dest);

const { version } = JSON.parse(readFileSync(new URL('package.json', pkg), 'utf8'));
if (existsSync(marker) && readFileSync(marker, 'utf8') === version) process.exit(0);

rmSync(dest, { recursive: true, force: true });
cpSync(new URL('dist/prod/fonts/', pkg), dest, { recursive: true });
writeFileSync(marker, version);
console.log(`copied Excalidraw ${version} fonts to public/fonts`);
