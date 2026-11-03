import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ApplyRequestInput, ApplyResult, CanvasView, DryRunResult, SourceState,
} from '@exprything/schema';

const DEFAULT_PORT = 7717;

function home(): string {
  return process.env.EXPRYTHING_HOME ?? join(homedir(), '.exprything');
}

export interface ConnectOptions {
  /** Called when no daemon answers; should start one in the background. */
  start?: () => void;
  timeoutMs?: number;
}

/** Thin HTTP client for exprythingd. The CLI and the MCP server are both built on it. */
export class ExpClient {
  constructor(readonly baseUrl: string, private token: string) {}

  static async connect(opts: ConnectOptions = {}): Promise<ExpClient> {
    const port = Number(process.env.EXPRYTHING_PORT ?? readDaemonPort() ?? DEFAULT_PORT);
    const baseUrl = `http://127.0.0.1:${port}`;
    if (!(await isUp(baseUrl))) {
      if (!opts.start) throw new Error(`exprything daemon is not running on ${baseUrl}. Start it with \`exp daemon start\`.`);
      opts.start();
      const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
      while (!(await isUp(baseUrl))) {
        if (Date.now() > deadline) throw new Error(`daemon did not start; see ${join(home(), 'daemon.log')}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const tokenFile = join(home(), 'token');
    return new ExpClient(baseUrl, readFileSync(tokenFile, 'utf8').trim());
  }

  canvasUrl(canvas = 'main'): string {
    return `${this.baseUrl}/#/c/${canvas}?token=${this.token}`;
  }

  apply(req: ApplyRequestInput & { dryRun: true }): Promise<DryRunResult>;
  apply(req: ApplyRequestInput): Promise<ApplyResult>;
  apply(req: ApplyRequestInput): Promise<ApplyResult | DryRunResult> {
    return this.call('POST', '/api/apply', req);
  }

  canvases(): Promise<{ id: string; title: string; nodes: number; updatedAt: string }[]> {
    return this.call('GET', '/api/canvases');
  }

  canvas(id: string): Promise<CanvasView> {
    return this.call('GET', `/api/canvases/${encodeURIComponent(id)}`);
  }

  deleteCanvas(id: string): Promise<unknown> {
    return this.call('DELETE', `/api/canvases/${encodeURIComponent(id)}`);
  }

  sources(): Promise<unknown[]> {
    return this.call('GET', '/api/sources');
  }

  push(source: string, data: unknown, mode: 'append' | 'replace' = 'append'): Promise<SourceState> {
    return this.call('POST', `/api/sources/${encodeURIComponent(source)}/push`, { data, mode });
  }

  refresh(source: string): Promise<SourceState> {
    return this.call('POST', `/api/sources/${encodeURIComponent(source)}/refresh`);
  }

  approve(source: string): Promise<unknown> {
    return this.call('POST', `/api/sources/${encodeURIComponent(source)}/approve`);
  }

  status(): Promise<{ sources: SourceState[]; repairs: unknown[]; needsApproval: string[] }> {
    return this.call('GET', '/api/status');
  }

  catalog(): Promise<{ guide: string; widgets: Record<string, unknown>; sources: unknown }> {
    return this.call('GET', '/api/catalog');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? `${method} ${path} failed with ${res.status}`);
    return json as T;
  }
}

function readDaemonPort(): number | undefined {
  const f = join(home(), 'daemon.json');
  if (!existsSync(f)) return undefined;
  try {
    return (JSON.parse(readFileSync(f, 'utf8')) as { port: number }).port;
  } catch {
    return undefined;
  }
}

async function isUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}
