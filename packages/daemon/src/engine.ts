import {
  ApplyRequest, activityCanvas,
  type AgentEvent, type AgentTarget, type ApplyResult, type Canvas, type CanvasView, type DryRunResult, type NodeView, type Op,
  type SelectedDrawing, type Source, type StoredNode,
} from '@exprything/schema';
import { ActivityLog } from './activity.ts';
import { CanvasStore } from './canvases.ts';
import { DrawingEdit, summarize, type DrawnElement } from './drawings.ts';
import { History } from './history.ts';
import { ensureHome, paths } from './paths.ts';
import { applyTransform, runSource } from './runner.ts';
import { SourceManager } from './sources.ts';

const SAMPLE_LIMIT = 2_000;

export class Engine {
  readonly history: History;
  readonly activity: ActivityLog;
  readonly sources: SourceManager;
  readonly canvases: CanvasStore;

  constructor(
    private notify: (msg: { canvas?: string; source?: string }) => void,
    private baseUrl: () => string,
    private drawingChanged: (canvas: string, change: DrawingEdit['change']) => void,
  ) {
    ensureHome();
    this.history = new History(paths.history);
    this.activity = new ActivityLog(paths.history);
    this.canvases = new CanvasStore();
    this.sources = new SourceManager(this.history, this.activity, (source) => this.notify({ source }));
  }

  start(): void {
    this.activity.replaySpool();
    this.sources.start();
  }

  /** Events from agents' hooks (`exp hook`), and any the spool kept while the daemon was down. */
  recordAgentEvents(events: AgentEvent[]): number {
    const n = this.activity.add(events) + this.activity.replaySpool();
    if (n) this.sources.activityChanged();
    return n;
  }

  /** Sets up the agent-activity canvas, unless it is already there (a person may have changed it). */
  ensureActivityCanvas(): string {
    if (!this.canvases.get(activityCanvas.canvas)) this.apply(ApplyRequest.parse(activityCanvas));
    return `${this.baseUrl()}/#/c/${activityCanvas.canvas}`;
  }

  stop(): void {
    this.sources.stop();
  }

  /** Tell connected UIs a canvas changed outside apply, e.g. a person moved a node. */
  touch(canvasId: string): void {
    this.notify({ canvas: canvasId });
  }

  apply(req: ApplyRequest): ApplyResult {
    this.checkReferences(req);
    // Worked out first: a drawing that cannot be made stops the request before anything changes.
    const drawing = this.drawingEdit(req);
    const canvas = this.canvases.ensure(req.canvas, req.title);
    if (req.style) canvas.style = Object.keys(req.style).length ? req.style : undefined;
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
    if (drawing) {
      this.canvases.saveDrawing(canvas.id, { ...this.canvases.getDrawing(canvas.id), elements: drawing.result });
      this.drawingChanged(canvas.id, drawing.change);
    }
    this.notify({ canvas: canvas.id });
    return { canvas: canvas.id, applied: req.ops.length, needsApproval, url: `${this.baseUrl()}/#/c/${canvas.id}` };
  }

  /**
   * What a request will change on its canvas and where, without saving anything: the nodes it writes
   * or removes, the nodes reading a source it writes, every node when it sets the canvas style, and
   * the drawings it writes or removes.
   */
  targets(req: ApplyRequest): AgentTarget[] {
    const { draft, nodes, sources } = this.simulate(req);
    for (const n of draft.nodes) {
      if (!nodes.has(n.id) && (req.style || (n.source && sources.has(n.source)))) nodes.set(n.id, n);
    }
    let drawings: AgentTarget[] = [];
    try {
      drawings = this.drawingEdit(req)?.targets ?? [];
    } catch {
      // The request itself fails on this, and says why.
    }
    return [...[...nodes.values()].map(({ id, x, y, w, h }) => ({ node: id, x, y, w, h })), ...drawings];
  }

  /** The canvas as the request's node and source ops leave it, without saving anything. */
  private simulate(req: ApplyRequest) {
    const nodes = new Map<string, StoredNode>();
    const sources = new Set<string>();
    const draft: Canvas = { id: req.canvas, title: req.canvas, nodes: [...(this.canvases.get(req.canvas)?.nodes ?? [])], updatedAt: '' };
    for (const op of req.ops) {
      if (op.op === 'node.upsert') {
        nodes.set(op.node.id, this.canvases.upsertNode(draft, op.node));
      } else if (op.op === 'node.delete') {
        const gone = draft.nodes.find((n) => n.id === op.id);
        if (gone) nodes.set(gone.id, gone);
        this.canvases.deleteNode(draft, op.id);
      } else if (op.op === 'source.upsert') {
        sources.add(op.source.id);
      } else if (op.op === 'source.delete') {
        sources.add(op.id);
      }
    }
    return { draft, nodes, sources };
  }

  /** The request's drawing ops worked out in full, against the widgets it leaves on the canvas. */
  private drawingEdit(req: ApplyRequest): DrawingEdit | undefined {
    const ops = req.ops.filter(isDrawingOp);
    if (!ops.length) return undefined;
    const edit = this.newDrawingEdit(req);
    for (const op of ops) runDrawingOp(edit, op);
    return edit;
  }

  private newDrawingEdit(req: ApplyRequest): DrawingEdit {
    return new DrawingEdit(this.canvases.getDrawing(req.canvas).elements as DrawnElement[], this.simulate(req).draft.nodes);
  }

  /** What is drawn on a canvas, as agents read it. */
  drawings(canvas: string): SelectedDrawing[] {
    return summarize(this.canvases.getDrawing(canvas).elements as DrawnElement[]);
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
          res = { ok: true, value: await runSource(src, src.kind === 'push' ? [] : this.sources.input(src)) };
        } catch (e) {
          res = { ok: false, error: (e as Error).message };
        }
      }
      values.set(id, res);
      return res;
    };

    const result: DryRunResult = { ok: true, sources: [], nodes: [], drawings: [] };
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
    const drawing = this.newDrawingEdit(req);
    for (const op of req.ops.filter(isDrawingOp)) {
      const id = op.op === 'drawing.upsert' ? op.drawing.id : op.id;
      try {
        runDrawingOp(drawing, op);
        result.drawings.push({ id, ok: true });
      } catch (e) {
        result.drawings.push({ id, ok: false, error: (e as Error).message });
      }
    }
    result.ok = [...result.sources, ...result.nodes, ...result.drawings].every((x) => x.ok);
    return result;
  }

  async view(canvasId: string): Promise<CanvasView | undefined> {
    const c = this.canvases.get(canvasId);
    if (!c) return undefined;
    const nodes = await Promise.all(c.nodes.map((n) => this.nodeView(n)));
    return { canvas: { id: c.id, title: c.title, updatedAt: c.updatedAt, style: c.style }, nodes };
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

type DrawingOp = Extract<Op, { op: 'drawing.upsert' | 'drawing.delete' }>;

const isDrawingOp = (op: Op): op is DrawingOp => op.op === 'drawing.upsert' || op.op === 'drawing.delete';

function runDrawingOp(edit: DrawingEdit, op: DrawingOp): void {
  if (op.op === 'drawing.upsert') edit.upsert(op.drawing);
  else edit.delete(op.id);
}

function truncate(v: unknown): unknown {
  if (Array.isArray(v) && v.length > 20) return [...v.slice(0, 20), `… ${v.length - 20} more items`];
  const s = JSON.stringify(v);
  if (s && s.length > SAMPLE_LIMIT) return `${s.slice(0, SAMPLE_LIMIT)}… (truncated)`;
  return v;
}
