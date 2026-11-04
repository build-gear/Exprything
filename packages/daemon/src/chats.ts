import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId, ChatItem, ChatStatus, ChatSummary, SelectionReport, ServerMessage } from '@exprything/schema';
import { agentCli, agentName, type Cli } from './agents.ts';
import { startClaude } from './chat-claude.ts';
import { startCodex } from './chat-codex.ts';
import { paths, readJson, writeJsonAtomic } from './paths.ts';
import { writeShim } from './shim.ts';

/** An agent left idle this long is stopped; the next message resumes its session. */
const IDLE_MS = 10 * 60_000;
const SAVE_DELAY_MS = 500;
const TITLE_MAX = 60;
/** How much of a selection goes along with a message. */
const SELECTION_MAX = 20;

/** What an agent reports while it runs. */
export interface AgentHooks {
  /** Add an item, or replace the one with its id. */
  item(item: ChatItem): void;
  /** Streamed text for an assistant item. */
  delta(item: string, text: string): void;
  status(status: ChatStatus): void;
  /** The agent's own id for the conversation (a Claude Code session, a Codex thread), to resume it later. */
  session(id: string): void;
  /** The process ended; with an error when it should not have. */
  exit(error?: string): void;
}

/** A running agent with one conversation. */
export interface AgentProcess {
  send(text: string): void;
  answer(request: string, allow: boolean): void;
  interrupt(): void;
  close(): void;
}

export interface AgentLaunch {
  cli: Cli;
  cwd: string;
  session?: string;
  instructions: string;
  /** Exprything's MCP server, given to the agent for this conversation only. */
  mcp: { command: string; args: string[] };
}

interface Chat extends ChatSummary {
  session?: string;
  items: ChatItem[];
}

const now = () => new Date().toISOString();

/**
 * The AI sidebar's conversations. The daemon runs each agent, so a conversation outlives the page that
 * started it, and keeps its items on disk. The agents run as the person's own CLI: their login, their
 * settings and permission rules, and they ask the person through the sidebar when those say to ask.
 */
export class Chats {
  private chats = new Map<string, Chat>();
  private running = new Map<string, { agent: AgentProcess; idle?: NodeJS.Timeout }>();
  private saves = new Map<string, NodeJS.Timeout>();

  constructor(private publish: (msg: ServerMessage) => void, private canvasTitle: (id: string) => string | undefined) {
    mkdirSync(paths.chats, { recursive: true });
    for (const f of readdirSync(paths.chats).filter((f) => f.endsWith('.json'))) {
      const chat = readJson<Chat | null>(join(paths.chats, f), null);
      // Nothing runs across a daemon restart.
      if (chat) this.chats.set(chat.id, { ...chat, status: 'idle', items: chat.items.map(settle) });
    }
  }

