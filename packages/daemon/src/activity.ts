import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentEvent, parseDuration, type AgentId, type AgentSession, type Source } from '@exprything/schema';
import { DEFAULT_PORT, expandHome, paths } from './paths.ts';

type AgentSourceSpec = Extract<Source, { kind: 'agent' }>;
type Payload = Record<string, unknown>;

const KEEP_MS = 30 * 86_400_000;
/** Rows a sessions view reads at most; a day of heavy use stays well below it. */
const SCAN_LIMIT = 50_000;
const SPOOL_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_MAX = 200;

// ---------- hook payload -> AgentEvent ----------

/**
 * One hook payload from Claude Code or Codex as an AgentEvent; both send the same shape for the events
 * they share. Of a tool call it keeps what the tool worked on (a command's first line, a path, a
 * pattern), never what it read, wrote or printed. Unknown events are dropped.
 */
export function normalizeHook(agent: AgentId, payload: unknown, ts: string): AgentEvent | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Payload;
  const session = str(p.session_id);
  const name = str(p.hook_event_name);
  if (!session || !name) return undefined;
  const e: AgentEvent = { ts, agent, session, kind: 'notify' };
  const turn = str(p.prompt_id) ?? str(p.turn_id);
  if (turn) e.turn = turn;
  if (str(p.cwd)) e.cwd = str(p.cwd);
  if (str(p.model)) e.model = str(p.model);
  if (str(p.agent_id) || str(p.agent_type)) e.subagent = { id: str(p.agent_id), type: str(p.agent_type) };

  switch (name) {
    case 'SessionStart':
      return { ...e, kind: 'session.start', reason: str(p.source) };
    case 'UserPromptSubmit': {
      const prompt = str(p.prompt);
      return { ...e, kind: 'prompt', detail: prompt === undefined ? undefined : `${prompt.length} chars` };
    }
    case 'PreToolUse':
      return { ...e, kind: 'tool.pre', tool: toolOf(p) };
    case 'PermissionRequest':
      return { ...e, kind: 'permission', tool: toolOf(p) };
    case 'PostToolUse': {
      // Claude Code reports failed calls as PostToolUseFailure; Codex reports every call here.
      const ok = agent === 'codex' ? responseOk(p.tool_response) : true;
      return { ...e, kind: 'tool.post', tool: { ...toolOf(p), ok, ms: num(p.duration_ms) } };
    }
    case 'PostToolUseFailure':
      return {
        ...e, kind: 'tool.fail', reason: p.is_interrupt === true ? 'interrupted' : undefined,
        tool: { ...toolOf(p), ok: false, ms: num(p.duration_ms), error: clip(firstLine(str(p.error))) },
      };
    case 'Notification':
      return { ...e, kind: 'notify', reason: str(p.notification_type), detail: clip(str(p.message)) };
    case 'SubagentStart':
      return { ...e, kind: 'subagent.start' };
    case 'SubagentStop':
      return { ...e, kind: 'subagent.stop' };
    case 'PostModelRequest': {
      const u = p.token_usage as Payload | null | undefined;
      const tokens = u && typeof u === 'object'
        ? { input: num(u.input_tokens) ?? 0, output: num(u.output_tokens) ?? 0, cached: num(u.cached_input_tokens) }
        : undefined;
      return { ...e, kind: 'model.request', tokens, reason: str(p.status), detail: clip(str(p.error)) };
    }
    case 'Stop':
      return { ...e, kind: 'turn.end' };
    case 'StopFailure':
      return { ...e, kind: 'turn.end', reason: 'failed' };
    case 'PreCompact':
    case 'PostCompact':
      return { ...e, kind: 'compact', reason: str(p.trigger) };
    case 'Interrupt':
      return { ...e, kind: 'interrupt' };
    case 'SessionEnd':
      return { ...e, kind: 'session.end', reason: str(p.reason) };
    default:
      return undefined;
  }
}

function toolOf(p: Payload): { name: string; summary?: string } {
  const name = str(p.tool_name) ?? 'tool';
  const input = p.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Payload) : {};
  return { name, summary: summarize(name, input) };
}

