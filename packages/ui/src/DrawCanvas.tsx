import { CaptureUpdateAction, Excalidraw, THEME, newElementWith, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasDrawing, CanvasView, NodeView } from '@exprything/schema';
import { CanvasCtx } from './context.ts';
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

type Rect = { x: number; y: number; w: number; h: number };

const ViewsCtx = createContext<Map<string, NodeView>>(new Map());

const langCode = navigator.language.toLowerCase().startsWith('ko') ? 'ko-KR' : 'en';
const uiOptions = { canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } };

function widgetNodeId(el: ExcalidrawElement): string | undefined {
  return el.id.startsWith(ID_PREFIX) ? el.id.slice(ID_PREFIX.length) : undefined;
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

function widgetElement(n: NodeView): ExcalidrawElement {
  const partial = {
    type: 'embeddable',
    id: `${ID_PREFIX}${n.id}`,
    ...geometry(rectOfNode(n)),
    link: `${LINK_PREFIX}${n.id}`,
    customData: { exprything: { node: n.id } },
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    strokeWidth: 1,
    roughness: 0,
    roundness: null,
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
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initial, setInitial] = useState<{ elements: ExcalidrawElement[]; files: BinaryFiles } | null>(null);

  const nodes = useMemo(() => new Map((view?.nodes ?? []).map((n) => [n.id, n])), [view]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
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
        applied.current.set(n.id, rectOfNode(n));
        return withArrowBindings(widgetElement(n), drawing);
      });
      setInitial({ elements: [...drawing, ...widgets], files: d.files as unknown as BinaryFiles });
    });
    return () => { cancelled = true; };
  }, [api, canvas]);

  /** Bring widget elements in line with the daemon: add, remove, and apply moves made by agents. */
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
        if (el.isDeleted) return el;
        changed = true;
        return newElementWith(el, { isDeleted: true });
      }
      const target = rectOfNode(n);
      const last = applied.current.get(id);
      applied.current.set(id, target);
      // Unchanged on the daemon side: keep whatever the person has done locally.
      if (!el.isDeleted && last && sameRect(last, target)) return el;
      if (!el.isDeleted && sameRect(rectOfElement(el), target)) return el;
      changed = true;
      if (!el.isDeleted) {
        // Move bound arrow ends with the widget's centre (exact for moves, close enough for resizes).
        moved.set(el.id, {
          dx: target.x + target.w / 2 - (el.x + el.width / 2),
          dy: target.y + target.h / 2 - (el.y + el.height / 2),
        });
      }
      return newElementWith(el, { ...geometry(target), isDeleted: false });
    });
    if (moved.size) next = next.map((el) => followMovedWidgets(el, moved));
    for (const n of current.values()) {
      if (seen.has(n.id)) continue;
      applied.current.set(n.id, rectOfNode(n));
      next.push(withArrowBindings(widgetElement(n), next));
      changed = true;
    }
    // NEVER keeps agent-driven changes out of the person's undo history.
    if (changed) excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }, [excalidraw]);

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

  const onChange = useCallback((elements: readonly ExcalidrawElement[], _appState: unknown, files: BinaryFiles) => {
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
  }, [syncWidgets, flushSave]);

  const onPointerDown = useCallback(() => { pointerDown.current = true; }, []);
  const onPointerUp = useCallback(() => {
    pointerDown.current = false;
    // Let Excalidraw finish the gesture before reading positions.
    window.setTimeout(() => {
      if (projectionPending.current) {
        projectionPending.current = false;
        project();
      }
      syncWidgets();
    }, 0);
  }, [project, syncWidgets]);

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
      <div className="draw-host">
        <Excalidraw
          excalidrawAPI={setExcalidraw}
          initialData={initialData}
          onChange={onChange}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          renderEmbeddable={renderEmbeddable}
          validateEmbeddable={validateEmbeddable}
          onLinkOpen={onLinkOpen}
          theme={dark ? THEME.DARK : THEME.LIGHT}
          langCode={langCode}
          name={title}
          UIOptions={uiOptions}
        />
      </div>
    </ViewsCtx.Provider>
  );
}

/** Only our own widget links may embed; external sites stay out of a local-first canvas. */
const validateEmbeddable = (link: string) => link.startsWith('exprything:');

/** The link icon Excalidraw draws on every widget must not try to open our internal scheme. */
const onLinkOpen = (el: NonDeleted<ExcalidrawElement>, event: CustomEvent) => {
  if (el.link?.startsWith('exprything:')) event.preventDefault();
};

const EmbeddedWidget = memo(function EmbeddedWidget({ nodeId }: { nodeId: string }) {
  const view = useContext(ViewsCtx).get(nodeId);
  return <div className="wn-embed">{view && <WidgetCard view={view} />}</div>;
});
