import { CaptureUpdateAction, Excalidraw, THEME, newElementWith, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import {
  createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import type { CanvasDrawing, CanvasView, NodeStyle, NodeView } from '@exprything/schema';
import { CanvasCtx } from './context.ts';
import { SourceSummary } from './SourceSummary.tsx';
import { frameDiff, frameOf, frameOfElement, resolveLook, sameFrame, type Frame, type Look } from './style.ts';
import { WidgetCard } from './WidgetCard.tsx';
import { useDark } from './widgets/index.tsx';

/*
 * Excalidraw renderer (spike). Each widget node is projected into the scene as an `embeddable`
 * element with id `node:<nodeId>` and drawn by renderEmbeddable as ordinary React. The daemon owns
 * widget geometry; a person's move or resize is sent back and pins the node. Every other element is
 * the person's drawing and is saved as a whole to /api/canvases/:id/drawing.
 */

const ID_PREFIX = 'node:';
const LINK_PREFIX = 'exprything:node/';
const SAVE_DELAY_MS = 800;
const SYNC_DELAY_MS = 250;
/** Gap between an element and Excalidraw's selection border, in screen px (DEFAULT_TRANSFORM_HANDLE_SPACING * 2). */
const SELECTION_PADDING = 4;

type Rect = { x: number; y: number; w: number; h: number };

const ViewsCtx = createContext<Map<string, NodeView>>(new Map());
const CanvasStyleCtx = createContext<NodeStyle | undefined>(undefined);

/**
 * Which widget the pointer is over and which one is selected. Embeds let the pointer through to
 * the canvas, so CSS :hover never fires on them; the canvas tells us instead. The hover outline
 * follows `hovered`; each widget subscribes to its own `active` flag, so a change re-renders only
 * the widgets it affects.
 */
class WidgetUiStore {
  hovered: string | null = null;
  active: string | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setHovered(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.listeners.forEach((l) => l());
  }

  setActive(id: string | null) {
    if (id === this.active) return;
    this.active = id;
    this.listeners.forEach((l) => l());
  }
}

const UiCtx = createContext<WidgetUiStore>(new WidgetUiStore());

const langCode = navigator.language.toLowerCase().startsWith('ko') ? 'ko-KR' : 'en';
const uiOptions = { canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } };

function nodeIdOfElementId(id: string): string | undefined {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : undefined;
}

function widgetNodeId(el: ExcalidrawElement): string | undefined {
  return nodeIdOfElementId(el.id);
}

/** The topmost widget under a scene point. */
function widgetAt(elements: readonly ExcalidrawElement[], x: number, y: number): string | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const id = widgetNodeId(el);
    if (id && x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height) return id;
  }
  return null;
}

/** Any embed pointing at a widget, including copies a person made of one. */
function isWidgetEmbed(el: ExcalidrawElement): boolean {
  return el.type === 'embeddable' && (el.link ?? '').startsWith(LINK_PREFIX);
}

/** Widget elements are projections of nodes, never part of the saved drawing. */
const isWidgetElement = (el: ExcalidrawElement) => widgetNodeId(el) !== undefined || isWidgetEmbed(el);

const rectOfNode = (n: NodeView): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });
const rectOfElement = (el: ExcalidrawElement): Rect => ({
  x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height),
});
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const geometry = (r: Rect) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

function widgetElement(n: NodeView, look: Look): ExcalidrawElement {
  const partial = {
    type: 'embeddable',
    id: `${ID_PREFIX}${n.id}`,
    ...geometry(rectOfNode(n)),
    link: `${LINK_PREFIX}${n.id}`,
    customData: { exprything: { node: n.id } },
    // Excalidraw draws the frame from these, exactly like one of its own shapes.
    ...frameOf(look),
  };
  // The skeleton API does not normalize embeddables in 0.18.1; restore fills in the defaults.
  return restoreElements([partial as unknown as ExcalidrawElement], null)[0];
}

/**
 * Arrows a person bound to a widget are saved with the drawing, but the widget element is rebuilt
 * from its node every time. Restore the widget's side of the binding so the arrows follow it.
 */
