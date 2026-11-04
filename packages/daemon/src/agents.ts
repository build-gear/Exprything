import { execFile } from 'node:child_process';
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AgentId, AgentStatus } from '@exprything/schema';
import { expandHome, paths, readJson, writeJsonAtomic } from './paths.ts';
import { writeShim } from './shim.ts';

/*
 * Connecting Claude Code and Codex: the exprything MCP server, registered through each agent's own
 * CLI (never by editing its config), and opt-in activity hooks that run `exp hook`. Both point at the
 * shim (shim.ts), so the agents' settings stay the same when Exprything moves.
 */

const SERVER = 'exprything';

interface HookSpec { async?: boolean; timeout?: number }

interface Agent {
  id: AgentId;
  name: string;
  bin: string;
  /** Where its installers put the CLI, for when no PATH has it. */
  fallbacks: string[];
  /** The settings file its hooks live in. */
  hooksFile: () => string;
  /** The hook events activity uses, and how each runs. */
  events: Record<string, HookSpec>;
  defaults: HookSpec;
}

const claudeDir = () => expandHome(process.env.CLAUDE_CONFIG_DIR ?? '~/.claude');
const codexDir = () => expandHome(process.env.CODEX_HOME ?? '~/.codex');
/** Claude Code's own state file, which holds its MCP servers; it moves with CLAUDE_CONFIG_DIR. */
const claudeState = () => (process.env.CLAUDE_CONFIG_DIR ? join(claudeDir(), '.claude.json') : join(homedir(), '.claude.json'));

const AGENTS: Record<AgentId, Agent> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    fallbacks: ['~/.local/bin', '~/.claude/local', '/opt/homebrew/bin', '/usr/local/bin'],
    hooksFile: () => join(claudeDir(), 'settings.json'),
    events: {
      SessionStart: {}, UserPromptSubmit: {}, PreToolUse: {}, PermissionRequest: {}, PostToolUse: {}, PostToolUseFailure: {},
      Notification: {}, SubagentStart: {}, SubagentStop: {}, Stop: {}, PreCompact: {},
      // Runs while Claude Code exits; a timeout in a settings file raises the 1.5 s it allows.
      SessionEnd: { async: false, timeout: 5 },
    },
    defaults: { async: true },
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    fallbacks: ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin'],
    hooksFile: () => join(codexDir(), 'hooks.json'),
    events: {
      SessionStart: {}, UserPromptSubmit: {}, PreToolUse: {}, PermissionRequest: {}, PostToolUse: {}, PostModelRequest: {},
      SubagentStart: {}, SubagentStop: {}, Stop: {}, PreCompact: {},
      Interrupt: { timeout: 3 },
      // Codex runs SessionEnd synchronously in any case.
      SessionEnd: { async: false, timeout: 3 },
    },
    // Background hooks share eight slots per session; a stuck one must not hold one for 10 minutes.
    defaults: { async: true, timeout: 10 },
  },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** `claude` and `claude-code` both name Claude Code. */
export function parseAgent(name: string): AgentId {
  const id = name === 'claude' ? 'claude-code' : name;
  if (!(id in AGENTS)) throw new Error(`unknown agent: ${name} (use claude or codex)`);
  return id as AgentId;
}

// ---------- status ----------

export async function agentStatus(id: AgentId): Promise<AgentStatus> {
  const a = AGENTS[id];
  // The commands shown for doing this by hand run the shim, so it has to be there.
  if (!existsSync(paths.shim)) writeShim();
  const cli = await findCli(a);
  const status: AgentStatus = {
    agent: id, name: a.name, mcp: { connected: false }, activity: activityState(a), notes: [], manual: manualCommands(a),
  };
  if (cli) status.cli = { path: cli.path, version: await version(cli) };
  else status.notes.push(`The ${a.bin} command was not found. Install ${a.name}, or run the commands below where it is.`);

  if (id === 'claude-code') {
    const { user, locals } = readClaudeServers();
    if (user) status.mcp = { connected: true, scope: 'user', command: commandOf(user), outdated: !runsShim(user) };
    const shadowedIn = locals.filter((l) => !runsShim(l.server)).map((l) => l.project);
    if (shadowedIn.length) {
      status.mcp.shadowedIn = shadowedIn;
      status.notes.push(
        `An older exprything server added to ${shadowedIn.length === 1 ? 'one project' : `${shadowedIn.length} projects`} only (local scope) overrides this one there: ` +
          shadowedIn.map((p) => `cd ${shq(p)} && claude mcp remove ${SERVER} --scope local`).join('; '),
      );
    }
  } else if (cli) {
    const server = await codexServer(cli);
    if (server) status.mcp = { connected: true, scope: 'global', command: commandOf(server), outdated: !runsShim(server) };
  }
  if (id === 'codex' && status.activity !== 'off') {
    status.notes.push('Codex runs new hooks only after you trust them: open /hooks in Codex (or Settings > Hooks in the ChatGPT app) and trust the exprything ones.');
  }
  return status;
}

