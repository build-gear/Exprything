// Bundles what the desktop app runs: its Electron main process, and the exp CLI (daemon and MCP
// server included) for the app's own Node, so the app needs neither a Node install nor tsx.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist');
const cli = join(out, 'exprything');

rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, '../cli/src/main.ts')],
  outfile: join(cli, 'cli-main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Optional native speedups ws loads when they are installed.
  external: ['bufferutil', 'utf-8-validate'],
  // Bundled CommonJS dependencies still call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// node:sqlite prints an ExperimentalWarning when it loads; drop it first, since MCP speaks over stdio.
writeFileSync(join(cli, 'cli.mjs'), "process.removeAllListeners('warning');\nawait import('./cli-main.mjs');\n");

mkdirSync(join(cli, 'bin'), { recursive: true });
writeFileSync(
  join(cli, 'bin', 'exp'),
  `#!/bin/sh
# exp on the Node built into Exprything.app. Symlink it into your PATH, or give its full path to MCP clients.
self="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
dir="$(cd "$(dirname "$self")/.." && pwd)"
export ELECTRON_RUN_AS_NODE=1
export EXPRYTHING_UI_DIST="\${EXPRYTHING_UI_DIST:-$dir/ui}"
exec "$dir/../../MacOS/Exprything" "$dir/cli.mjs" "$@"
`,
);
chmodSync(join(cli, 'bin', 'exp'), 0o755);