function withArrowBindings(widget: ExcalidrawElement, scene: readonly ExcalidrawElement[]): ExcalidrawElement {
  const arrows = scene.filter((el) => el.type === 'arrow' && !el.isDeleted
    && (el.startBinding?.elementId === widget.id || el.endBinding?.elementId === widget.id));
  return arrows.length ? { ...widget, boundElements: arrows.map((a) => ({ id: a.id, type: 'arrow' as const })) } : widget;
}

type Delta = { dx: number; dy: number };

/**
 * Excalidraw re-routes bound arrows only during its own drag and resize handling, not when we move
 * a widget through updateScene. Shift the bound ends by the widget's movement so arrows stay attached.
 */
function followMovedWidgets(arrow: ExcalidrawElement, moved: Map<string, Delta>): ExcalidrawElement {
  if (arrow.type !== 'arrow' || arrow.isDeleted) return arrow;
  const start = arrow.startBinding && moved.get(arrow.startBinding.elementId);
  const end = arrow.endBinding && moved.get(arrow.endBinding.elementId);
  if (!start && !end) return arrow;
  const abs = arrow.points.map(([px, py]) => [arrow.x + px, arrow.y + py]);
  if (start) abs[0] = [abs[0][0] + start.dx, abs[0][1] + start.dy];
  if (end) abs[abs.length - 1] = [abs[abs.length - 1][0] + end.dx, abs[abs.length - 1][1] + end.dy];
  const [ox, oy] = abs[0];
  const points = abs.map(([px, py]) => [px - ox, py - oy]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return newElementWith(arrow, {
    x: ox,
    y: oy,
    points: points as unknown as typeof arrow.points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  });
}

/** Changes whenever a drawing element is added, edited or deleted. */
function drawingSignature(elements: readonly ExcalidrawElement[]): string {
  const own = elements.filter((el) => !isWidgetElement(el));
  return `${own.length}:${own.reduce((sum, el) => sum + el.version, 0)}`;
}

export function DrawCanvas({ view, title }: { view: CanvasView | null; title: string }) {
  const { api, canvas } = useContext(CanvasCtx);
  const dark = useDark();
  const [ui] = useState(() => new WidgetUiStore());
  const widgetSelected = useSyncExternalStore(ui.subscribe, () => ui.active !== null);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initial, setInitial] = useState<{ elements: ExcalidrawElement[]; files: BinaryFiles } | null>(null);

  const nodes = useMemo(() => new Map((view?.nodes ?? []).map((n) => [n.id, n])), [view]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const canvasStyle = view?.canvas.style;
  const canvasStyleRef = useRef(canvasStyle);
  canvasStyleRef.current = canvasStyle;
  const lookOf = useCallback((n: NodeView) => resolveLook(canvasStyleRef.current, n.style), []);
  /** Frame last received from the daemon; an element whose frame differs was restyled by the person. */
  const appliedFrame = useRef(new Map<string, Frame>());
  /** Geometry last received from the daemon. A widget whose element differs from it was edited by the person. */
  const applied = useRef(new Map<string, Rect>());
  const pointerDown = useRef(false);
  const projectionPending = useRef(false);
  const savedSignature = useRef('');
  const pendingSave = useRef<CanvasDrawing | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const syncTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api.drawing(canvas).then((d) => {
      if (cancelled) return;
      const drawing = d.elements as unknown as ExcalidrawElement[];
      savedSignature.current = drawingSignature(drawing);
      const widgets = [...nodesRef.current.values()].map((n) => {
        const look = lookOf(n);
        applied.current.set(n.id, rectOfNode(n));
        appliedFrame.current.set(n.id, frameOf(look));
        return withArrowBindings(widgetElement(n, look), drawing);
      });
      setInitial({ elements: [...drawing, ...widgets], files: d.files as unknown as BinaryFiles });
    });
    return () => { cancelled = true; };
  }, [api, canvas]);

  /** Bring widget elements in line with the daemon: add, remove, and apply agents' moves and restyles. */
  const project = useCallback(() => {
    if (!excalidraw) return;
    if (pointerDown.current) {
      // Never pull an element out from under a drag; catch up on pointer up.
      projectionPending.current = true;
      return;
    }
    const current = nodesRef.current;
    const seen = new Set<string>();
    const moved = new Map<string, Delta>();
    let changed = false;
    let next: ExcalidrawElement[] = excalidraw.getSceneElementsIncludingDeleted().map((el) => {
      const id = widgetNodeId(el);
      if (!id) return el;
      seen.add(id);
      const n = current.get(id);
      if (!n) {
        applied.current.delete(id);
        appliedFrame.current.delete(id);
        if (el.isDeleted) return el;
        changed = true;
        return newElementWith(el, { isDeleted: true });
      }
      const target = rectOfNode(n);
      const frame = frameOf(lookOf(n));
      const lastRect = applied.current.get(id);
      const lastFrame = appliedFrame.current.get(id);
      applied.current.set(id, target);
      appliedFrame.current.set(id, frame);
      if (el.isDeleted) {
        changed = true;
        return newElementWith(el, { ...geometry(target), ...frame, isDeleted: false });
      }
      // Only what changed on the daemon side is applied; anything else keeps the person's local edit.
      const moveIt = !(lastRect && sameRect(lastRect, target)) && !sameRect(rectOfElement(el), target);
      const restyleIt = !(lastFrame && sameFrame(lastFrame, frame)) && !sameFrame(frameOfElement(el), frame);
      if (!moveIt && !restyleIt) return el;
      changed = true;
      if (moveIt) {
        // Move bound arrow ends with the widget's centre (exact for moves, close enough for resizes).
        moved.set(el.id, {
          dx: target.x + target.w / 2 - (el.x + el.width / 2),
          dy: target.y + target.h / 2 - (el.y + el.height / 2),
        });
      }
      return newElementWith(el, { ...(moveIt && geometry(target)), ...(restyleIt && frame) });
    });
    if (moved.size) next = next.map((el) => followMovedWidgets(el, moved));
    for (const n of current.values()) {
      if (seen.has(n.id)) continue;
      const look = lookOf(n);
      applied.current.set(n.id, rectOfNode(n));
      appliedFrame.current.set(n.id, frameOf(look));
      next.push(withArrowBindings(widgetElement(n, look), next));
      changed = true;
    }
    // NEVER keeps agent-driven changes out of the person's undo history.
    if (changed) excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }, [excalidraw, lookOf]);

  useEffect(() => { project(); }, [project, nodes]);

  /** Send the person's widget moves and resizes to the daemon, and undo edits widgets cannot take. */
  const syncWidgets = useCallback(() => {
    if (!excalidraw || pointerDown.current) return;
    const current = nodesRef.current;
    let toast = '';
    const next: ExcalidrawElement[] = excalidraw.getSceneElementsIncludingDeleted().map((el) => {
      const id = widgetNodeId(el);
      if (!id) {
        if (!isWidgetEmbed(el) || el.isDeleted) return el;
        toast = 'Widgets cannot be copied. Ask the agent for another one.';
        return newElementWith(el, { isDeleted: true });
      }
      if (!current.has(id)) return el;
      if (el.isDeleted) {
        toast = 'Widgets belong to agent recipes. Remove them through the agent or `exp apply`.';
        return newElementWith(el, { isDeleted: false });
      }
      if (el.link !== `${LINK_PREFIX}${id}`) {
        toast = 'A widget\'s link cannot be changed.';
        return newElementWith(el, { link: `${LINK_PREFIX}${id}` });
      }
      const rect = rectOfElement(el);
      const last = applied.current.get(id);
      if (last && !sameRect(rect, last)) {
        applied.current.set(id, rect);
        void api.moveNode(canvas, id, rect);
      }
      // Restyled from Excalidraw's style panel: the changed fields become the node's, pinned.
      const frame = frameOfElement(el);
      const lastFrame = appliedFrame.current.get(id);
      if (lastFrame && !sameFrame(frame, lastFrame)) {
        appliedFrame.current.set(id, frame);
        void api.restyleNode(canvas, id, frameDiff(lastFrame, frame));
      }
      return el;
    });
    if (toast) {
      excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
      excalidraw.setToast({ message: toast, duration: 4000 });
    }
  }, [excalidraw, api, canvas]);

  const flushSave = useCallback((keepalive = false) => {
    clearTimeout(saveTimer.current);
    const drawing = pendingSave.current;
    if (!drawing) return;
    pendingSave.current = null;
    api.saveDrawing(canvas, drawing, keepalive).catch(() => { savedSignature.current = ''; });
  }, [api, canvas]);

  useEffect(() => {
    const onHide = () => flushSave(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushSave();
    };
  }, [flushSave]);

  const hostRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);

  /**
   * Preview Excalidraw's selection border on the widget under the pointer: same place, width and
   * color, at 20% (styles.css). Once the widget is selected Excalidraw draws the real one.
   */
  const placeOutline = useCallback(() => {
    const box = outlineRef.current;
    if (!box) return;
    const id = ui.hovered;
    const el = excalidraw && id && id !== ui.active && !pointerDown.current
      ? excalidraw.getSceneElements().find((e) => e.id === `${ID_PREFIX}${id}`)
      : undefined;
    if (!excalidraw || !el) {
      box.style.display = 'none';
      return;
    }
    const { scrollX, scrollY, zoom } = excalidraw.getAppState();
    // Excalidraw strokes a 1px line centred on the padded rectangle; this box's border sits just inside it.
    const pad = SELECTION_PADDING + 0.5;
    Object.assign(box.style, {
      display: 'block',
      left: `${(el.x + scrollX) * zoom.value - pad}px`,
      top: `${(el.y + scrollY) * zoom.value - pad}px`,
      width: `${el.width * zoom.value + pad * 2}px`,
      height: `${el.height * zoom.value + pad * 2}px`,
      transform: el.angle ? `rotate(${el.angle}rad)` : '',
    });
    const root = hostRef.current?.querySelector('.excalidraw');
    if (root) box.style.borderColor = getComputedStyle(root).getPropertyValue('--color-selection');
  }, [excalidraw, ui]);

  useEffect(() => ui.subscribe(placeOutline), [ui, placeOutline]);

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    // Clicking a widget selects it; a widget selected on its own takes wheel and pointer input.
    const selected = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
    ui.setActive(selected.length === 1 ? nodeIdOfElementId(selected[0]) ?? null : null);
    placeOutline(); // panned, zoomed or moved

    clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(syncWidgets, SYNC_DELAY_MS);

    const signature = drawingSignature(elements);
    if (signature === savedSignature.current) return;
    savedSignature.current = signature;
    const live = elements.filter((el) => !isWidgetElement(el) && !el.isDeleted);
    const fileIds = new Set<string>(live.flatMap((el) => (el.type === 'image' && el.fileId ? [el.fileId] : [])));
    pendingSave.current = {
      elements: live as unknown as Record<string, unknown>[],
      files: Object.fromEntries(Object.entries(files).filter(([id]) => fileIds.has(id))),
    };
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flushSave(), SAVE_DELAY_MS);
  }, [ui, placeOutline, syncWidgets, flushSave]);

  const onPointerUpdate = useCallback(({ pointer }: { pointer: { x: number; y: number } }) => {
    if (excalidraw) ui.setHovered(widgetAt(excalidraw.getSceneElements(), pointer.x, pointer.y));
  }, [excalidraw, ui]);

  const onPointerDown = useCallback(() => {
    pointerDown.current = true;
    placeOutline();
  }, [placeOutline]);
  const onPointerUp = useCallback(() => {
    pointerDown.current = false;
    // Let Excalidraw finish the gesture before reading positions.
    window.setTimeout(() => {
      if (projectionPending.current) {
        projectionPending.current = false;
        project();
      }
      syncWidgets();
      placeOutline();
    }, 0);
  }, [project, syncWidgets, placeOutline]);

  const renderEmbeddable = useCallback((el: NonDeleted<ExcalidrawEmbeddableElement>) => {
    const id = (el.customData?.exprything as { node?: string } | undefined)?.node ?? widgetNodeId(el);
    return id ? <EmbeddedWidget nodeId={id} /> : null;
  }, []);

  const initialData = useMemo(
    () => initial && { elements: initial.elements, files: initial.files, scrollToContent: true },
    [initial],
  );

  if (!initialData) return <div className="empty">Loading canvas…</div>;

  return (
    <ViewsCtx.Provider value={nodes}>
      <CanvasStyleCtx.Provider value={canvasStyle}>
        <UiCtx.Provider value={ui}>
          <div
            ref={hostRef}
            className={widgetSelected ? 'draw-host widget-selected' : 'draw-host'}
            onPointerLeave={() => ui.setHovered(null)}
          >
            <Excalidraw
              excalidrawAPI={setExcalidraw}
              initialData={initialData}
              onChange={onChange}
              onPointerUpdate={onPointerUpdate}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              renderEmbeddable={renderEmbeddable}
              validateEmbeddable={validateEmbeddable}
              onLinkOpen={onLinkOpen}
              renderTopRightUI={renderTopRightUI}
              theme={dark ? THEME.DARK : THEME.LIGHT}
              langCode={langCode}
              name={title}
              UIOptions={uiOptions}
            />
            <div ref={outlineRef} className="hover-outline" aria-hidden />
          </div>
        </UiCtx.Provider>
      </CanvasStyleCtx.Provider>
    </ViewsCtx.Provider>
  );
}