function manualCommands(a: Agent): string[] {
  const shim = shq(paths.shim);
  return a.id === 'claude-code'
    ? [`claude mcp add --scope user ${SERVER} -- ${shim} mcp`]
    : [`codex mcp add ${SERVER} -- ${shim} mcp`];
}

// ---------- connect / disconnect ----------

/**
 * Registers the exprything MCP server with the agent, or leaves it be when it is already right.
 * `activity` turns its activity hooks on or off; left out, they stay as they are.
 */
export async function connectAgent(id: AgentId, opts: { activity?: boolean } = {}): Promise<AgentStatus> {
  const a = AGENTS[id];
  const shim = writeShim();
  const cli = await findCli(a);
  if (!cli) throw new Error(`the ${a.bin} command was not found; install ${a.name}, or run: ${manualCommands(a)[0]}`);
  if (id === 'claude-code') {
    const { user } = readClaudeServers();
    if (!user || !runsShim(user)) {
      // Claude Code refuses to add a name that exists in the same scope.
      if (user) await check(cli, ['mcp', 'remove', '--scope', 'user', SERVER]);
      await check(cli, ['mcp', 'add-json', '--scope', 'user', SERVER, JSON.stringify({ type: 'stdio', command: shim, args: ['mcp'] })]);
    }
  } else {
    const server = await codexServer(cli);
    // codex mcp add replaces an entry of the same name.
    if (!server || !runsShim(server)) await check(cli, ['mcp', 'add', SERVER, '--', shim, 'mcp']);
  }
  if (opts.activity !== undefined) setHooks(a, opts.activity);
  return agentStatus(id);
}

/**
 * Connects each agent the first time it turns up, so the agents a person runs themselves can draw on canvases
 * without a setup step; the desktop app does this when it starts. An agent seen before stays as the person left
 * it, so Disconnect sticks. Activity hooks stay off until they are turned on.
 */
export async function connectNewAgents(): Promise<AgentId[]> {
  const connected: AgentId[] = [];
  for (const id of AGENT_IDS) {
    if (seenAgents().includes(id) || !(await findCli(AGENTS[id]))) continue;
    try {
      await connectAgent(id);
      markSeen(id);
      connected.push(id);
    } catch {
      // Tried again at the next launch.
    }
  }
  return connected;
}

const seenAgents = () => readJson<AgentId[]>(paths.agentsSeen, []);

function markSeen(id: AgentId): void {
  const seen = seenAgents();
  if (!seen.includes(id)) writeJsonAtomic(paths.agentsSeen, [...seen, id]);
}

/** Turns the agent's activity hooks on or off, and nothing else. */
export async function setAgentActivity(id: AgentId, on: boolean): Promise<AgentStatus> {
  writeShim();
  setHooks(AGENTS[id], on);
  return agentStatus(id);
}

/** Removes the MCP server and the activity hooks. Projects' own (local scope) entries stay. */
export async function disconnectAgent(id: AgentId): Promise<AgentStatus> {
  const a = AGENTS[id];
  markSeen(id);
  setHooks(a, false);
  const cli = await findCli(a);
  if (cli && id === 'claude-code' && readClaudeServers().user) await check(cli, ['mcp', 'remove', '--scope', 'user', SERVER]);
  if (cli && id === 'codex' && (await codexServer(cli))) await check(cli, ['mcp', 'remove', SERVER]);
  return agentStatus(id);
}

interface McpEntry { command?: unknown; args?: unknown }

const commandOf = (s: McpEntry) => [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x): x is string => typeof x === 'string');
const runsShim = (s: McpEntry) => s.command === paths.shim && JSON.stringify(s.args) === '["mcp"]';

/** Read only: the file is Claude Code's, and it rewrites it while it runs. */
function readClaudeServers(): { user?: McpEntry; locals: { project: string; server: McpEntry }[] } {
  let state: { mcpServers?: Record<string, McpEntry>; projects?: Record<string, { mcpServers?: Record<string, McpEntry> }> };
  try {
    state = JSON.parse(readFileSync(claudeState(), 'utf8'));
  } catch {
    return { locals: [] };
  }
  const locals = Object.entries(state.projects ?? {}).flatMap(([project, p]) => {
    const server = p?.mcpServers?.[SERVER];
    return server ? [{ project, server }] : [];
  });
  return { user: state.mcpServers?.[SERVER], locals };
}

async function codexServer(cli: Cli): Promise<McpEntry | undefined> {
  const res = await run(cli, ['mcp', 'get', SERVER, '--json']);
  if (res.code !== 0) return undefined; // exits 1 when there is none
  try {
    const server = JSON.parse(res.stdout) as { transport?: McpEntry };
    return server.transport ?? {};
  } catch {
    return {};
  }
}

