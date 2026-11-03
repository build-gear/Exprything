import type {
  ApplyRequest, ApplyResult, CanvasView, DryRunResult, NodeView, Source, StoredNode,
} from '@exprything/schema';
import { CanvasStore } from './canvases.ts';
import { History } from './history.ts';
import { ensureHome, paths } from './paths.ts';
import { applyTransform, runSource } from './runner.ts';
import { SourceManager } from './sources.ts';

const SAMPLE_LIMIT = 2_000;

export class Engine {
  readonly history: History;
  readonly sources: SourceManager;
  readonly canvases: CanvasStore;

  constructor(private notify: (msg: { canvas?: string; source?: string }) => void, private baseUrl: () => string) {
    ensureHome();
    this.history = new History(paths.history);
    this.canvases = new CanvasStore();
    this.sources = new SourceManager(this.history, (source) => this.notify({ source }));
  }

  start(): void {
    this.sources.start();
  }

  stop(): void {
    this.sources.stop();
  }

  apply(req: ApplyRequest): ApplyResult {
    this.checkReferences(req);
    const canvas = this.canvases.ensure(req.canvas, req.title);
    const needsApproval: string[] = [];
    for (const op of req.ops) {
      switch (op.op) {
        case 'source.upsert':
          this.sources.upsert(op.source);
          if (this.sources.needsApproval(op.source)) needsApproval.push(op.source.id);
          break;
        case 'source.delete':
          this.sources.delete(op.id);
          break;
        case 'node.upsert':
          this.canvases.upsertNode(canvas, op.node);
          break;
        case 'node.delete':
          this.canvases.deleteNode(canvas, op.id);
          break;
      }
    }
    this.canvases.save(canvas);
    this.notify({ canvas: canvas.id });
    return { canvas: canvas.id, applied: req.ops.length, needsApproval, url: `${this.baseUrl()}/#/c/${canvas.id}` };
  }

  /**
   * Runs every source the ops touch (or that touched nodes read) exactly once and renders the
   * touched nodes, without saving anything. This is how an agent verifies a recipe before leaving.
   */
  async dryRun(req: ApplyRequest): Promise<DryRunResult> {
    this.checkReferences(req);
    const pending = new Map<string, Source>();
    for (const op of req.ops) if (op.op === 'source.upsert') pending.set(op.source.id, op.source);

    const values = new Map<string, { ok: boolean; value?: unknown; error?: string }>();
    const evalSource = async (id: string) => {
      if (values.has(id)) return values.get(id)!;
      const src = pending.get(id) ?? this.sources.get(id);
      let res: { ok: boolean; value?: unknown; error?: string };
      if (!src) res = { ok: false, error: `unknown source: ${id}` };
      else if (!pending.has(id)) res = { ok: true, value: this.sources.value(id) };
      else {
        try {
          res = { ok: true, value: await runSource(src, src.kind === 'push' ? [] : undefined) };
        } catch (e) {
          res = { ok: false, error: (e as Error).message };
        }
      }
      values.set(id, res);
      return res;
    };

    const result: DryRunResult = { ok: true, sources: [], nodes: [] };
    for (const id of pending.keys()) {
      const r = await evalSource(id);
      result.sources.push({ id, ok: r.ok, sample: r.ok ? truncate(r.value) : undefined, error: r.error });
    }
    for (const op of req.ops) {
      if (op.op !== 'node.upsert') continue;
      const node = op.node;
      try {
        let input: unknown;
        if (node.source) {
          const s = await evalSource(node.source);
          if (!s.ok) throw new Error(`source ${node.source}: ${s.error}`);
          input = node.use === 'history'
            ? [...this.sources.series(node.source, 50), { ts: new Date().toISOString(), value: s.value }]
            : s.value;
        }
        const data = await applyTransform(node.transform, input);
        result.nodes.push({ id: node.id, ok: true, sample: truncate(data) });
      } catch (e) {
        result.nodes.push({ id: node.id, ok: false, error: (e as Error).message });
      }
    }
    result.ok = [...result.sources, ...result.nodes].every((x) => x.ok);
    return result;
  }

  async view(canvasId: string): Promise<CanvasView | undefined> {
    const c = this.canvases.get(canvasId);
    if (!c) return undefined;
    const nodes = await Promise.all(c.nodes.map((n) => this.nodeView(n)));
    return { canvas: { id: c.id, title: c.title, updatedAt: c.updatedAt }, nodes };
  }

  private async nodeView(n: StoredNode): Promise<NodeView> {
    const sourceState = n.source ? this.sources.state(n.source) : undefined;
    if (n.source && !sourceState) return { ...n, error: `unknown source: ${n.source}` };
    try {
      const input = !n.source
        ? undefined
        : n.use === 'history'
          ? this.sources.series(n.source, Number(n.props.historyLimit ?? 500))
          : this.sources.value(n.source);
      const data = n.source && input === undefined ? undefined : await applyTransform(n.transform, input);
      return { ...n, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)), sourceState };
    } catch (e) {
      return { ...n, error: (e as Error).message, sourceState };
    }
  }

  private checkReferences(req: ApplyRequest): void {
    const declared = new Set(req.ops.flatMap((o) => (o.op === 'source.upsert' ? [o.source.id] : [])));
    for (const op of req.ops) {
      if (op.op === 'node.upsert' && op.node.source && !declared.has(op.node.source) && !this.sources.get(op.node.source)) {
        throw new Error(`node ${op.node.id} references unknown source ${op.node.source}`);
      }
    }
  }

  repairs() {
    return this.sources
      .list()
      .map((s) => ({ source: s, state: this.sources.state(s.id) }))
      .filter((x) => x.state?.status === 'error' || x.state?.status === 'stale')
      .map((x) => ({
        id: x.source.id,
        status: x.state!.status,
        error: x.state!.lastError,
        failures: x.state!.failures,
        lastGoodValue: truncate(this.sources.value(x.source.id)),
        recipe: x.source,
      }));
  }
}

function truncate(v: unknown): unknown {
  if (Array.isArray(v) && v.length > 20) return [...v.slice(0, 20), `… ${v.length - 20} more items`];
  const s = JSON.stringify(v);
  if (s && s.length > SAMPLE_LIMIT) return `${s.slice(0, SAMPLE_LIMIT)}… (truncated)`;
  return v;
}
