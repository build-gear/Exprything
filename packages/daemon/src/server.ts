import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { ApplyRequest, CanvasDrawing, Id, authoringGuide, widgetCatalog } from '@exprything/schema';
import { Engine } from './engine.ts';
import { DEFAULT_PORT, paths, readOrCreateToken } from './paths.ts';

const UI_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const VERSION = '0.0.1';

export interface DaemonInfo { port: number; pid: number; version: string }

export function startDaemon(port = Number(process.env.EXPRYTHING_PORT ?? DEFAULT_PORT)) {
  const token = readOrCreateToken();
  const sockets = new Set<WebSocket>();
  const baseUrl = () => `http://127.0.0.1:${port}`;
  const engine = new Engine((msg) => {
    const data = JSON.stringify({ type: 'changed', ...msg });
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
  }, baseUrl);

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
    return c.json(view);
  });

  app.delete('/api/canvases/:id', (c) => {
    engine.canvases.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/apply', async (c) => {
    const req = parse(ApplyRequest, await c.req.json());
    try {
      return c.json(req.dryRun ? await engine.dryRun(req) : engine.apply(req));
    } catch (e) {
      throw new HTTPException(400, { message: (e as Error).message });
    }
  });

  app.patch('/api/canvases/:id/nodes/:node', async (c) => {
    const canvas = engine.canvases.get(c.req.param('id'));
    if (!canvas) throw new HTTPException(404, { message: 'no such canvas' });
    const rect = parse(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).partial(), await c.req.json());
    const node = engine.canvases.moveNode(canvas, c.req.param('node'), rect);
    engine.canvases.save(canvas);
    engine.touch(canvas.id);
    return c.json(node);
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
      ws.on('close', () => sockets.delete(ws));
    });
  });

  engine.start();
  writeFileSync(paths.daemon, JSON.stringify({ port, pid: process.pid, version: VERSION } satisfies DaemonInfo));

  const shutdown = () => {
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
    sources: z.toJSONSchema(ApplyRequest, { io: 'input', unrepresentable: 'any' }),
  };
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
  return r.data;
}

async function wrap(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
}
