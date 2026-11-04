import { randomBytes, randomInt } from 'node:crypto';
import type { AgentTarget, Drawing, NodeStyle, SelectedDrawing, StoredNode } from '@exprything/schema';

/*
 * Agents changing what is drawn on a canvas. Elements are Excalidraw's own, so a person and an agent edit
 * the same thing. The page fills in what is left out here when it loads them (restoreElements), so this
 * writes only what Excalidraw needs to place and draw an element, and how it binds to others.
 */

/** An Excalidraw element as saved in a drawing: these fields, and whatever else Excalidraw keeps on it. */
export interface DrawnElement extends Record<string, unknown> {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  boundElements?: { id: string; type: string }[] | null;
  containerId?: string | null;
  startBinding?: Binding | null;
  endBinding?: Binding | null;
  points?: [number, number][];
  text?: string;
  fontSize?: number;
  lineHeight?: number;
}

interface Binding { elementId: string; focus: number; gap: number }
type Box = { x: number; y: number; w: number; h: number };
type Delta = { dx: number; dy: number };

const NODE_PREFIX = 'node:';
const LABEL_SUFFIX = '-label';
const DEFAULT_SIZE = { w: 200, h: 100 };
const DEFAULT_FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
/** Space kept around a label inside its shape, and between an arrow's end and what it binds to. */
const PADDING = 20;
const ARROW_GAP = 8;
/** How far below what is on the canvas an element goes when no position is given. */
const STACK_GAP = 40;
/** Excalidraw's font ids and roundness types. */
const FONTS = { hand: 5, normal: 6, code: 8 } as const;
const ROUND = { adaptive: 3, proportional: 2 } as const;

const isLinear = (type?: string) => type === 'arrow' || type === 'line';

/** A change to one drawing, worked out in full before anything is saved. */
export class DrawingEdit {
  private elements: Map<string, DrawnElement>;
  private nodes: Map<string, StoredNode>;
  private written = new Set<string>();
  private gone = new Set<string>();
  /** Where each change lands, for the agent's cursor and the lock. */
  private places = new Map<string, Box>();

  constructor(elements: DrawnElement[], nodes: StoredNode[]) {
    this.elements = new Map(elements.map((el) => [el.id, el]));
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
  }

  get result(): DrawnElement[] {
    return [...this.elements.values()];
  }

  /** What changed, for pages that have the canvas open. */
  get change(): { elements: DrawnElement[]; removed: string[] } {
    return {
      elements: [...this.written].flatMap((id) => this.elements.get(id) ?? []),
      removed: [...this.gone],
    };
  }

  get targets(): AgentTarget[] {
    return [...this.places].map(([node, { x, y, w, h }]) => ({ node, x, y, w, h }));
  }

  upsert(d: Drawing): void {
    if (d.id.startsWith(NODE_PREFIX)) throw new Error(`${d.id} is a widget; change it with node.upsert`);
    const prev = this.elements.get(d.id);
    if (!prev) this.create(d);
    else this.update(prev, d);
    this.places.set(d.id, boxOf(this.must(d.id)));
  }

  delete(id: string): void {
    if (id.startsWith(NODE_PREFIX)) throw new Error(`${id} is a widget; remove it with node.delete`);
    const el = this.must(id);
    this.places.set(id, boxOf(el));
    this.remove(id);
    const label = labelOf(el);
    if (label) this.remove(label);
    // A label leaves its shape's list; an arrow leaves the lists of what it joined.
    if (el.containerId) this.unlist(el.containerId, id);
    for (const b of [el.startBinding, el.endBinding]) if (b) this.unlist(b.elementId, id);
    for (const other of this.elements.values()) {
      const start = other.startBinding?.elementId === id;
      const end = other.endBinding?.elementId === id;
      if (start || end) this.write({ ...other, ...(start && { startBinding: null }), ...(end && { endBinding: null }) });
    }
  }

