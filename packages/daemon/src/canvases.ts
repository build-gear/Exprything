import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { widgetCatalog, type Canvas, type CanvasDrawing, type CanvasNode, type StoredNode } from '@exprything/schema';
import { paths, readJson, writeJsonAtomic } from './paths.ts';

const GAP = 24;
const MAX_ROW_WIDTH = 1600;

/** Canvases are plain JSON files so they are easy to inspect, diff and back up. */
export class CanvasStore {
  private canvases = new Map<string, Canvas>();

  constructor() {
    for (const f of readdirSync(paths.canvases).filter((f) => f.endsWith('.json'))) {
      const c = readJson<Canvas | null>(join(paths.canvases, f), null);
      if (c) this.canvases.set(c.id, c);
    }
  }

  list(): Canvas[] {
    return [...this.canvases.values()];
  }

  get(id: string): Canvas | undefined {
    return this.canvases.get(id);
  }

  ensure(id: string, title?: string): Canvas {
    let c = this.canvases.get(id);
    if (!c) {
      c = { id, title: title ?? id, nodes: [], updatedAt: new Date().toISOString() };
      this.canvases.set(id, c);
    } else if (title) c.title = title;
    return c;
  }

  delete(id: string): void {
    this.canvases.delete(id);
    rmSync(join(paths.canvases, `${id}.json`), { force: true });
    rmSync(join(paths.drawings, `${id}.json`), { force: true });
  }

  /** Kept in its own file: it can hold image data and is not needed for every view refresh. */
  getDrawing(id: string): CanvasDrawing {
    return readJson<CanvasDrawing>(join(paths.drawings, `${id}.json`), { elements: [], files: {} });
  }

  saveDrawing(id: string, drawing: CanvasDrawing): void {
    writeJsonAtomic(join(paths.drawings, `${id}.json`), drawing);
  }

  save(c: Canvas): void {
    c.updatedAt = new Date().toISOString();
    writeJsonAtomic(join(paths.canvases, `${c.id}.json`), c);
  }

  /** Upsert keeps the user's layout decisions: pinned nodes never move or resize from agent updates. */
  upsertNode(c: Canvas, node: CanvasNode): StoredNode {
    const idx = c.nodes.findIndex((n) => n.id === node.id);
    const prev = idx >= 0 ? c.nodes[idx] : undefined;
    const others = c.nodes.filter((n) => n.id !== node.id);
    const size = widgetCatalog[node.type].defaultSize;
    const l = node.layout ?? {};

    let w = l.w ?? prev?.w ?? size.w;
    let h = l.h ?? prev?.h ?? size.h;
    let x: number;
    let y: number;
    if (prev?.pinned) {
      ({ x, y, w, h } = prev);
    } else if (l.x !== undefined && l.y !== undefined) {
      ({ x, y } = l);
    } else if (prev) {
      ({ x, y } = prev);
    } else {
      ({ x, y } = place(others, w, h, l.near ? others.find((n) => n.id === l.near) : undefined, l.side));
    }

    const stored: StoredNode = { ...node, x, y, w, h, pinned: prev?.pinned ?? false };
    if (idx >= 0) c.nodes[idx] = stored;
    else c.nodes.push(stored);
    return stored;
  }

  deleteNode(c: Canvas, id: string): void {
    c.nodes = c.nodes.filter((n) => n.id !== id);
  }

  /** A human moved or resized a node: pin it. */
  moveNode(c: Canvas, id: string, rect: Partial<Pick<StoredNode, 'x' | 'y' | 'w' | 'h'>>): StoredNode {
    const n = c.nodes.find((n) => n.id === id);
    if (!n) throw new Error(`unknown node: ${id}`);
    Object.assign(n, rect, { pinned: true });
    return n;
  }
}

type Rect = { x: number; y: number; w: number; h: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

function place(others: Rect[], w: number, h: number, near?: Rect, side?: 'right' | 'below'): { x: number; y: number } {
  const free = (r: Rect) => !others.some((o) => overlaps(r, o));
  if (near) {
    const start = side === 'below' ? { x: near.x, y: near.y + near.h + GAP } : { x: near.x + near.w + GAP, y: near.y };
    for (let dy = 0; dy < 4000; dy += GAP) {
      const r = { ...start, y: start.y + dy, w, h };
      if (free(r)) return r;
    }
  }
  // Reading order: fill rows left to right, then go down.
  for (let y = 0; y < 20_000; y += GAP) {
    for (let x = 0; x + w <= MAX_ROW_WIDTH; x += GAP) {
      if (free({ x, y, w, h })) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, ...others.map((o) => o.y + o.h + GAP)) };
}
