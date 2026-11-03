import {
  Background, Controls, NodeResizer, ReactFlow, useNodesState,
  type Node, type NodeProps, type OnNodeDrag,
} from '@xyflow/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CanvasView, NodeView, SourceState } from '@exprything/schema';
import { Api, canvasFromHash } from './api.ts';
import { widgets } from './widgets/index.tsx';

type WidgetNodeType = Node<{ view: NodeView }, 'widget'>;

const Ctx = createContext<{ api: Api; canvas: string; reload: () => void }>(null!);

export function App({ api }: { api: Api }) {
  const [canvas, setCanvas] = useState(canvasFromHash);
  const [canvases, setCanvases] = useState<{ id: string; title: string }[]>([]);
  const [view, setView] = useState<CanvasView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WidgetNodeType>([]);
  const dragging = useRef<string | null>(null);

  const reload = useCallback(() => {
    api.view(canvas).then(
      (v) => { setView(v); setError(null); },
      (e: Error) => { setView(null); setError(e.message); },
    );
    api.canvases().then(setCanvases, () => {});
  }, [api, canvas]);

  // Coalesce bursts of change notifications into one fetch.
  const timer = useRef<number | undefined>(undefined);
  const scheduleReload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(reload, 150);
  }, [reload]);

  useEffect(() => api.subscribe(scheduleReload), [api, scheduleReload]);
  useEffect(() => {
    const on = () => setCanvas(canvasFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    if (!view) return setNodes([]);
    setNodes((prev) =>
      view.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id);
        const keep = old && dragging.current === n.id;
        return {
          id: n.id,
          type: 'widget',
          dragHandle: '.wn-head',
          position: keep ? old.position : { x: n.x, y: n.y },
          width: n.w,
          height: n.h,
          data: { view: n },
        };
      }),
    );
  }, [view, setNodes]);

  const onDragStart: OnNodeDrag<WidgetNodeType> = (_e, n) => { dragging.current = n.id; };
  const onDragStop: OnNodeDrag<WidgetNodeType> = (_e, n) => {
    dragging.current = null;
    void api.moveNode(canvas, n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) });
  };

  return (
    <Ctx.Provider value={{ api, canvas, reload }}>
      <div className="app">
        <header className="bar">
          <span className="brand">Exprything</span>
          <select value={canvas} onChange={(e) => { location.hash = `#/c/${e.target.value}`; }}>
            {[...new Set([canvas, ...canvases.map((c) => c.id)])].map((id) => (
              <option key={id} value={id}>{canvases.find((c) => c.id === id)?.title ?? id}</option>
            ))}
          </select>
          <SourceSummary nodes={view?.nodes ?? []} />
        </header>
        {error ? (
          <div className="empty">
            {error === 'no such canvas'
              ? <>Canvas <code>{canvas}</code> is empty. Ask your agent to draw on it, or run <code>exp apply</code>.</>
              : error}
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onDragStart}
            onNodeDragStop={onDragStop}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </Ctx.Provider>
  );
}

function SourceSummary({ nodes }: { nodes: NodeView[] }) {
  const states = new Map<string, SourceState>();
  for (const n of nodes) if (n.sourceState) states.set(n.sourceState.id, n.sourceState);
  const count = (s: string) => [...states.values()].filter((x) => x.status === s).length;
  const bad = count('error') + count('stale');
  const approve = count('needs_approval');
  return (
    <span className="summary">
      {states.size} sources
      {approve > 0 && <span className="pill warn">{approve} awaiting approval</span>}
      {bad > 0 && <span className="pill bad">{bad} need repair</span>}
    </span>
  );
}

function WidgetNode({ data, selected }: NodeProps<WidgetNodeType>) {
  const { api, canvas, reload } = useContext(Ctx);
  const n = data.view;
  const Widget = widgets[n.type];
  const st = n.sourceState;

  const approve = async () => {
    const src = (await api.sources()).find((s) => s.id === n.source);
    const cmd = src?.cmd ? `\n\n${src.cmd.join(' ')}${src.cwd ? `\n(in ${src.cwd})` : ''}` : '';
    if (window.confirm(`Allow source "${n.source}" to run on schedule?${cmd}`)) {
      await api.approve(n.source!);
      reload();
    }
  };

  return (
    <div className={`wn ${st ? `st-${st.status}` : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={100}
        onResizeEnd={(_e, p) => void api.moveNode(canvas, n.id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
      />
      <div className="wn-head">
        <span className="wn-title">{n.title ?? n.id}</span>
        {n.pinned && <span className="wn-pin" title="Moved by you; agents will not move it">●</span>}
        {st && <Freshness state={st} onRefresh={() => api.refresh(st.id).then(reload, reload)} />}
      </div>
      {st?.status === 'needs_approval' && (
        <div className="wn-banner warn">
          This recipe runs a command on your machine. <button onClick={approve}>Review & approve</button>
        </div>
      )}
      {(n.error || st?.lastError) && <div className="wn-banner bad" title={n.error ?? st?.lastError}>{n.error ?? st?.lastError}</div>}
      <div className="wn-body nodrag nowheel">
        {Widget ? <Widget data={n.data} props={n.props} /> : <div>Unknown widget: {n.type}</div>}
      </div>
    </div>
  );
}

const nodeTypes = { widget: WidgetNode };

function Freshness({ state, onRefresh }: { state: SourceState; onRefresh: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const label =
    state.status === 'needs_approval' ? 'needs approval'
      : state.lastSuccessAt ? `${ago(state.lastSuccessAt)}${state.nextRunAt ? ` · next ${until(state.nextRunAt)}` : ''}`
        : state.status;
  return (
    <button className="wn-fresh" onClick={onRefresh} title={`${state.status} — click to refresh now`}>
      <span className={`dot ${state.status}`} /> {label}
    </button>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function until(iso: string): string {
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
