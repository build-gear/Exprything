import {
  CaptureUpdateAction, Excalidraw, THEME, newElementWith, restoreElements, viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import {
  createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import type {
  AgentPresence, AgentTarget, CanvasDrawing, CanvasView, NodeStyle, NodeView, SelectedDrawing, SelectionReport,
} from '@exprything/schema';
import { CanvasCtx } from './context.ts';
import { AgentLayer, ZONE_PADDING, type Zone } from './AgentLayer.tsx';
import { TOGGLE_AI } from './AiSidebar.tsx';
import { langCode, t } from './i18n.ts';
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
const SELECTION_REPORT_DELAY_MS = 200;
/** How many selected widgets, and drawings, a selection report lists; its `total` counts everything. */
const MAX_REPORTED = 200;
/** Gap between an element and Excalidraw's selection border, in screen px (DEFAULT_TRANSFORM_HANDLE_SPACING * 2). */
const SELECTION_PADDING = 4;

type Rect = { x: number; y: number; w: number; h: number };

const ViewsCtx = createContext<Map<string, NodeView>>(new Map());
const CanvasStyleCtx = createContext<NodeStyle | undefined>(undefined);

/**
 * Which widget the pointer is over and which one is selected. Embeds let the pointer through to
 * the canvas, so CSS :hover never fires on them; the canvas tells us instead. The hover outline
 * follows `hovered`; each widget subscribes to its own `active` flag, so a change re-renders only
 * the widgets it affects. What is drawn over the canvas subscribes to the scene and places itself.
 */
class WidgetUiStore {
  hovered: string | null = null;
  active: string | null = null;
  private listeners = new Set<() => void>();
  private sceneListeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeScene = (listener: () => void) => {
    this.sceneListeners.add(listener);
    return () => { this.sceneListeners.delete(listener); };
  };

  sceneChanged() {
    this.sceneListeners.forEach((l) => l());
  }

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

/** Where an agent's target is now: its widget as the canvas shows it, or the place a new one will land. */
function zoneOf(target: AgentTarget, elements: readonly ExcalidrawElement[]): Zone {
  const el = elements.find((e) => e.id === `${ID_PREFIX}${target.node}`);
  if (!el) return { x: target.x, y: target.y, w: target.w, h: target.h, angle: 0 };
  return { x: el.x, y: el.y, w: el.width, h: el.height, angle: el.angle };
}

/** Whether a scene point is in a zone, or within `margin` of it. */
function inZone(zone: Zone, x: number, y: number, margin = 0): boolean {
  const dx = x - (zone.x + zone.w / 2);
  const dy = y - (zone.y + zone.h / 2);
  const cos = Math.cos(zone.angle);
  const sin = Math.sin(zone.angle);
  return Math.abs(dx * cos + dy * sin) <= zone.w / 2 + margin && Math.abs(dy * cos - dx * sin) <= zone.h / 2 + margin;
}

/** The agent holding a scene point. */
function agentAt(agents: AgentPresence[], elements: readonly ExcalidrawElement[], x: number, y: number, margin = 0) {
  return agents.find((a) => a.targets.some((t) => inZone(zoneOf(t, elements), x, y, margin)));
}

/** Any embed of a widget, including copies a person made of one (copies keep customData). */
function isWidgetEmbed(el: ExcalidrawElement): boolean {
  return el.type === 'embeddable' && el.customData?.exprything !== undefined;
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

/**
 * The selection as agents read it (MCP canvas_selection, `exp selection`): widgets by node id and
 * drawings summarized, both in stacking order.
 */
function selectionReport(
  canvas: string,
  elements: readonly ExcalidrawElement[],
  selectedIds: AppState['selectedElementIds'],
  nodes: Map<string, NodeView>,
): SelectionReport {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const selected = elements.filter((el) => selectedIds[el.id]);
  const report: SelectionReport = { type: 'selection', canvas, nodes: [], drawings: [], total: selected.length };
  for (const el of selected) {
    const id = widgetNodeId(el);
    if (id) {
      const n = nodes.get(id);
      if (n && report.nodes.length < MAX_REPORTED) report.nodes.push({ id, type: n.type, title: n.title, source: n.source });
    } else if (!isWidgetEmbed(el) && report.drawings.length < MAX_REPORTED) {
      report.drawings.push(drawingSummary(el, byId));
    }
  }
  return report;
}

function drawingSummary(el: ExcalidrawElement, byId: Map<string, ExcalidrawElement>): SelectedDrawing {
  const summary: SelectedDrawing = {
    id: el.id,
    type: el.type,
    x: Math.round(el.x),
    y: Math.round(el.y),
    width: Math.round(el.width),
    height: Math.round(el.height),
  };
  const text = textOf(el, byId);
  if (text) summary.text = text;
  if (el.link) summary.link = el.link;
  if (el.type === 'arrow') {
    // A widget end reads node:<id>, the widget element's id.
    if (el.startBinding) summary.from = el.startBinding.elementId;
    if (el.endBinding) summary.to = el.endBinding.elementId;
  }
  return summary;
}

/** The words a drawing carries: its own text, the label bound to a shape, or a frame's name. */
function textOf(el: ExcalidrawElement, byId: Map<string, ExcalidrawElement>): string | undefined {
  if (el.type === 'text') return el.originalText || el.text;
  if (el.type === 'frame' || el.type === 'magicframe') return el.name ?? undefined;
  const label = el.boundElements?.find((b) => b.type === 'text');
  const bound = label && byId.get(label.id);
  return bound?.type === 'text' ? bound.originalText || bound.text : undefined;
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
  const everyone = useSyncExternalStore(api.subscribePresence, api.getPresence);
  const agents = useMemo(() => everyone.filter((a) => a.canvas === canvas), [everyone, canvas]);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  /** What agents took out of the person's selection; selected again once they let go. */
  const displaced = useRef(new Set<string>());

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
  /** Widget elements Excalidraw has rendered, which it does only after accepting their link (see syncLinks). */
  const rendered = useRef(new Set<string>());
  const pointerDown = useRef(false);
  const projectionPending = useRef(false);
  const savedSignature = useRef('');
  const pendingSave = useRef<CanvasDrawing | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const syncTimer = useRef<number | undefined>(undefined);
  const reportTimer = useRef<number | undefined>(undefined);
  const lastReport = useRef<{ json: string; report: SelectionReport } | null>(null);

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
        toast = t('Widgets cannot be copied. Ask the agent for another one.');
        return newElementWith(el, { isDeleted: true });
      }
      if (!current.has(id)) return el;
      if (el.isDeleted) {
        toast = t('Widgets belong to agent recipes. Remove them through the agent or `exp apply`.');
        return newElementWith(el, { isDeleted: false });
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

  /**
   * Excalidraw draws a link icon beside every unselected element that has a link, yet renders an
   * embed only if it had a link when first seen (the verdict is kept per element id). So a widget
   * carries its link until it has rendered, and after that only while selected, when no icon is
   * drawn.
   *
   * Excalidraw's link editor saves its input when it closes, and saving an empty link stops the
   * widget rendering. The input is filled when the link popup opens, which on a click is before the
   * widget's link is back, so that popup is closed (Excalidraw reopens it on hover, with the link).
   * The editor is also closed on a widget, where it is hidden anyway, and with no single element
   * selected, where Excalidraw leaves it open and an undo could bring it back on a bare widget.
   */
  const syncLinks = useCallback((appState: AppState, selected: string[]) => {
    if (!excalidraw) return;
    let changed = false;
    let relinked = false;
    const next = excalidraw.getSceneElementsIncludingDeleted().map((el) => {
      const id = widgetNodeId(el);
      if (!id || el.isDeleted) return el;
      const link = appState.selectedElementIds[el.id] || !rendered.current.has(el.id) ? `${LINK_PREFIX}${id}` : null;
      if (el.link === link) return el;
      changed = true;
      relinked ||= link !== null;
      return newElementWith(el, { link });
    });
    const popup = appState.showHyperlinkPopup;
    const editorMisplaced = popup === 'editor' && (selected.length !== 1 || nodeIdOfElementId(selected[0]) !== undefined);
    const closePopup = !!popup && (relinked || editorMisplaced);
    if (!changed && !closePopup) return;
    excalidraw.updateScene({
      elements: changed ? next : undefined,
      appState: closePopup ? { showHyperlinkPopup: false } : null,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [excalidraw]);

  /** Tell the daemon what is selected once the selection settles, and only when the report changed. */
  const reportSelection = useCallback(() => {
    clearTimeout(reportTimer.current);
    reportTimer.current = window.setTimeout(() => {
      if (!excalidraw) return;
      // What an agent took out of the selection is still what the person selected.
      const selected = {
        ...excalidraw.getAppState().selectedElementIds,
        ...Object.fromEntries([...displaced.current].map((id) => [id, true as const])),
      };
      const report = selectionReport(canvas, excalidraw.getSceneElements(), selected, nodesRef.current);
      const json = JSON.stringify(report);
      if (json === lastReport.current?.json) return;
      lastReport.current = { json, report };
      api.reportSelection(report);
    }, SELECTION_REPORT_DELAY_MS);
  }, [excalidraw, api, canvas]);

  // The first report says this canvas is open; agents may also rename or remove a selected widget.
  useEffect(() => { reportSelection(); }, [reportSelection, nodes]);

  // Coming back to this canvas makes it the one agents read when they name no canvas.
  useEffect(() => {
    const resend = () => {
      if (document.visibilityState === 'visible' && lastReport.current) api.reportSelection(lastReport.current.report);
    };
    window.addEventListener('focus', resend);
    document.addEventListener('visibilitychange', resend);
    return () => {
      window.removeEventListener('focus', resend);
      document.removeEventListener('visibilitychange', resend);
      clearTimeout(reportTimer.current);
    };
  }, [api]);

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
  const [excalidrawRoot, setExcalidrawRoot] = useState<Element | null>(null);

  useEffect(() => { setExcalidrawRoot(hostRef.current?.querySelector('.excalidraw') ?? null); }, [excalidraw]);

  const zoneOfTarget = useCallback((t: AgentTarget) => zoneOf(t, excalidraw?.getSceneElements() ?? []), [excalidraw]);

  /**
   * Keeps what agents hold out of the selection, however it got in (select all, a drag box), so no
   * key or style panel can reach it. It comes back when they let go, unless the person has selected
   * something else. What a person is dragging stays theirs until they drop it.
   */
  const yieldToAgents = useCallback(() => {
    if (!excalidraw || pointerDown.current) return;
    const targets = agentsRef.current.flatMap((a) => a.targets);
    if (!targets.length && !displaced.current.size) return;
    const elements = excalidraw.getSceneElements();
    const held = new Set(targets.map((t) => `${ID_PREFIX}${t.node}`));
    const zones = targets.map((t) => zoneOf(t, elements));
    const { selectedElementIds } = excalidraw.getAppState();
    const selected: Record<string, true> = { ...selectedElementIds };
    let changed = false;
    for (const el of elements) {
      if (!selected[el.id]) continue;
      if (held.has(el.id) || zones.some((z) => inZone(z, el.x + el.width / 2, el.y + el.height / 2))) {
        delete selected[el.id];
        displaced.current.add(el.id);
        changed = true;
      }
    }
    if (Object.keys(selected).length) {
      displaced.current.clear();
    } else if (!targets.length) {
      for (const el of elements) {
        if (displaced.current.has(el.id)) {
          selected[el.id] = true;
          changed = true;
        }
      }
      displaced.current.clear();
    }
    if (changed) {
      excalidraw.updateScene({
        appState: { selectedElementIds: selected, selectedGroupIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, [excalidraw]);

  useEffect(() => {
    yieldToAgents();
    if (!agents.some((a) => a.targets.length)) delete hostRef.current?.dataset.agentHeld;
  }, [agents, yieldToAgents]);

  /**
   * Input that starts on what an agent holds stops here, before Excalidraw or the widget sees it.
   * The wheel and panning go through. Excalidraw's `locked` would not do: a person can unlock it
   * from the context menu, and it would be saved with their drawings.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !excalidraw) return;
    let refusedPointer: number | undefined;
    const refuse = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('canvas.interactive, .excalidraw__embeddable-container')) return;
      const appState = excalidraw.getAppState();
      const { x, y } = viewportCoordsToSceneCoords(e, appState);
      const agent = agentAt(agentsRef.current, excalidraw.getSceneElements(), x, y, ZONE_PADDING / appState.zoom.value);
      if (agent) {
        e.preventDefault();
        e.stopPropagation();
      }
      return agent;
    };
    const onPointerDown = (e: PointerEvent) => {
      // Excalidraw's canvas shows this cursor only while the hand tool or the space bar pans.
      if (e.button !== 0 || (e.target as HTMLElement).style.cursor === 'grab') return;
      const agent = refuse(e);
      if (!agent) return;
      refusedPointer = e.pointerId;
      excalidraw.setToast({ message: t('{name} is editing this. You can use it again when it finishes.', { name: agent.name }), duration: 3000 });
    };
    // A pointer up with no pointer down would still follow a link under the pointer.
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== refusedPointer) return;
      refusedPointer = undefined;
      e.stopPropagation();
    };
    const stop = new AbortController();
    const capture = { capture: true, signal: stop.signal };
    host.addEventListener('pointerdown', onPointerDown, capture);
    host.addEventListener('pointerup', onPointerUp, capture);
    for (const type of ['click', 'dblclick', 'contextmenu'] as const) host.addEventListener(type, refuse, capture);
    return () => stop.abort();
  }, [excalidraw]);

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
    syncLinks(appState, selected);
    yieldToAgents();
    reportSelection();
    placeOutline(); // panned, zoomed or moved
    ui.sceneChanged();

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
  }, [ui, syncLinks, yieldToAgents, reportSelection, placeOutline, syncWidgets, flushSave]);

  const onPointerUpdate = useCallback(({ pointer }: { pointer: { x: number; y: number } }) => {
    if (!excalidraw) return;
    const elements = excalidraw.getSceneElements();
    const held = agentAt(agentsRef.current, elements, pointer.x, pointer.y, ZONE_PADDING / excalidraw.getAppState().zoom.value);
    ui.setHovered(held ? null : widgetAt(elements, pointer.x, pointer.y));
    const host = hostRef.current;
    if (host && held) host.dataset.agentHeld = '';
    else if (host) delete host.dataset.agentHeld;
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
      yieldToAgents();
      placeOutline();
    }, 0);
  }, [project, syncWidgets, yieldToAgents, placeOutline]);

  const renderEmbeddable = useCallback((el: NonDeleted<ExcalidrawEmbeddableElement>) => {
    const id = (el.customData?.exprything as { node?: string } | undefined)?.node ?? widgetNodeId(el);
    if (!id) return null;
    rendered.current.add(el.id);
    return <EmbeddedWidget nodeId={id} />;
  }, []);

  const initialData = useMemo(
    () => initial && { elements: initial.elements, files: initial.files, scrollToContent: true },
    [initial],
  );

  if (!initialData) return <div className="empty">{t('Loading canvas…')}</div>;

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
            {excalidraw && excalidrawRoot && (
              <AgentLayer
                agents={agents}
                root={excalidrawRoot}
                excalidraw={excalidraw}
                zoneOf={zoneOfTarget}
                subscribeScene={ui.subscribeScene}
              />
            )}
          </div>
        </UiCtx.Provider>
      </CanvasStyleCtx.Provider>
    </ViewsCtx.Provider>
  );
}

/** Only our own widget links may embed; external sites stay out of a local-first canvas. */
const validateEmbeddable = (link: string) => link.startsWith('exprything:');

/** A widget's link is internal (see syncLinks) and must never be opened as a URL. */
const onLinkOpen = (el: NonDeleted<ExcalidrawElement>, event: CustomEvent) => {
  if (el.link?.startsWith('exprything:')) event.preventDefault();
};

/** Source health and the AI button in Excalidraw's top-right slot. Reads nodes from context so the prop stays stable. */
const renderTopRightUI = () => <CanvasSources />;

function CanvasSources() {
  const nodes = useContext(ViewsCtx);
  return (
    <div className="top-right">
      <SourceSummary nodes={[...nodes.values()]} />
      <button className="island-button" title={t('AI sidebar (⌘J)')} onClick={() => window.dispatchEvent(new Event(TOGGLE_AI))}>AI</button>
    </div>
  );
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
