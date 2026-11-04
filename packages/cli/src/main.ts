import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ExpClient } from '@exprything/client';
import { paths, startDaemon, type DaemonInfo } from '@exprything/daemon';
import { runMcpServer } from '@exprything/mcp';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/exp.js');
const LAUNCHD_LABEL = 'dev.exprything.daemon';
const LAUNCHD_PLIST = join(homedir(), 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);

function startInBackground(): void {
  mkdirSync(paths.root, { recursive: true });
  const log = openSync(paths.log, 'a');
  spawn(process.execPath, [BIN, 'daemon', 'run'], { detached: true, stdio: ['ignore', log, log] }).unref();
}

const connect = () => ExpClient.connect({ start: startInBackground });

function print(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

const program = new Command('exp').description('Exprything: a canvas that agents draw once and that keeps itself fresh.');

const daemon = program.command('daemon').description('manage the background daemon');
daemon.command('run').description('run the daemon in the foreground').action(() => {
  const { url } = startDaemon();
  console.error(`exprythingd listening on ${url}`);
});
daemon.command('start').description('start the daemon in the background').action(async () => {
  const c = await connect();
  print(`daemon running at ${c.baseUrl}`);
});
daemon.command('stop').description('stop the background daemon').action(() => {
  if (!existsSync(paths.daemon)) return print('daemon is not running');
  const info = JSON.parse(readFileSync(paths.daemon, 'utf8')) as DaemonInfo;
  try {
    process.kill(info.pid, 'SIGTERM');
    print(`stopped daemon (pid ${info.pid})`);
  } catch {
    rmSync(paths.daemon, { force: true });
    print('daemon was not running; cleaned up stale state');
  }
});

program.command('open [canvas]').description('open a canvas in the browser').action(async (canvas = 'main') => {
  const c = await connect();
  const url = c.canvasUrl(canvas);
  openBrowser(url);
  print(url);
});

program
  .command('apply')
  .description('apply an ApplyRequest JSON ({ canvas, ops, dryRun })')
  .requiredOption('-f, --file <path>', 'JSON file, or - for stdin')
  .option('-c, --canvas <id>', 'override the target canvas')
  .option('--dry-run', 'run sources once and render nodes without saving')
  .action(async (opts: { file: string; canvas?: string; dryRun?: boolean }) => {
    const raw = opts.file === '-' ? await readStdin() : readFileSync(opts.file, 'utf8');
    const req = JSON.parse(raw);
    if (opts.canvas) req.canvas = opts.canvas;
    if (opts.dryRun) req.dryRun = true;
    const c = await connect();
    print(await c.apply(req));
  });

program
  .command('push <source>')
  .description('push stdin into a push source (JSON value, or one item per line)')
  .option('--replace', 'replace the buffer instead of appending')
  .option('--lines', 'treat every stdin line as one item')
  .action(async (source: string, opts: { replace?: boolean; lines?: boolean }) => {
    const raw = await readStdin();
    let data: unknown;
    if (opts.lines) data = raw.split(/\r?\n/).filter(Boolean);
    else {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw.split(/\r?\n/).filter(Boolean);
      }
    }
    const c = await connect();
    print(await c.push(source, data, opts.replace ? 'replace' : 'append'));
  });

program.command('status').description('freshness of every source, approvals and repairs').action(async () => {
  const c = await connect();
  const s = await c.status();
  for (const st of s.sources) {
    const next = st.nextRunAt ? ` next ${new Date(st.nextRunAt).toLocaleTimeString()}` : '';
    const err = st.lastError ? `  ! ${st.lastError}` : '';
    print(`${st.status.padEnd(15)} ${st.id}${next}${err}`);
  }
  if (s.needsApproval.length) print(`\nawaiting approval: ${s.needsApproval.join(', ')}  (exp approve <id>)`);
  if (!s.sources.length) print('no sources yet');
});

program.command('sources').description('list source recipes').action(async () => print(await (await connect()).sources()));
program.command('canvases').description('list canvases').action(async () => print(await (await connect()).canvases()));
program
  .command('selection [canvas]')
  .description('what the person has selected on an open canvas (by default the one they used last)')
  .action(async (canvas?: string) => print(await (await connect()).selection(canvas)));
program.command('refresh <source>').description('run a source now').action(async (id: string) => print(await (await connect()).refresh(id)));
program.command('catalog').description('widget catalog and authoring guide').action(async () => print(await (await connect()).catalog()));

program
  .command('approve <source>')
  .description('allow an exec source to run on schedule')
  .action(async (id: string) => {
    const c = await connect();
    const src = ((await c.sources()) as { id: string; cmd?: string[]; cwd?: string }[]).find((s) => s.id === id);
    if (!src) throw new Error(`unknown source: ${id}`);
    if (src.cmd) print(`approving: ${JSON.stringify(src.cmd)}${src.cwd ? ` in ${src.cwd}` : ''}`);
    await c.approve(id);
    print('approved');
  });

program.command('mcp').description('run the MCP server over stdio (for Claude Code / Codex)').action(async () => {
  await runMcpServer(await connect());
});

const service = program.command('service').description('run the daemon at login (macOS launchd)');
service.command('install').action(() => {
  if (platform() !== 'darwin') throw new Error('only macOS launchd is supported for now; run `exp daemon start` instead');
  mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true });
  writeFileSync(
    LAUNCHD_PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${BIN}</string><string>daemon</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths.log}</string>
  <key>StandardErrorPath</key><string>${paths.log}</string>
</dict></plist>
`,
  );
  spawn('launchctl', ['load', '-w', LAUNCHD_PLIST], { stdio: 'inherit' });
  print(`installed ${LAUNCHD_PLIST}`);
});
service.command('uninstall').action(() => {
  if (existsSync(LAUNCHD_PLIST)) spawn('launchctl', ['unload', '-w', LAUNCHD_PLIST], { stdio: 'inherit' });
  rmSync(LAUNCHD_PLIST, { force: true });
  print('uninstalled');
});

program.parseAsync().catch((e: Error) => {
  console.error(`exp: ${e.message}`);
  process.exit(1);
});
