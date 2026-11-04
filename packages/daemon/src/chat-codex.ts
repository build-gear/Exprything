import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatItem } from '@exprything/schema';
import type { AgentHooks, AgentLaunch, AgentProcess } from './chats.ts';
import { canvasToolSummary, lastLine } from './chat-tools.ts';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;
type Json = any;

/**
 * Codex's app server, the JSON-RPC protocol its IDE extensions use: a thread per conversation, a turn
 * per message, and approvals as requests from the server that the person answers.
 */
export function startCodex(l: AgentLaunch, on: AgentHooks): AgentProcess {
  const child = spawn(l.cli.path, ['app-server'], { cwd: l.cwd, env: l.cli.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (msg: Json) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  };
  let nextId = 1;
  const calls = new Map<number, { resolve(v: Json): void; reject(e: Error): void }>();
  const call = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
    const id = nextId++;
    calls.set(id, { resolve, reject });
    write({ id, method, params });
  });
  const at = () => new Date().toISOString();
  const asks = new Map<string, { item: Item<'approval'>; rpc: number | string; method: string }>();
  /** The files a pending file change touches, by item, for its approval. */
  const changes = new Map<string, string>();
  let thread = l.session;
  let turn: string | undefined;
  let stderr = '';
  let ended = false;

  child.stdin.on('error', () => {}); // the process is gone; its exit says why
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4_000);
  });

  const ready = (async () => {
    await call('initialize', { clientInfo: { name: 'exprything', title: 'Exprything', version: '0.0.1' }, capabilities: null });
    write({ method: 'initialized' });
    const params = {
      cwd: l.cwd,
      developerInstructions: l.instructions,
      config: { mcp_servers: { exprything: { command: l.mcp.command, args: l.mcp.args } } },
    };
    // A thread Codex no longer has starts over.
    const res = thread ? await call('thread/resume', { threadId: thread, ...params }).catch(() => call('thread/start', params)) : await call('thread/start', params);
    thread = res.thread.id as string;
    on.session(thread);
  })();
  ready.catch(() => {}); // reported by send

  const toolState = (status: string): Item<'tool'>['state'] =>
    status === 'completed' ? 'done' : status === 'failed' || status === 'declined' ? 'failed' : 'running';

  /** A thread item as a chat item, when the sidebar shows that kind. */
  const fromItem = (it: Json): ChatItem | undefined => {
    switch (it.type) {
      case 'agentMessage':
        return { kind: 'assistant', id: it.id, text: it.text ?? '', at: at() };
      case 'commandExecution':
        return { kind: 'tool', id: it.id, name: 'Shell', summary: unwrapShell(it.command), state: toolState(it.status), at: at() };
      case 'fileChange': {
        const files = (it.changes ?? []).map((c: Json) => relative(l.cwd, c.path) || c.path).join(', ');
        changes.set(it.id, files);
        return { kind: 'tool', id: it.id, name: 'Edit', summary: files, state: toolState(it.status), at: at() };
      }
      case 'mcpToolCall': {
        const ours = it.server === 'exprything';
        const summary = ours ? canvasToolSummary(it.tool, it.arguments ?? {}) : undefined;
        return { kind: 'tool', id: it.id, name: ours ? it.tool : `${it.server}: ${it.tool}`, summary, state: toolState(it.status), at: at() };
      }
      case 'webSearch':
        return { kind: 'tool', id: it.id, name: 'Web search', summary: it.query, state: it.status ? toolState(it.status) : 'done', at: at() };
      default:
        return undefined;
    }
  };

  const ask = (m: Json, tool: string, summary?: string) => {
    const item: Item<'approval'> = { kind: 'approval', id: String(m.id), tool, summary, state: 'pending', at: at() };
    asks.set(item.id, { item, rpc: m.id, method: m.method });
    on.item(item);
    on.status('waiting');
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const pending = calls.get(m.id);
      calls.delete(m.id);
      if (m.error) pending?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else pending?.resolve(m.result);
      return;
    }
    const p = m.params ?? {};
    if (m.id !== undefined) {
      // The server asks something of the client.
      switch (m.method) {
        case 'item/commandExecution/requestApproval':
          return ask(m, 'Run a command', unwrapShell(p.command) ?? p.reason ?? undefined);
        case 'item/fileChange/requestApproval':
          return ask(m, 'Edit files', changes.get(p.itemId) ?? p.reason ?? undefined);
        case 'mcpServer/elicitation/request':
          // Its own canvas tools need no approval, as with Claude Code; the person sees them happen.
          if (p.serverName === 'exprything') return write({ id: m.id, result: { action: 'accept', content: {}, _meta: null } });
          return ask(m, p.serverName ?? 'MCP server', p.message);
        case 'item/tool/requestUserInput':
          return write({ id: m.id, result: { answers: {} } });
        default:
          return write({ id: m.id, error: { code: -32601, message: `Exprything does not answer ${m.method}` } });
      }
    }
    switch (m.method) {
      case 'turn/started':
        turn = p.turn?.id;
        on.status('working');
        break;
      case 'turn/completed':
        turn = undefined;
        if (p.turn?.status === 'failed') on.item({ kind: 'error', id: randomUUID(), text: p.turn.error?.message ?? 'The turn failed', at: at() });
        if (p.turn?.status === 'interrupted') on.item({ kind: 'notice', id: randomUUID(), text: 'Stopped.', at: at() });
        on.status('idle');
        break;
      case 'error':
        if (!p.willRetry) on.item({ kind: 'error', id: randomUUID(), text: p.error?.message ?? 'Codex reported an error', at: at() });
        break;
      case 'item/started':
      case 'item/completed': {
        const item = fromItem(p.item ?? {});
        if (item) on.item(item);
        break;
      }
      case 'item/agentMessage/delta':
        on.delta(p.itemId, p.delta);
        break;
    }
  });

  const exit = (error?: string) => {
    if (ended) return;
    ended = true;
    for (const pending of calls.values()) pending.reject(new Error('Codex stopped'));
    on.exit(error);
  };
  child.on('error', (e) => exit(e.message));
  child.on('exit', (code, signal) => exit(code && !signal ? lastLine(stderr) ?? `Codex stopped (exit code ${code})` : undefined));

  return {
    send(text) {
      ready
        .then(() => call('turn/start', { threadId: thread, input: [{ type: 'text', text, text_elements: [] }] }))
        .catch((e: Error) => {
          on.item({ kind: 'error', id: randomUUID(), text: e.message, at: at() });
          on.status('idle');
        });
    },
    answer(request, allow) {
      const a = asks.get(request);
      if (!a) return;
      asks.delete(request);
      const result = a.method === 'mcpServer/elicitation/request'
        ? { action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null }
        : { decision: allow ? 'accept' : 'decline' };
      write({ id: a.rpc, result });
      on.item({ ...a.item, state: allow ? 'allowed' : 'denied' });
      if (!asks.size) on.status('working');
    },
    interrupt() {
      if (thread && turn) call('turn/interrupt', { threadId: thread, turnId: turn }).catch(() => {});
    },
    close() {
      child.stdin.end();
      setTimeout(() => child.kill(), 2_000).unref();
    },
  };
}

/** `/bin/zsh -lc 'echo hi'` as `echo hi`: Codex runs every command through a login shell. */
function unwrapShell(command?: string): string | undefined {
  if (!command) return undefined;
  const inner = /^\S*sh -l?c '([\s\S]*)'$/.exec(command)?.[1];
  const shown = (inner ? inner.replace(/'\\''/g, "'") : command).trim().split('\n')[0];
  return shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
}