  private create(d: Drawing): void {
    if (!d.type) throw new Error(`no drawing ${d.id}; give a type to create it`);
    if (isLinear(d.type)) return this.createLine(d);
    if (d.type === 'text') {
      const fontSize = d.fontSize ?? DEFAULT_FONT_SIZE;
      const size = textSize(d.text ?? '', fontSize);
      this.write(textElement(d.id, d.text ?? '', this.place(d), size, fontSize, d.style));
      return;
    }
    // A shape grows to hold its label, as Excalidraw's own does.
    const label = d.text ? textSize(d.text, d.fontSize ?? DEFAULT_FONT_SIZE) : { w: 0, h: 0 };
    const size = {
      w: d.width ?? Math.max(DEFAULT_SIZE.w, label.w + 2 * PADDING),
      h: d.height ?? Math.max(DEFAULT_SIZE.h, label.h + 2 * PADDING),
    };
    this.write({
      ...base(d.id, d.type, { ...this.place(d), ...size }),
      roundness: d.type === 'rectangle' ? { type: ROUND.adaptive } : d.type === 'diamond' ? { type: ROUND.proportional } : null,
      ...shapeStyle(d.style, d.type),
    });
    if (d.text) this.setLabel(this.must(d.id), d.text, d.fontSize, d.style);
  }

  private createLine(d: Drawing): void {
    const type = d.type!;
    const joined = !!d.from && !!d.to;
    if (!joined && !d.points && (d.width === undefined || d.height === undefined)) {
      throw new Error(`${type} ${d.id} needs both from and to, or points, or a width and height`);
    }
    this.write({
      ...base(d.id, type, { ...(joined ? { x: 0, y: 0 } : this.place(d)), w: 0, h: 0 }),
      roundness: { type: ROUND.proportional },
      points: d.points ? asPoints(d.points) : [[0, 0], [d.width ?? 0, d.height ?? 0]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: type === 'arrow' ? 'arrow' : null,
      elbowed: false,
      ...shapeStyle(d.style, type),
    });
    const line = this.must(d.id);
    this.write(joined ? this.route(line, d.from, d.to) : fitted(line, line.points!));
    if (d.text) this.setLabel(this.must(d.id), d.text, d.fontSize, d.style);
  }

  private update(prev: DrawnElement, d: Drawing): void {
    if (d.type && d.type !== prev.type) throw new Error(`${d.id} is of type ${prev.type}, not ${d.type}; delete it and make a new one`);
    let el: DrawnElement = {
      ...prev,
      ...(d.x !== undefined && { x: d.x }),
      ...(d.y !== undefined && { y: d.y }),
      ...(d.width !== undefined && { width: d.width }),
      ...(d.height !== undefined && { height: d.height }),
      ...shapeStyle(d.style, prev.type),
    };
    if (d.points && isLinear(prev.type)) el = fitted(el, asPoints(d.points));
    if (d.from !== undefined || d.to !== undefined) {
      if (!isLinear(prev.type)) throw new Error(`${d.id} is a ${prev.type}; only arrows and lines have from and to`);
      el = this.route(el, d.from ?? prev.startBinding?.elementId, d.to ?? prev.endBinding?.elementId);
    }
    if (prev.type === 'text') el = this.retext(el, d);
    this.write(el);
    this.follow(prev, this.must(d.id));
    if (prev.type !== 'text' && d.text !== undefined) this.setLabel(this.must(d.id), d.text, d.fontSize, d.style);
  }

  /** A text element's new words or size. A label keeps its centre, other text its top left. */
  private retext(el: DrawnElement, d: Drawing): DrawnElement {
    if (d.text === undefined && d.fontSize === undefined) return el;
    const text = d.text ?? el.text ?? '';
    const fontSize = d.fontSize ?? el.fontSize ?? DEFAULT_FONT_SIZE;
    const size = textSize(text, fontSize);
    return {
      ...el,
      text,
      originalText: text,
      fontSize,
      width: size.w,
      height: size.h,
      ...(el.containerId && { x: el.x + (el.width - size.w) / 2, y: el.y + (el.height - size.h) / 2 }),
    };
  }

  /** The element's label moves with it, and arrows bound to it follow its centre, as they do for a moved widget. */
  private follow(prev: DrawnElement, el: DrawnElement): void {
    const delta = { dx: centre(el).x - centre(prev).x, dy: centre(el).y - centre(prev).y };
    if (!delta.dx && !delta.dy) return;
    const label = labelOf(el);
    const text = label && this.elements.get(label);
    if (text) this.write({ ...text, x: text.x + delta.dx, y: text.y + delta.dy });
    for (const other of this.elements.values()) {
      const start = other.startBinding?.elementId === el.id;
      const end = other.endBinding?.elementId === el.id;
      if (!start && !end) continue;
      this.write(shiftEnds(other, start ? delta : undefined, end ? delta : undefined));
      const moved = this.must(other.id);
      const lineLabel = labelOf(moved);
      const words = lineLabel && this.elements.get(lineLabel);
      if (words) this.write({ ...words, x: centre(moved).x - words.width / 2, y: centre(moved).y - words.height / 2 });
    }
  }

  private setLabel(el: DrawnElement, text: string, fontSize: number | undefined, style?: NodeStyle): void {
    const id = labelOf(el);
    const label = id ? this.elements.get(id) : undefined;
    if (!text) {
      if (label) this.remove(label.id);
      if (id) this.unlist(el.id, id);
      return;
    }
    const size = textSize(text, fontSize ?? label?.fontSize ?? DEFAULT_FONT_SIZE);
    const mid = centre(el);
    const at = { x: mid.x - size.w / 2, y: mid.y - size.h / 2 };
    if (label) {
      this.write({ ...label, ...at, text, originalText: text, width: size.w, height: size.h, ...(fontSize && { fontSize }) });
      return;
    }
    const labelId = `${el.id}${LABEL_SUFFIX}`;
    this.write({
      ...textElement(labelId, text, at, size, fontSize ?? DEFAULT_FONT_SIZE, style),
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: el.id,
    });
    this.write({ ...el, boundElements: [...(el.boundElements ?? []), { id: labelId, type: 'text' }] });
  }

  /** A straight arrow or line between what it joins, from edge to edge, bound to both. */
  private route(line: DrawnElement, from?: string, to?: string): DrawnElement {
    const a = from ? this.box(from) : undefined;
    const b = to ? this.box(to) : undefined;
    const last = line.points?.at(-1) ?? [0, 0];
    const oldStart = { x: line.x, y: line.y };
    const oldEnd = { x: line.x + last[0], y: line.y + last[1] };
    const start = a ? edge(a, b ? mid(b) : oldEnd) : oldStart;
    const end = b ? edge(b, a ? mid(a) : oldStart) : oldEnd;
    for (const [prev, next] of [[line.startBinding?.elementId, from], [line.endBinding?.elementId, to]] as const) {
      if (prev && prev !== next && prev !== from && prev !== to) this.unlist(prev, line.id);
    }
    for (const id of [from, to]) if (id) this.list(id, line.id);
    const binding = (elementId?: string): Binding | null => (elementId ? { elementId, focus: 0, gap: ARROW_GAP } : null);
    return {
      ...fitted({ ...line, x: start.x, y: start.y }, [[0, 0], [end.x - start.x, end.y - start.y]]),
      startBinding: binding(from),
      endBinding: binding(to),
    };
  }

  /** The element, or the widget, something is bound to. Widgets keep their side of a binding in the page. */
  private box(id: string): Box {
    if (id.startsWith(NODE_PREFIX)) {
      const n = this.nodes.get(id.slice(NODE_PREFIX.length));
      if (!n) throw new Error(`no widget ${id}`);
      return n;
    }
    return boxOf(this.must(id));
  }

  /** Below what is on the canvas, unless the drawing says where. */
  private place(d: Drawing): { x: number; y: number } {
    const boxes = [...this.nodes.values(), ...this.result.map(boxOf)];
    return {
      x: d.x ?? Math.min(0, ...boxes.map((b) => b.x)),
      y: d.y ?? (boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) + STACK_GAP : 0),
    };
  }