  list(canvas?: string): ChatSummary[] {
    return [...this.chats.values()]
      .filter((c) => !canvas || c.canvas === canvas)
      .map(summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): { chat: ChatSummary; items: ChatItem[] } | undefined {
    const chat = this.chats.get(id);
    return chat && { chat: summary(chat), items: chat.items };
  }

  create(agent: AgentId, canvas: string): ChatSummary {
    const at = now();
    const chat: Chat = { id: randomUUID(), agent, canvas, cwd: paths.workspace, title: '', status: 'idle', createdAt: at, updatedAt: at, items: [] };
    this.chats.set(chat.id, chat);
    this.changed(chat);
    return summary(chat);
  }

  async send(id: string, text: string, selection?: SelectionReport): Promise<void> {
    const chat = this.must(id);
    if (chat.status !== 'idle') throw new Error(`${agentName(chat.agent)} is still working on the last message`);
    const context = selection && describeSelection(selection);
    chat.title ||= text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
    this.upsert(chat, { kind: 'user', id: randomUUID(), text, at: now(), ...(context && { context: context.label }) });
    this.setStatus(chat, 'working');
    try {
      const agent = await this.start(chat);
      agent.send(context ? `${context.text}\n\n${text}` : text);
    } catch (e) {
      this.upsert(chat, { kind: 'error', id: randomUUID(), text: (e as Error).message, at: now() });
      this.setStatus(chat, 'idle');
    }
  }

  answer(id: string, request: string, allow: boolean): void {
    const run = this.running.get(this.must(id).id);
    if (!run) throw new Error('the agent is no longer running');
    run.agent.answer(request, allow);
  }

  stop(id: string): void {
    this.running.get(this.must(id).id)?.agent.interrupt();
  }

  shutdown(): void {
    for (const run of this.running.values()) run.agent.close();
  }

  /** A deleted canvas takes its conversations with it. The agents keep their own sessions. */
  removeCanvas(canvas: string): void {
    for (const chat of this.chats.values()) {
      if (chat.canvas !== canvas) continue;
      this.chats.delete(chat.id);
      this.running.get(chat.id)?.agent.close();
      clearTimeout(this.saves.get(chat.id));
      this.saves.delete(chat.id);
      rmSync(join(paths.chats, `${chat.id}.json`), { force: true });
    }
  }

  private async start(chat: Chat): Promise<AgentProcess> {
    const run = this.running.get(chat.id);
    if (run) {
      clearTimeout(run.idle);
      return run.agent;
    }
    const cli = await agentCli(chat.agent);
    if (!cli) throw new Error(`${agentName(chat.agent)} is not installed on this computer.`);
    if (!existsSync(paths.shim)) writeShim();
    let ended = false;
    const hooks: AgentHooks = {
      item: (item) => this.upsert(chat, item),
      delta: (item, text) => {
        const target = chat.items.find((i) => i.id === item);
        if (target?.kind === 'assistant') target.text += text;
        this.publish({ type: 'chat.delta', chat: chat.id, item, text });
      },
      status: (status) => {
        this.setStatus(chat, status);
        const live = this.running.get(chat.id);
        if (live && status === 'idle') {
          clearTimeout(live.idle);
          live.idle = setTimeout(() => live.agent.close(), IDLE_MS);
          live.idle.unref();
        }
      },
      session: (session) => {
        chat.session = session;
        this.save(chat);
      },
      exit: (error) => {
        if (ended) return;
        ended = true;
        this.running.delete(chat.id);
        for (const item of chat.items) if (isOpen(item)) this.upsert(chat, settle(item));
        if (error) this.upsert(chat, { kind: 'error', id: randomUUID(), text: error, at: now() });
        this.setStatus(chat, 'idle');
      },
    };
    const launch: AgentLaunch = {
      cli,
      cwd: chat.cwd,
      session: chat.session,
      instructions: instructionsFor(chat.canvas, this.canvasTitle(chat.canvas)),
      mcp: { command: paths.shim, args: ['mcp'] },
    };
    const agent = chat.agent === 'codex' ? startCodex(launch, hooks) : startClaude(launch, hooks);
    this.running.set(chat.id, { agent });
    return agent;
  }

  private must(id: string): Chat {
    const chat = this.chats.get(id);
    if (!chat) throw new Error(`no such chat: ${id}`);
    return chat;
  }

  private upsert(chat: Chat, item: ChatItem): void {
    const copy = { ...item };
    const at = chat.items.findIndex((i) => i.id === item.id);
    if (at >= 0) chat.items[at] = copy;
    else chat.items.push(copy);
    this.changed(chat, copy);
  }

  private setStatus(chat: Chat, status: ChatStatus): void {
    if (chat.status === status) return;
    chat.status = status;
    this.changed(chat);
  }

  private changed(chat: Chat, item?: ChatItem): void {
    chat.updatedAt = now();
    this.publish({ type: 'chat', chat: summary(chat), ...(item && { item }) });
    this.save(chat);
  }

  private save(chat: Chat): void {
    clearTimeout(this.saves.get(chat.id));
    this.saves.set(chat.id, setTimeout(() => {
      this.saves.delete(chat.id);
      // An agent closed with its canvas still reports back after the conversation is gone.
      if (this.chats.has(chat.id)) writeJsonAtomic(join(paths.chats, `${chat.id}.json`), chat);
    }, SAVE_DELAY_MS));
  }
}

function summary({ session: _, items: __, ...chat }: Chat): ChatSummary {
  return chat;
}

const isOpen = (item: ChatItem) => (item.kind === 'tool' && item.state === 'running') || (item.kind === 'approval' && item.state === 'pending');

/** An item that was in progress when its agent stopped. */
function settle(item: ChatItem): ChatItem {
  if (item.kind === 'tool' && item.state === 'running') return { ...item, state: 'failed' };
  if (item.kind === 'approval' && item.state === 'pending') return { ...item, state: 'cancelled' };
  return item;
}

function instructionsFor(canvas: string, title?: string): string {
  return [
    `You are running in the AI sidebar of Exprything, next to the canvas "${title ?? canvas}" (id "${canvas}"). The person has it open while they talk to you.`,
    `Read and draw on it with the exprything MCP tools, passing canvas "${canvas}" unless they name another one.`,
    'When they select something, their message starts with what was selected as they sent it. That is what they mean, even if the canvas has changed since, so act on it and do not check it with canvas_selection. Call canvas_selection only when they say "this" and the message names nothing.',
    `Your working folder, ${paths.workspace}, is Exprything's own: keep files you make there. It is not a project of theirs, so when they mention one, use the path they give you, or ask where it is.`,
    'They read your replies in a narrow sidebar, so keep them short.',
  ].join(' ');
}

/** What the person has selected, sent ahead of their message: a short label for them, a line for the agent. */
function describeSelection(sel: SelectionReport): { label: string; text: string } | undefined {
  const parts = [
    ...sel.nodes.map((n) => `widget "${n.title ?? n.id}" (node ${n.id}, ${n.type}${n.source ? `, source ${n.source}` : ''})`),
    ...sel.drawings.map((d) => `${d.type}${d.text ? ` "${d.text}"` : ''} (drawing ${d.id})`),
  ];
  if (!parts.length) return undefined;
  const only = sel.total === 1 && (sel.nodes[0]?.title ?? sel.nodes[0]?.id ?? sel.drawings[0]?.text ?? sel.drawings[0]?.type);
  const more = sel.total > SELECTION_MAX ? `, and ${sel.total - SELECTION_MAX} more` : '';
  return {
    label: only || `${sel.total} selected`,
    text: `[Selected on canvas "${sel.canvas}": ${parts.slice(0, SELECTION_MAX).join('; ')}${more}]`,
  };
}
