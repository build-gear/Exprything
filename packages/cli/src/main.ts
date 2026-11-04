import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ExpClient } from '@exprything/client';
import {
  AGENT_IDS, agentStatus, connectAgent, disconnectAgent, forwardHook, parseAgent, paths, startDaemon, type DaemonInfo,
} from '@exprything/daemon';
import { runMcpServer } from '@exprything/mcp';
import { activityCanvas, type AgentIdentity, type AgentStatus } from '@exprything/schema';

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

program
  .command('connect [agents...]')
  .description('let Claude Code (claude) and Codex (codex) draw on your canvases; with no agent, show how they are connected')
  .option('--activity', 'also show what the agent does, on the agent-activity canvas (installs its hooks)')
  .option('--no-activity', 'stop sending what the agent does (removes its hooks)')
  .option('--json', 'print JSON')
  .action(async (names: string[], opts: { activity?: boolean; json?: boolean }) => {
    if (!names.length) return printAgents(await Promise.all(AGENT_IDS.map(agentStatus)), opts.json);
    const statuses: AgentStatus[] = [];
    for (const id of names.map(parseAgent)) statuses.push(await connectAgent(id, { activity: opts.activity }));
    let activityUrl: string | undefined;
    if (opts.activity) {
      const c = await connect();
      // Set it up once; a person may have changed it since.
      await c.canvas(activityCanvas.canvas).catch(() => c.apply(activityCanvas));
      activityUrl = c.canvasUrl(activityCanvas.canvas);
    }
    if (opts.json) return print({ agents: statuses, activityCanvas: activityUrl });
    printAgents(statuses);
    if (activityUrl) print(`\nAgent activity: exp open ${activityCanvas.canvas}`);
    print('\nStart a new agent session to pick up the change.');
  });

program
  .command('disconnect <agents...>')
  .description('remove Exprything from Claude Code (claude) or Codex (codex): its MCP server and activity hooks')
  .option('--json', 'print JSON')
  .action(async (names: string[], opts: { json?: boolean }) => {
    const statuses: AgentStatus[] = [];
    for (const id of names.map(parseAgent)) statuses.push(await disconnectAgent(id));
    printAgents(statuses, opts.json);
  });

// Run by the agents' hooks (exp connect --activity): never prints, never fails.
program
  .command('hook', { hidden: true })
  .requiredOption('--agent <agent>')
  .action(async (opts: { agent: string }) => {
    const receivedAt = new Date().toISOString();
    try {
      await forwardHook(parseAgent(opts.agent), await readStdin(), receivedAt);
    } catch {
      // An agent must never see a failing hook from us.
    }
    // Idle keep-alive sockets would hold the agent's hook open a few seconds longer.
    process.exit(0);
  });

function printAgents(statuses: AgentStatus[], json?: boolean): void {
  if (json) return print(statuses);
  for (const s of statuses) {
    print(`${s.name}${s.cli?.version ? ` ${s.cli.version}` : ''}${s.cli ? `  (${s.cli.path})` : '  (not found)'}`);
    const mcp = s.mcp.connected
      ? `connected (${s.mcp.scope} scope)${s.mcp.outdated ? `, runs ${s.mcp.command?.join(' ')}: \`exp connect ${short(s)}\` updates it` : ''}`
      : `not connected: exp connect ${short(s)}`;
    print(`  MCP       ${mcp}`);
    print(`  activity  ${s.activity}${s.activity === 'off' ? ` (exp connect ${short(s)} --activity)` : ''}`);
    for (const n of s.notes) print(`  ! ${n}`);
  }
}

const short = (s: AgentStatus) => (s.agent === 'claude-code' ? 'claude' : s.agent);

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