// ---------- activity hooks ----------

const OUR_HOOK = /\bexp["']? hook --agent (claude-code|codex)\b/;

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isOurs = (h: unknown) => isRecord(h) && typeof h.command === 'string' && OUR_HOOK.test(h.command);

/** Adds or removes the agent's activity hooks in its settings file, and leaves the rest of the file as it was. */
function setHooks(a: Agent, on: boolean): void {
  const file = a.hooksFile();
  if (!on && !existsSync(file)) return;
  const settings = readSettings(file);
  const before = JSON.stringify(settings);
  const hooks: Record<string, unknown[]> = isRecord(settings.hooks) ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap((g) => {
      if (!isRecord(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) return [g];
      const rest = g.hooks.filter((h: unknown) => !isOurs(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (on) {
    const command = `"${paths.shim.replace(/["\\$`]/g, '\\$&')}" hook --agent ${a.id}`;
    for (const [event, spec] of Object.entries(a.events)) {
      const { async, timeout } = { ...a.defaults, ...spec };
      (hooks[event] ??= []).push({ hooks: [{ type: 'command', command, ...(async && { async: true }), ...(timeout && { timeout }) }] });
    }
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  if (JSON.stringify(settings) !== before) writeSettings(file, settings);
}

function activityState(a: Agent): AgentStatus['activity'] {
  let hooks: Record<string, unknown>;
  try {
    const settings = readSettings(a.hooksFile());
    hooks = isRecord(settings.hooks) ? settings.hooks : {};
  } catch {
    return 'off';
  }
  const events = Object.keys(a.events);
  const on = events.filter((ev) => {
    const groups = hooks[ev];
    return Array.isArray(groups) && groups.some((g) => isRecord(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs));
  });
  return on.length === 0 ? 'off' : on.length === events.length ? 'on' : 'partial';
}

function readSettings(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it, then try again`);
  }
  if (!isRecord(value)) throw new Error(`${file} does not hold a JSON object`);
  return value;
}

/** Atomic, keeps the file's mode, and writes through a symlink (dotfiles are often linked). */
function writeSettings(file: string, value: unknown): void {
  const target = existsSync(file) && lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const tmp = `${target}.exprything-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, target);
}

// ---------- finding and running the agents' CLIs ----------

export interface Cli { path: string; env: NodeJS.ProcessEnv }

export const agentName = (id: AgentId) => AGENTS[id].name;

/** The agent's CLI with the environment to run it in, or nothing when it is not installed. */
export function agentCli(id: AgentId): Promise<Cli | undefined> {
  return findCli(AGENTS[id]);
}

async function findCli(a: Agent): Promise<Cli | undefined> {
  const own = process.env.PATH ?? '';
  const onPath = which(a.bin, own);
  if (onPath) return { path: onPath, env: childEnv(own) };
  const login = await loginShellPath();
  const found = which(a.bin, login) ?? which(a.bin, a.fallbacks.map(expandHome).join(delimiter));
  // With the login shell's PATH, a CLI installed with npm finds node too.
  return found ? { path: found, env: childEnv([login, own].filter(Boolean).join(delimiter)) } : undefined;
}

function which(bin: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, bin);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The agents' CLIs run without what only Exprything's own processes need, or a parent Claude Code session's identity. */
function childEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'EXPRYTHING_UI_DIST', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) {
    delete env[k];
  }
  return env;
}

let shellPath: { at: number; value: Promise<string> } | undefined;

/** The PATH of the person's terminal; an app opened from Finder, and launchd, start with a bare one. */
function loginShellPath(): Promise<string> {
  if (shellPath && Date.now() - shellPath.at < 60_000) return shellPath.value;
  const value = new Promise<string>((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\n<<%s>>" "$PATH"'], { timeout: 5_000 }, (_err, stdout) => {
      resolve(/<<(.*)>>\s*$/.exec(String(stdout))?.[1] ?? '');
    });
  });
  shellPath = { at: Date.now(), value };
  return value;
}

function run(cli: Cli, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cli.path, args, { env: cli.env, cwd: homedir(), timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function check(cli: Cli, args: string[]): Promise<void> {
  const res = await run(cli, args);
  if (res.code !== 0) {
    const why = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' ');
    throw new Error(`\`${[cli.path.split('/').pop(), ...args].join(' ')}\` failed: ${why || `exit ${res.code}`}`);
  }
}

async function version(cli: Cli): Promise<string | undefined> {
  const res = await run(cli, ['--version'], 10_000);
  return /\d+\.\d+\.\d+[\w.+-]*/.exec(res.stdout)?.[0];
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
