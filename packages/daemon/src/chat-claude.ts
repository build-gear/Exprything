import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ChatItem } from '@exprything/schema';
import type { AgentHooks, AgentLaunch, AgentProcess } from './chats.ts';
import { describeTool, lastLine } from './chat-tools.ts';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

/**
 * Claude Code in print mode, streaming JSON both ways, as the Agent SDK drives it: one process per
 * conversation, a message per turn, and permission prompts as control requests the person answers.
 */
export function startClaude(l: AgentLaunch, on: AgentHooks): AgentProcess {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--mcp-config', JSON.stringify({ mcpServers: { exprything: { type: 'stdio', ...l.mcp } } }),
    // Its own canvas tools need no approval; the person sees them happen.
    '--allowedTools', 'mcp__exprything',
    '--append-system-prompt', l.instructions,
    ...(l.session ? ['--resume', l.session] : []),
  ];
  const child = spawn(l.cli.path, args, { cwd: l.cwd, env: l.cli.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (msg: unknown) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const at = () => new Date().toISOString();
  const tools = new Map<string, Item<'tool'>>();
  const asks = new Map<string, { item: Item<'approval'>; input: unknown }>();
  /** Text blocks of the message being streamed, by block index. */
  const texts = new Map<number, Item<'assistant'>>();
  let message = '';
  let stderr = '';
  let ended = false;
  /** The person stopped the turn, so its error result is expected. */
  let stopping = false;

  child.stdin.on('error', () => {}); // the process is gone; its exit says why
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4_000);
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    // A subagent's own work stays inside its Task tool.
    if (m.parent_tool_use_id) return;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') on.session(m.session_id);
        break;
      case 'stream_event': {
        const e = m.event;
        if (e?.type === 'message_start') {
          message = e.message.id;
          texts.clear();
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'text') {
          const item: Item<'assistant'> = { kind: 'assistant', id: `${message}:${e.index}`, text: '', at: at() };
          texts.set(e.index, item);
          on.item(item);
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          const item = texts.get(e.index);
          if (item) {
            item.text += e.delta.text;
            on.delta(item.id, e.delta.text);
          }
        } else if (e?.type === 'content_block_stop') {
          const item = texts.get(e.index);
          if (item) on.item(item);
        }
        break;
      }
      case 'assistant':
        for (const b of m.message?.content ?? []) {
          // ToolSearch only loads other tools' definitions.
          if (b.type !== 'tool_use' || b.name === 'ToolSearch') continue;
          const item: Item<'tool'> = { kind: 'tool', id: b.id, ...describeTool(b.name, b.input ?? {}), state: 'running', at: at() };
          tools.set(b.id, item);
          on.item(item);
        }
        break;
      case 'user':
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
          const item = b.type === 'tool_result' && tools.get(b.tool_use_id);
          if (!item) continue;
          tools.delete(b.tool_use_id);
          on.item({ ...item, state: b.is_error ? 'failed' : 'done' });
        }
        break;
      case 'control_request': {
        const r = m.request;
        if (r?.subtype !== 'can_use_tool') {
          write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Exprything does not answer ${r?.subtype}` } });
          break;
        }
        const tool = describeTool(r.tool_name, r.input ?? {});
        const item: Item<'approval'> = {
          kind: 'approval', id: m.request_id, tool: r.display_name ?? tool.name, summary: r.description ?? tool.summary, state: 'pending', at: at(),
        };
        asks.set(m.request_id, { item, input: r.input });
        on.item(item);
        on.status('waiting');
        break;
      }
      case 'control_cancel_request': {
        const ask = asks.get(m.request_id);
        if (!ask) break;
        asks.delete(m.request_id);
        on.item({ ...ask.item, state: 'cancelled' });
        break;
      }
      case 'result':
        for (const [id, item] of tools) on.item({ ...item, state: 'failed' }), tools.delete(id);
        if (stopping) on.item({ kind: 'notice', id: m.uuid ?? randomUUID(), text: 'Stopped.', at: at() });
        else if (m.is_error) on.item({ kind: 'error', id: m.uuid ?? randomUUID(), text: String(m.result || m.subtype), at: at() });
        stopping = false;
        on.status('idle');
        break;
    }
  });

  const exit = (error?: string) => {
    if (ended) return;
    ended = true;
    on.exit(error);
  };
  child.on('error', (e) => exit(e.message));
  child.on('exit', (code, signal) => exit(code && !signal ? lastLine(stderr) ?? `Claude Code stopped (exit code ${code})` : undefined));

  return {
    send(text) {
      write({ type: 'user', message: { role: 'user', content: text } });
    },
    answer(request, allow) {
      const ask = asks.get(request);
      if (!ask) return;
      asks.delete(request);
      const response = allow
        ? { behavior: 'allow', updatedInput: ask.input }
        : { behavior: 'deny', message: 'The person declined this in Exprything.' };
      write({ type: 'control_response', response: { subtype: 'success', request_id: request, response } });
      on.item({ ...ask.item, state: allow ? 'allowed' : 'denied' });
      if (!asks.size) on.status('working');
    },
    interrupt() {
      stopping = true;
      write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    },
    close() {
      child.stdin.end();
      setTimeout(() => child.kill(), 2_000).unref();
    },
  };
}
