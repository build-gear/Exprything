import { z } from 'zod';
import type { ApplyRequestInput } from './index.ts';

// ---------- agents: Claude Code and Codex, connected over MCP, observed through their hooks ----------

export const AgentId = z.enum(['claude-code', 'codex']);
export type AgentId = z.infer<typeof AgentId>;

export const AgentEventKind = z.enum([
  'session.start', 'prompt', 'tool.pre', 'tool.post', 'tool.fail', 'permission', 'notify',
  'subagent.start', 'subagent.stop', 'model.request', 'turn.end', 'compact', 'interrupt', 'session.end',
]);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

/**
 * One thing an agent did, from one of its hooks. Content stays behind: prompts, file contents, tool
 * output and transcripts never leave the hook, only what a monitor needs.
 */
export const AgentEvent = z.object({
  ts: z.string().describe('when the hook ran (ISO time)'),
  agent: AgentId,
  session: z.string(),
  kind: AgentEventKind,
  turn: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  subagent: z.object({ id: z.string().optional(), type: z.string().optional() }).optional(),
  tool: z
    .object({
      name: z.string(),
      summary: z.string().optional().describe('what it worked on: the command, file path, pattern or URL'),
      ok: z.boolean().optional(),
      ms: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
  tokens: z.object({ input: z.number(), output: z.number(), cached: z.number().optional() }).optional(),
  reason: z.string().optional().describe('how a session started or ended, a notification type, a compaction trigger'),
  detail: z.string().optional().describe("a notification's text, a prompt's length, a failed request's error"),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

/** An agent session as the "sessions" view of an agent source reports it. */
export interface AgentSession {
  session: string;
  agent: AgentId;
  cwd?: string;
  /** The last part of cwd. */
  project?: string;
  /** waiting: it asked the person for approval or input. idle: its turn ended. */
  state: 'working' | 'waiting' | 'idle' | 'ended';
  /** The tool it is running, or asking to run. */
  doing?: string;
  model?: string;
  startedAt: string;
  lastAt: string;
  /** lastAt as local time of day, for display. */
  time: string;
  prompts: number;
  tools: number;
  failures: number;
  /** Tokens its model requests used, where the agent reports them (Codex). */
  tokens?: number;
}

/** How an agent is connected: its CLI, the exprything MCP server as it sees it, and its activity hooks. */
export interface AgentStatus {
  agent: AgentId;
  name: string;
  cli?: { path: string; version?: string };
  mcp: {
    connected: boolean;
    /** Where the agent keeps the registration: Claude Code's user scope, Codex's global config. */
    scope?: string;
    command?: string[];
    /** Registered, but running something other than this Exprything. */
    outdated?: boolean;
    /** Claude Code projects whose own (local scope) exprything server overrides this one there. */
    shadowedIn?: string[];
  };
  activity: 'on' | 'off' | 'partial';
  /** What the person still has to do, or should know. */
  notes: string[];
  /** The same setup done by hand in a terminal. */
  manual: string[];
}

/** An agent session, as a canvas names it. Two sessions of one agent are two identities. */
export interface AgentIdentity {
  id: string;
  name: string;
}

/** Something an agent is changing: a widget on the canvas, or the place a new one will land. */
export interface AgentTarget {
  node: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An agent at work on a canvas: open canvases show its cursor, and a person cannot touch its targets
 * until it lets go of them. Lives in the daemon's memory, never in the canvas.
 */
export interface AgentPresence extends AgentIdentity {
  canvas: string;
  /** Empty while it only reads the canvas. */
  targets: AgentTarget[];
}

/** The canvas `exp connect <agent> --activity` sets up: what every connected agent is doing. */
export const activityCanvas = {
  canvas: 'agent-activity',
  title: 'Agent activity',
  ops: [
    { op: 'source.upsert', source: { id: 'agent-sessions', kind: 'agent', view: 'sessions', since: '1d', limit: 50 } },
    { op: 'source.upsert', source: { id: 'agent-events', kind: 'agent', since: '1d', limit: 1000 } },
    {
      op: 'node.upsert',
      node: {
        id: 'agents-waiting', type: 'stat', title: 'Waiting for you', source: 'agent-sessions',
        transform: '{ "value": $count($[state = "waiting"]) }', props: { unit: 'sessions' },
        layout: { x: 0, y: 0 }, style: { strokeColor: '#f08c00' },
      },
    },
    {
      op: 'node.upsert',
      node: {
        id: 'agents-working', type: 'stat', title: 'Working', source: 'agent-sessions',
        transform: '{ "value": $count($[state = "working"]) }', props: { unit: 'sessions' },
        layout: { near: 'agents-waiting', side: 'right' },
      },
    },
    {
      op: 'node.upsert',
      node: {
        id: 'agent-sessions', type: 'table', title: 'Sessions', source: 'agent-sessions',
        transform: '[$.{ "agent": agent, "project": project, "state": state, "doing": doing, "prompts": prompts, "tools": tools, "failed": failures, "last": time }]',
        props: { columns: ['agent', 'project', 'state', 'doing', 'prompts', 'tools', 'failed', 'last'] },
        layout: { near: 'agents-waiting', side: 'below', w: 760, h: 300 },
      },
    },
    {
      op: 'node.upsert',
      node: {
        id: 'agent-tools', type: 'chart', title: 'Tools used (24h)', source: 'agent-events',
        // Sorted through a variable: a path that starts with [...] runs once per input event.
        transform:
          '( $calls := $[kind = "tool.post" or kind = "tool.fail"]{ tool.name: $count($) }; ' +
          '$rows := [$keys($calls).{ "tool": $, "calls": $lookup($calls, $) }]; [$rows^(>calls)[[0..11]]] )',
        props: {
          option: {
            grid: { left: 150, right: 24, top: 12, bottom: 24 },
            xAxis: { type: 'value' },
            yAxis: { type: 'category', inverse: true },
            series: [{ type: 'bar', encode: { x: 'calls', y: 'tool' } }],
          },
        },
        layout: { near: 'agent-sessions', side: 'right', w: 420, h: 300 },
      },
    },
    {
      op: 'node.upsert',
      node: {
        id: 'agent-timeline', type: 'log', title: 'Timeline', source: 'agent-events',
        transform:
          '[$.( time & "  " & (agent = "codex" ? "codex " : "claude") & "  " & $substring(session, 0, 8) & "  " & kind' +
          ' & (tool ? "  " & tool.name & (tool.summary ? "  " & tool.summary : "") & (tool.ok = false ? "  (failed)" : "") : "")' +
          ' & (reason ? "  " & reason : "") & (detail ? "  " & detail : "") )]',
        props: { maxLines: 400 },
        layout: { near: 'agent-sessions', side: 'below', w: 1200, h: 320 },
      },
    },
  ],
} satisfies ApplyRequestInput;