/** What a tool call worked on. MCP tools take arbitrary arguments, so only their name is kept. */
export function summarize(name: string, input: Payload): string | undefined {
  if (name.startsWith('mcp__')) return undefined;
  if (name === 'apply_patch') {
    const files = [...(str(input.command) ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]);
    return files.length ? clip(files.join(', ')) : undefined;
  }
  const value = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'description']
    .map((k) => str(input[k]))
    .find((v) => v);
  return clip(firstLine(value));
}

/** Whether a Codex tool call succeeded, as far as its output says: a shell's exit code, an MCP error flag. */
function responseOk(r: unknown): boolean | undefined {
  if (typeof r === 'string') {
    const code = /exit(?:ed with)? code:?\s*(-?\d+)/i.exec(r)?.[1];
    return code === undefined ? undefined : code === '0';
  }
  if (r && typeof r === 'object') {
    const o = r as Payload;
    if (o.isError === true || o.is_error === true || o.success === false) return false;
    const code = num(o.exit_code) ?? num(o.exitCode);
    if (code !== undefined) return code === 0;
    if (typeof o.output === 'string') return responseOk(o.output);
  }
  return undefined;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const firstLine = (s?: string) => s?.trim().split('\n')[0];
const clip = (s?: string) => (s && s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

// ---------- exp hook: from an agent's hook to the daemon ----------

/**
 * What `exp hook` does for every hook an agent runs: send the event and get out of the agent's way.
 * It never starts the daemon, never prints and never fails; an event it cannot deliver goes to the
 * spool, which the daemon reads when it starts.
 */
export async function forwardHook(agent: AgentId, stdin: string, ts: string): Promise<void> {
  if (process.env.EXPRYTHING_ACTIVITY === 'off') return;
  let event: AgentEvent | undefined;
  try {
    event = normalizeHook(agent, JSON.parse(stdin), ts);
  } catch {
    return;
  }
  if (!event) return;
  try {
    const port = Number(process.env.EXPRYTHING_PORT ?? readPort() ?? DEFAULT_PORT);
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readFileSync(paths.token, 'utf8').trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
      // A session's end has to fit in the agent's shutdown budget (1.5 s in Claude Code).
      signal: AbortSignal.timeout(event.kind === 'session.end' ? 500 : 1_500),
    });
    if (res.ok) return;
  } catch {
    // Not running, or busy: spool it.
  }
  try {
    if (existsSync(paths.spool) && statSync(paths.spool).size > SPOOL_MAX_BYTES) return;
    appendFileSync(paths.spool, `${JSON.stringify(event)}\n`);
  } catch {
    // Nowhere to keep it.
  }
}

function readPort(): number | undefined {
  try {
    return (JSON.parse(readFileSync(paths.daemon, 'utf8')) as { port: number }).port;
  } catch {
    return undefined;
  }
}

// ---------- the log ----------

