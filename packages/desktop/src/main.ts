import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, shell } from 'electron';
import { ExpClient } from '@exprything/client';
import { writeShim } from '@exprything/daemon/shim';

/*
 * Exprything as a desktop app: the canvas in its own window. The daemon stays its own background
 * process, as with `exp daemon start`: the app attaches to one that is running or starts it, and
 * quitting the app leaves it running so recipes keep refreshing. The app carries the daemon, CLI and
 * MCP server bundled for its own Node (Electron run as Node), so nothing else needs installing.
 */

const home = process.env.EXPRYTHING_HOME ?? join(homedir(), '.exprything');
/** The bundled CLI: in the app's resources, or next to this file in a development build. */
const resources = app.isPackaged ? join(process.resourcesPath, 'exprything') : join(__dirname, 'exprything');
const uiDist = app.isPackaged ? join(resources, 'ui') : resolve(__dirname, '../../ui/dist');
/** Development: load the canvas from the Vite dev server instead (e.g. http://localhost:5173). */
const devUrl = process.env.EXPRYTHING_DESKTOP_URL?.replace(/\/$/, '');
/** Not a build from source, nor the temporary copy an unnotarized app runs from, unmoved from Downloads, which goes away when it quits. */
const installed = app.isPackaged && !resources.includes('/AppTranslocation/');

type WindowState = { canvas?: string; bounds?: Electron.Rectangle };

let client: ExpClient | undefined;
let win: BrowserWindow | null = null;

/** Attach to the daemon, starting it in the background when none answers. */
async function connect(): Promise<ExpClient> {
  client = await ExpClient.connect({ start: startDaemon, timeoutMs: 20_000 });
  return client;
}

function startDaemon(): void {
  mkdirSync(home, { recursive: true });
  const log = openSync(join(home, 'daemon.log'), 'a');
  spawn(process.execPath, [join(resources, 'cli.mjs'), 'daemon', 'run'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', EXPRYTHING_UI_DIST: uiDist, PATH: loginShellPath() },
  }).unref();
}

/**
 * An app opened from Finder gets a bare PATH, but exec recipes run what the person runs in their
 * terminal (git, gh, node…), so the daemon gets their login shell's PATH.
 */
function loginShellPath(): string {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\n<<%s>>" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /<<(.*)>>\s*$/.exec(out)?.[1] || process.env.PATH || '';
  } catch {
    return process.env.PATH ?? '';
  }
}

async function showWindow(): Promise<void> {
  if (!win) return openWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
}

async function openWindow(): Promise<void> {
  const state = readState();
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    ...onScreen(state.bounds),
    minWidth: 640,
    minHeight: 480,
    title: 'Exprything',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win = w;
  w.on('close', () => writeState({ canvas: canvasOf(w.webContents.getURL()) ?? state.canvas, bounds: w.getNormalBounds() }));
  w.on('closed', () => { win = null; });

  // The canvas stays in this window; anything else it links to opens in the browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (event, url) => {
    if (isCanvasUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  // The daemon serves the canvas page: if it has stopped, start it again and retry.
  let retries = 0;
  w.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: replaced by a newer navigation
    if (retries++ >= 3) {
      dialog.showErrorBox('Exprything could not load the canvas', `${description}\n\nSee ${join(home, 'daemon.log')}.`);
      return;
    }
    setTimeout(() => void load(w, canvasOf(url) ?? 'main').catch(() => {}), 1_000);
  });
  w.webContents.on('did-finish-load', () => { retries = 0; });

  await load(w, state.canvas ?? 'main');
}

async function load(w: BrowserWindow, canvas: string): Promise<void> {
  const c = await connect();
  // A failed load is retried by the did-fail-load handler.
  await w.loadURL(c.canvasUrl(canvas, devUrl)).catch(() => {});
}

function isCanvasUrl(url: string): boolean {
  const base = devUrl ?? client?.baseUrl;
  return !!base && (url === base || url.startsWith(`${base}/`));
}

function openExternal(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

const canvasOf = (url: string) => /#\/c\/([^?&]+)/.exec(url)?.[1];

async function openInBrowser(): Promise<void> {
  const c = client ?? (await connect());
  void shell.openExternal(c.canvasUrl((win && canvasOf(win.webContents.getURL())) ?? 'main'));
}

/** Help > Connect an Agent…: the AI sidebar's settings, which connect Claude Code and Codex. */
async function showAgents(): Promise<void> {
  await showWindow();
  // The page opens them for #…?agents (App.tsx).
  await win?.webContents.executeJavaScript("location.hash = location.hash.replace(/[?].*$/, '') + '?agents'").catch(() => {});
}

/**
 * Agents run exp through ~/.exprything/bin/exp (the daemon's shim.ts); point it at this app, wherever it
 * is now, so moving the app does not break them. One that points at a checkout is a developer's choice
 * and stays.
 */
function updateShim(): void {
  if (!installed) return;
  let current = '';
  try {
    current = readFileSync(join(home, 'bin', 'exp'), 'utf8');
  } catch {
    // none yet
  }
  if (current && !current.includes('.app/Contents/Resources/exprything/bin/exp')) return;
  try {
    writeShim({ argv: [join(resources, 'bin', 'exp')], env: {} });
  } catch {
    // Agents keep the path they have.
  }
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          { label: 'Open in Browser', accelerator: 'CmdOrCtrl+Shift+B', click: () => void openInBrowser() },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'Connect an Agent…', click: () => void showAgents() },
          { label: 'Show Daemon Log', click: () => void shell.openPath(join(home, 'daemon.log')) },
        ],
      },
    ]),
  );
}

const stateFile = () => join(app.getPath('userData'), 'window.json');

function readState(): WindowState {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
  } catch {
    return {};
  }
}

function writeState(state: WindowState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // Best effort: the next launch opens at the default size.
  }
}

/** Saved bounds, without the position when no display shows it any more. */
function onScreen(bounds?: Electron.Rectangle): Partial<Electron.Rectangle> {
  if (!bounds) return {};
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
  return visible ? bounds : { width: bounds.width, height: bounds.height };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void showWindow());
  app.on('activate', () => void showWindow());
  // Closing the window keeps the app in the Dock; quitting it leaves the daemon running.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      buildMenu();
      updateShim();
      await openWindow();
      // Agents found for the first time get the canvas tools. Their settings are one for every Exprything home,
      // so a custom home (a test, a second install) must not touch them. It fails quietly: the sidebar's settings can connect them.
      if (installed && !process.env.EXPRYTHING_HOME) void client?.connectNewAgents().catch(() => {});
    })
    .catch((e: Error) => {
      dialog.showErrorBox('Exprything could not start', `${e.message}\n\nSee ${join(home, 'daemon.log')}.`);
      app.quit();
    });
}