/** Only our own widget links may embed; external sites stay out of a local-first canvas. */
const validateEmbeddable = (link: string) => link.startsWith('exprything:');

/** The link icon Excalidraw draws on every widget must not try to open our internal scheme. */
const onLinkOpen = (el: NonDeleted<ExcalidrawElement>, event: CustomEvent) => {
  if (el.link?.startsWith('exprything:')) event.preventDefault();
};

/** Source health in Excalidraw's top-right slot. Reads nodes from context so the prop stays stable. */
const renderTopRightUI = () => <CanvasSources />;

function CanvasSources() {
  const nodes = useContext(ViewsCtx);
  return <SourceSummary nodes={[...nodes.values()]} />;
}

const EmbeddedWidget = memo(function EmbeddedWidget({ nodeId }: { nodeId: string }) {
  const view = useContext(ViewsCtx).get(nodeId);
  const canvasStyle = useContext(CanvasStyleCtx);
  const ui = useContext(UiCtx);
  const active = useSyncExternalStore(ui.subscribe, () => ui.active === nodeId);
  const look = useMemo(() => resolveLook(canvasStyle, view?.style), [canvasStyle, view?.style]);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Non-passive, so a wheel the widget cannot use can be cancelled here and handed to the canvas.
    const onWheel = (e: WheelEvent) => passUnusedWheel(e, el);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return <div ref={host} className="wn-embed">{view && <WidgetCard view={view} look={look} active={active} />}</div>;
});