  private must(id: string): DrawnElement {
    const el = this.elements.get(id);
    if (!el) throw new Error(`no drawing ${id}`);
    return el;
  }

  private write(el: DrawnElement): void {
    const prev = this.elements.get(el.id);
    this.elements.set(el.id, prev ? { ...el, version: prev.version + 1, versionNonce: nonce(), updated: Date.now() } : el);
    this.written.add(el.id);
    this.gone.delete(el.id);
  }

  private remove(id: string): void {
    this.elements.delete(id);
    this.written.delete(id);
    this.gone.add(id);
  }

  /** Records a line on what it joins. Widgets are rebuilt in the page, so they keep no list here. */
  private list(id: string, line: string): void {
    if (id.startsWith(NODE_PREFIX)) return;
    const el = this.must(id);
    if (el.boundElements?.some((b) => b.id === line)) return;
    this.write({ ...el, boundElements: [...(el.boundElements ?? []), { id: line, type: 'arrow' }] });
  }

  private unlist(id: string, bound: string): void {
    const el = this.elements.get(id);
    if (!el?.boundElements?.some((b) => b.id === bound)) return;
    const rest = el.boundElements.filter((b) => b.id !== bound);
    this.write({ ...el, boundElements: rest.length ? rest : null });
  }
}

/** A drawing as agents read it: the same summary as a selection, with each label on its shape. */
export function summarize(elements: DrawnElement[]): SelectedDrawing[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  return elements.filter((el) => !el.containerId).map((el) => {
    const label = labelOf(el);
    const text = el.type === 'text' ? el.text : label ? byId.get(label)?.text : undefined;
    return {
      id: el.id,
      type: el.type,
      x: Math.round(el.x),
      y: Math.round(el.y),
      width: Math.round(el.width),
      height: Math.round(el.height),
      ...(text && { text }),
      ...(typeof el.link === 'string' && { link: el.link }),
      ...(el.startBinding && { from: el.startBinding.elementId }),
      ...(el.endBinding && { to: el.endBinding.elementId }),
    };
  });
}

