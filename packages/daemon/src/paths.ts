import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_PORT = 7717;

export function homeDir(): string {
  return process.env.EXPRYTHING_HOME ?? join(homedir(), '.exprything');
}

export const paths = {
  get root() { return homeDir(); },
  get canvases() { return join(homeDir(), 'canvases'); },
  get drawings() { return join(homeDir(), 'drawings'); },
  /** Conversations in the AI sidebar, one JSON file each. */
  get chats() { return join(homeDir(), 'chats'); },
  get sources() { return join(homeDir(), 'sources.json'); },
  get history() { return join(homeDir(), 'history.db'); },
  get token() { return join(homeDir(), 'token'); },
  get daemon() { return join(homeDir(), 'daemon.json'); },
  get log() { return join(homeDir(), 'daemon.log'); },
  /** Agent events a hook could not deliver while the daemon was down; the daemon reads them when it starts. */
  get spool() { return join(homeDir(), 'agent-events.spool.jsonl'); },
  /** The exp that agents run (see shim.ts). */
  get shim() { return join(homeDir(), 'bin', 'exp'); },
  /** The agents the desktop app no longer connects by itself: connected once, or disconnected. */
  get agentsSeen() { return join(homeDir(), 'agents-seen.json'); },
};

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function ensureHome(): void {
  mkdirSync(paths.canvases, { recursive: true });
  mkdirSync(paths.drawings, { recursive: true });
}

/** Read the API token, creating it (0600) on first use. */
export function readOrCreateToken(): string {
  ensureHome();
  if (existsSync(paths.token)) return readFileSync(paths.token, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(paths.token, token, { mode: 0o600 });
  return token;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