/**
 * A selected widget takes the wheel, but only what it can use: once nothing under the pointer can
 * scroll further that way (a chart, a short table, the end of a log), the wheel goes on to the canvas,
 * as nested scrolling does in a page. Pinch and Ctrl/Cmd+wheel always zoom the canvas. Excalidraw
 * only pans for wheel events aimed at its canvas, so the event is re-sent there.
 */
function passUnusedWheel(e: WheelEvent, container: HTMLElement) {
  const zoom = e.ctrlKey || e.metaKey;
  if (!zoom && canScroll(e.target as Element, container, e.deltaX, e.deltaY)) return;
  const canvas = container.closest('.excalidraw')?.querySelector<HTMLCanvasElement>('canvas.interactive');
  if (!canvas) return;
  e.preventDefault();
  e.stopPropagation();
  canvas.dispatchEvent(new WheelEvent('wheel', {
    deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
    clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
    bubbles: true, cancelable: true,
  }));
}

/** Whether an element between `from` and `container` can still scroll in the wheel's direction. */
function canScroll(from: Element | null, container: Element, dx: number, dy: number): boolean {
  for (let el = from; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (dy !== 0 && /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
      if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
    }
    if (dx !== 0 && /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth) {
      if (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
    }
    if (el === container) break;
  }
  return false;
}