const nonce = () => randomInt(2 ** 31);
const labelOf = (el: DrawnElement) => el.boundElements?.find((b) => b.type === 'text')?.id;
const mid = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where an element is. A line starts at x and y and can run left or up from there. */
function boxOf(el: DrawnElement): Box {
  if (!el.points) return { x: el.x, y: el.y, w: el.width, h: el.height };
  const xs = el.points.map((p) => el.x + p[0]);
  const ys = el.points.map((p) => el.y + p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

const centre = (el: DrawnElement) => mid(boxOf(el));

function base(id: string, type: string, box: Box): DrawnElement {
  return {
    id,
    type,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function textElement(id: string, text: string, at: { x: number; y: number }, size: { w: number; h: number }, fontSize: number, style?: NodeStyle): DrawnElement {
  return {
    ...base(id, 'text', { ...at, ...size }),
    text,
    originalText: text,
    fontSize,
    fontFamily: FONTS.hand,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
    ...shapeStyle(style, 'text'),
  };
}

/** The NodeStyle vocabulary as element fields; only what the element can use. */
function shapeStyle(style: NodeStyle | undefined, type: string): Record<string, unknown> {
  if (!style) return {};
  const { roundness, fontFamily, backgroundColor, ...rest } = style;
  return {
    ...rest,
    ...(backgroundColor && type !== 'text' && { backgroundColor }),
    ...(roundness && type !== 'text' && {
      roundness: roundness === 'round' ? { type: type === 'rectangle' ? ROUND.adaptive : ROUND.proportional } : null,
    }),
    ...(fontFamily && type === 'text' && { fontFamily: FONTS[fontFamily] }),
  };
}

/**
 * The page measures text properly, but a drawing can be written with no page open, and Excalidraw clips text
 * to its width. So this errs wide: too wide only makes the selection box larger.
 */
function textSize(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split('\n');
  const em = (line: string) => [...line].reduce((sum, ch) => sum + (ch.codePointAt(0)! > 0x2e7f ? 1.1 : 0.7), 0);
  return { w: Math.ceil(Math.max(...lines.map(em)) * fontSize), h: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}

/** Where the line from a box's centre towards a point leaves the box, with the gap arrows keep. */
function edge(b: Box, to: { x: number; y: number }): { x: number; y: number } {
  const c = mid(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const scale = 1 / Math.max(Math.abs(dx) / (b.w / 2 + ARROW_GAP), Math.abs(dy) / (b.h / 2 + ARROW_GAP));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** The element with these points, moved so the first is its origin, sized to hold them all. */
function fitted(el: DrawnElement, points: [number, number][]): DrawnElement {
  const [ox, oy] = points[0];
  const relative = points.map(([x, y]): [number, number] => [x - ox, y - oy]);
  const xs = relative.map((p) => p[0]);
  const ys = relative.map((p) => p[1]);
  return {
    ...el,
    x: el.x + ox,
    y: el.y + oy,
    points: relative,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

const asPoints = (points: number[][]) => points.map(([x, y]): [number, number] => [x, y]);

function shiftEnds(line: DrawnElement, start?: Delta, end?: Delta): DrawnElement {
  const points = (line.points ?? [[0, 0]]).map(([x, y]): [number, number] => [x, y]);
  const last = points.length - 1;
  if (start) points[0] = [points[0][0] + start.dx, points[0][1] + start.dy];
  if (end) points[last] = [points[last][0] + end.dx, points[last][1] + end.dy];
  return fitted(line, points);
}