/** Every event connected agents reported, kept 30 days next to the source history. */
export class ActivityLog {
  private db: DatabaseSync;
  private added = 0;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL,
        session TEXT NOT NULL, kind TEXT NOT NULL, cwd TEXT, event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_events_ts ON agent_events (ts);
    `);
    this.prune();
  }

  add(events: AgentEvent[]): number {
    const insert = this.db.prepare('INSERT INTO agent_events (ts, agent, session, kind, cwd, event) VALUES (?, ?, ?, ?, ?, ?)');
    let n = 0;
    for (const e of events) {
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts)) continue;
      insert.run(ts, e.agent, e.session, e.kind, e.cwd ?? null, JSON.stringify(e));
      n++;
    }
    if ((this.added += n) > 1_000) this.prune();
    return n;
  }

  /** Reads events the spool kept while the daemon was down. Returns how many it added. */
  replaySpool(): number {
    if (!existsSync(paths.spool)) return 0;
    // Claim the file first: hooks that run meanwhile start a new one.
    const claimed = `${paths.spool}.${process.pid}.reading`;
    try {
      renameSync(paths.spool, claimed);
    } catch {
      return 0;
    }
    const events: AgentEvent[] = [];
    for (const line of readFileSync(claimed, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = AgentEvent.safeParse(JSON.parse(line));
        if (e.success) events.push(e.data);
      } catch {
        // A line cut short by a full disk or a killed hook.
      }
    }
    const n = this.add(events);
    rmSync(claimed, { force: true });
    return n;
  }

  /** A source's value: recent events, oldest first, or the sessions they belong to, newest first. */
  query(src: AgentSourceSpec): unknown[] {
    const where = ['ts >= ?'];
    const args: (string | number)[] = [Date.now() - parseDuration(src.since)];
    if (src.agents?.length) {
      where.push(`agent IN (${src.agents.map(() => '?').join(', ')})`);
      args.push(...src.agents);
    }
    if (src.view === 'events' && src.kinds?.length) {
      where.push(`kind IN (${src.kinds.map(() => '?').join(', ')})`);
      args.push(...src.kinds);
    }
    if (src.cwd) {
      const dir = expandHome(src.cwd).replace(/\/+$/, '');
      where.push("(cwd = ? OR cwd LIKE ? ESCAPE '\\')");
      args.push(dir, `${dir.replace(/[\\%_]/g, '\\$&')}${sep}%`);
    }
    const limit = src.view === 'sessions' ? SCAN_LIMIT : src.limit;
    const rows = this.db
      .prepare(`SELECT event FROM agent_events WHERE ${where.join(' AND ')} ORDER BY ts DESC, seq DESC LIMIT ?`)
      .all(...args, limit) as { event: string }[];
    const events = rows.reverse().map((r) => JSON.parse(r.event) as AgentEvent);
    if (src.view === 'sessions') return sessionsOf(events).slice(0, src.limit);
    return events.map((e) => ({ ...e, time: timeOfDay(e.ts) }));
  }

  private prune(): void {
    this.added = 0;
    this.db.prepare('DELETE FROM agent_events WHERE ts < ?').run(Date.now() - KEEP_MS);
  }
}

/** Each session's state is what its latest event says it is doing; events are oldest first. */
export function sessionsOf(events: AgentEvent[]): AgentSession[] {
  const sessions = new Map<string, AgentSession>();
  for (const e of events) {
    const key = `${e.agent}:${e.session}`;
    let s = sessions.get(key);
    if (!s) {
      s = { session: e.session, agent: e.agent, state: 'idle', startedAt: e.ts, lastAt: e.ts, time: '', prompts: 0, tools: 0, failures: 0 };
      sessions.set(key, s);
    }
    s.lastAt = e.ts;
    if (e.cwd) {
      s.cwd = e.cwd;
      s.project = basename(e.cwd);
    }
    if (e.model) s.model = e.model;
    if (e.tokens) s.tokens = (s.tokens ?? 0) + e.tokens.input + e.tokens.output;
    // A subagent's events count for the session it runs in: its tools are that session working.
    switch (e.kind) {
      case 'session.start':
      case 'turn.end':
      case 'interrupt':
        s.state = 'idle';
        s.doing = undefined;
        break;
      case 'prompt':
        s.prompts++;
        s.state = 'working';
        s.doing = undefined;
        break;
      case 'tool.pre':
        s.state = 'working';
        s.doing = label(e);
        break;
      case 'permission':
        s.state = 'waiting';
        s.doing = label(e);
        break;
      case 'tool.post':
      case 'tool.fail':
        s.tools++;
        if (e.tool?.ok === false) s.failures++;
        s.state = 'working';
        s.doing = undefined;
        break;
      case 'notify':
        // Claude Code's own "needs you" notices; a PermissionRequest hook usually came first.
        if (e.reason === 'permission_prompt' || e.reason === 'elicitation_dialog' || e.reason === 'agent_needs_input') {
          s.state = 'waiting';
        }
        break;
      case 'session.end':
        s.state = 'ended';
        s.doing = undefined;
        break;
    }
  }
  return [...sessions.values()]
    .map((s) => ({ ...s, time: timeOfDay(s.lastAt) }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

function label(e: AgentEvent): string | undefined {
  if (!e.tool) return undefined;
  return clip(e.tool.summary ? `${e.tool.name} ${e.tool.summary}` : e.tool.name);
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}
