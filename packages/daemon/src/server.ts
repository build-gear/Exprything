import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  AgentEvent, AgentId, ApplyRequest, CanvasDrawing, Id, NodeStyle, SelectionReport, authoringGuide, stylePalette, widgetCatalog,
  type AgentIdentity, type CanvasSelection, type ServerMessage, type StoredNode,
} from '@exprything/schema';
import {
  AGENT_IDS, agentStatus, connectAgent, connectNewAgents, disconnectAgent, parseAgent, setAgentActivity,
} from './agents.ts';
import { Chats } from './chats.ts';
import { Engine } from './engine.ts';
import { DEFAULT_PORT, paths, readOrCreateToken } from './paths.ts';
import { Presence } from './presence.ts';

/** The built canvas UI: next to the sources in a checkout; the desktop app points at its own copy. */
const UI_DIST = process.env.EXPRYTHING_UI_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const VERSION = '0.0.1';

export interface DaemonInfo { port: number; pid: number; version: string }

export function startDaemon(port = Number(process.env.EXPRYTHING_PORT ?? DEFAULT_PORT)) {
  const token = readOrCreateToken();
  const sockets = new Set<WebSocket>();
  /** What each open canvas page last reported as selected, kept while its socket is connected. */
  const selections = new Map<WebSocket, CanvasSelection & { canvas: string; at: string }>();
  const baseUrl = () => `http://127.0.0.1:${port}`;
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
  };
  const engine = new Engine((msg) => broadcast({ type: 'changed', ...msg }), baseUrl);
  const presence = new Presence((agents) => broadcast({ type: 'presence', agents }));
  const chats = new Chats(broadcast, (id) => engine.canvases.get(id)?.title);
  const visit = (c: Context, canvas: string) => {
    const agent = agentOf(c);
    if (agent) presence.visit(agent, canvas);
  };

  const app = new Hono();

  // Reject DNS-rebinding attempts: only loopback Host headers are served.
  app.use('*', async (c, next) => {
    if (!ALLOWED_HOSTS.test(c.req.header('host') ?? '')) throw new HTTPException(403, { message: 'bad host' });
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, pid: process.pid }));

  app.use('/api/*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) throw new HTTPException(401, { message: 'bad token' });
    await next();
  });

  app.get('/api/canvases', (c) =>
    c.json(engine.canvases.list().map((cv) => ({ id: cv.id, title: cv.title, nodes: cv.nodes.length, updatedAt: cv.updatedAt }))),
  );

  app.get('/api/canvases/:id', async (c) => {
    const view = await engine.view(c.req.param('id'));
    if (!view) throw new HTTPException(404, { message: 'no such canvas' });
    visit(c, view.canvas.id);
    return c.json(view);
  });

  app.delete('/api/canvases/:id', (c) => {
    engine.canvases.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/apply', async (c) => {
    const req = parse(ApplyRequest, await c.req.json());
    const agent = agentOf(c);
    try {
      if (agent) presence[req.dryRun ? 'reserve' : 'applying'](agent, req.canvas, engine.targets(req));
      return c.json(req.dryRun ? await engine.dryRun(req) : engine.apply(req));
    } catch (e) {
      if (agent) presence.release(agent);
      throw new HTTPException(400, { message: (e as Error).message });
    }
  });

  app.patch('/api/canvases/:id/nodes/:node', async (c) => {
    const canvas = engine.canvases.get(c.req.param('id'));
    if (!canvas) throw new HTTPException(404, { message: 'no such canvas' });
    const { style, ...rect } = parse(
      z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), style: NodeStyle.partial() }).partial(),
      await c.req.json(),
    );
    const id = c.req.param('node');
    let node: StoredNode | undefined;
    try {
      // A person's edit on the canvas: geometry pins the node, style pins the changed fields.
      if (Object.keys(rect).length) node = engine.canvases.moveNode(canvas, id, rect);
      if (style) node = engine.canvases.restyleNode(canvas, id, style);
    } catch (e) {
      throw new HTTPException(404, { message: (e as Error).message });
    }
    engine.canvases.save(canvas);
    engine.touch(canvas.id);
    return c.json(node ?? null);
  });

  app.get('/api/canvases/:id/drawing', (c) => c.json(engine.canvases.getDrawing(parse(Id, c.req.param('id')))));

  app.put('/api/canvases/:id/drawing', async (c) => {
    const id = parse(Id, c.req.param('id'));
    const drawing = parse(CanvasDrawing, await c.req.json());
    // Drawing on a canvas no agent has touched yet creates it.
    if (!engine.canvases.get(id)) engine.canvases.save(engine.canvases.ensure(id));
    engine.canvases.saveDrawing(id, drawing);
    return c.json({ ok: true, elements: drawing.elements.length });
  });

  app.get('/api/sources', (c) =>
    c.json(engine.sources.list().map((s) => ({ ...s, state: engine.sources.state(s.id), needsApproval: engine.sources.needsApproval(s) }))),
  );

  app.post('/api/sources/:id/refresh', async (c) => {
    await wrap(() => engine.sources.refresh(c.req.param('id')));
    return c.json(engine.sources.state(c.req.param('id')));
  });

  app.post('/api/sources/:id/approve', async (c) => {
    await wrap(() => engine.sources.approve(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.post('/api/sources/:id/push', async (c) => {
    const body = parse(z.object({ data: z.unknown(), mode: z.enum(['append', 'replace']).default('append') }), await c.req.json());
    await wrap(() => engine.sources.push(c.req.param('id'), body.data, body.mode));
    return c.json(engine.sources.state(c.req.param('id')));
  });

  app.get('/api/sources/:id/history', (c) =>
    c.json(engine.sources.series(c.req.param('id'), Number(c.req.query('limit') ?? 500))),
  );

  app.get('/api/status', (c) =>
    c.json({
      sources: engine.sources.list().map((s) => engine.sources.state(s.id)),
      repairs: engine.repairs(),
      needsApproval: engine.sources.list().filter((s) => engine.sources.needsApproval(s)).map((s) => s.id),
    }),
  );

  app.get('/api/catalog', (c) => c.json(catalogJson()));

  // The most recent report wins: with no canvas named, that is the canvas the person used last.
  app.get('/api/selection', (c) => {
    const canvas = c.req.query('canvas');
    let latest: CanvasSelection & { at: string } | undefined;
    for (const s of selections.values()) {
      if ((!canvas || s.canvas === canvas) && (!latest || s.at > latest.at)) latest = s;
    }
    if (latest?.canvas) visit(c, latest.canvas);
    return c.json(latest ?? ({ canvas: canvas ?? null, open: false, nodes: [], drawings: [], total: 0 } satisfies CanvasSelection));
  });

  // Agents' hooks, through `exp hook`.
  app.post('/api/agent-events', async (c) => {
    const { events } = parse(z.object({ events: z.array(AgentEvent).max(1_000) }), await c.req.json());
    return c.json({ ok: true, stored: engine.recordAgentEvents(events) });
  });

  // Connecting Claude Code and Codex from the AI sidebar's settings: the same as `exp connect`.
  app.get('/api/agents', async (c) => c.json(await Promise.all(AGENT_IDS.map(agentStatus))));

  app.post('/api/agents/connect-new', async (c) => c.json({ connected: await connectNewAgents() }));

  app.post('/api/agents/:agent/connect', async (c) => {
    const { activity } = parse(z.object({ activity: z.boolean().optional() }), await c.req.json().catch(() => ({})));
    const status = await wrapValue(() => connectAgent(parseAgent(c.req.param('agent')), { activity }));
    return c.json({ ...status, activityCanvas: activity ? engine.ensureActivityCanvas() : undefined });
  });

  app.post('/api/agents/:agent/activity', async (c) => {
    const { on } = parse(z.object({ on: z.boolean() }), await c.req.json());
    const status = await wrapValue(() => setAgentActivity(parseAgent(c.req.param('agent')), on));
    return c.json({ ...status, activityCanvas: on ? engine.ensureActivityCanvas() : undefined });
  });

  app.post('/api/agents/:agent/disconnect', async (c) =>
    c.json(await wrapValue(() => disconnectAgent(parseAgent(c.req.param('agent'))))),
  );

  // The AI sidebar: conversations with Claude Code or Codex, which the daemon runs.
  app.get('/api/chats', (c) => c.json(chats.list(c.req.query('canvas'))));

  app.post('/api/chats', async (c) => {
    const { agent, canvas } = parse(z.object({ agent: AgentId, canvas: Id }), await c.req.json());
    return c.json(chats.create(agent, canvas));
  });

  app.get('/api/chats/:id', (c) => {
    const chat = chats.get(c.req.param('id'));
    if (!chat) throw new HTTPException(404, { message: 'no such chat' });
    return c.json(chat);
  });

  app.post('/api/chats/:id/messages', async (c) => {
    const { text, selection } = parse(
      z.object({ text: z.string().trim().min(1).max(100_000), selection: SelectionReport.optional() }),
      await c.req.json(),
    );
    await wrap(() => chats.send(c.req.param('id'), text, selection));
    return c.json({ ok: true });
  });

  app.post('/api/chats/:id/answers', async (c) => {
    const { request, allow } = parse(z.object({ request: z.string(), allow: z.boolean() }), await c.req.json());
    await wrap(() => chats.answer(c.req.param('id'), request, allow));
    return c.json({ ok: true });
  });

  app.post('/api/chats/:id/stop', async (c) => {
    await wrap(() => chats.stop(c.req.param('id')));
    return c.json({ ok: true });
  });

  if (existsSync(UI_DIST)) {
    app.use('/*', serveStatic({ root: UI_DIST }));
  } else {
    app.get('/', (c) => c.text('UI is not built. Run `pnpm build`, or `pnpm dev:ui` for development.'));
  }

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500;
    return c.json({ error: err.message }, status);
  });

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token || !ALLOWED_HOSTS.test(req.headers.host ?? '')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'presence', agents: presence.list() } satisfies ServerMessage));
      ws.on('message', (raw) => {
        const msg = SelectionReport.safeParse(parseJson(raw.toString()));
        if (!msg.success) return;
        const { type: _, ...report } = msg.data;
        selections.set(ws, { ...report, open: true, at: new Date().toISOString() });
      });
      ws.on('close', () => {
        sockets.delete(ws);
        selections.delete(ws);
      });
    });
  });

  engine.start();
  writeFileSync(paths.daemon, JSON.stringify({ port, pid: process.pid, version: VERSION } satisfies DaemonInfo));

  const shutdown = () => {
    chats.shutdown();
    engine.stop();
    rmSync(paths.daemon, { force: true });
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { port, url: baseUrl(), token };
}

export function catalogJson() {
  return {
    guide: authoringGuide,
    widgets: Object.fromEntries(
      Object.entries(widgetCatalog).map(([type, doc]) => [
        type,
        { description: doc.description, data: doc.data, defaultSize: doc.defaultSize, props: z.toJSONSchema(doc.props), example: doc.example },
      ]),
    ),
    style: { schema: z.toJSONSchema(NodeStyle), palette: stylePalette },
    sources: z.toJSONSchema(ApplyRequest, { io: 'input', unrepresentable: 'any' }),
  };
}

/** The agent behind a request (ExpClient.agent). The canvas page's own requests carry none. */
function agentOf(c: Context): AgentIdentity | undefined {
  const id = c.req.header('x-exprything-agent');
  return id ? { id, name: c.req.header('x-exprything-agent-name') ?? 'Agent' } : undefined;
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
  return r.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function wrapValue<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
}

async function wrap(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
}
