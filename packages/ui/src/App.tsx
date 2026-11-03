import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasView, NodeView, SourceState } from '@exprything/schema';
import { Api, canvasFromHash } from './api.ts';
import { CanvasCtx } from './context.ts';
import { DrawCanvas } from './DrawCanvas.tsx';
import { FlowCanvas } from './FlowCanvas.tsx';

type Renderer = 'draw' | 'flow';
const RENDERER_KEY = 'exprything.renderer';

function storedRenderer(): Renderer {
  try {
    return localStorage.getItem(RENDERER_KEY) === 'flow' ? 'flow' : 'draw';
  } catch {
    return 'draw';
  }
}

export function App({ api }: { api: Api }) {
  const [canvas, setCanvas] = useState(canvasFromHash);
  const [canvases, setCanvases] = useState<{ id: string; title: string }[]>([]);
  const [view, setView] = useState<CanvasView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [renderer, setRenderer] = useState<Renderer>(storedRenderer);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

  const reload = useCallback(() => {
    const requested = canvas;
    api.view(requested).then(
      (v) => {
        if (canvasRef.current !== requested) return;
        setView(v); setError(null); setLoaded(true);
      },
      (e: Error) => {
        if (canvasRef.current !== requested) return;
        setView(null); setError(e.message); setLoaded(true);
      },
    );
    api.canvases().then(setCanvases, () => {});
  }, [api, canvas]);

  // Coalesce bursts of change notifications into one fetch.
  const timer = useRef<number | undefined>(undefined);
  const scheduleReload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(reload, 150);
  }, [reload]);

  useEffect(() => {
    setLoaded(false);
    setView(null);
  }, [canvas]);
  useEffect(() => api.subscribe(scheduleReload), [api, scheduleReload]);
  useEffect(() => {
    const on = () => setCanvas(canvasFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const pickRenderer = (r: Renderer) => {
    setRenderer(r);
    try { localStorage.setItem(RENDERER_KEY, r); } catch { /* storage may be blocked */ }
  };

  const missing = error === 'no such canvas';
  let body: React.ReactNode;
  if (!loaded) body = <div className="empty">Loading…</div>;
  else if (error && !missing) body = <div className="empty">{error}</div>;
  else if (renderer === 'draw') body = <DrawCanvas key={canvas} view={view} title={view?.canvas.title ?? canvas} />;
  else if (view) body = <FlowCanvas view={view} />;
  else body = (
    <div className="empty">
      Canvas <code>{canvas}</code> is empty. Ask your agent to draw on it, or run <code>exp apply</code>.
    </div>
  );

  return (
    <CanvasCtx.Provider value={{ api, canvas, reload }}>
      <div className="app">
        <header className="bar">
          <span className="brand">Exprything</span>
          <select value={canvas} onChange={(e) => { location.hash = `#/c/${e.target.value}`; }}>
            {[...new Set([canvas, ...canvases.map((c) => c.id)])].map((id) => (
              <option key={id} value={id}>{canvases.find((c) => c.id === id)?.title ?? id}</option>
            ))}
          </select>
          <div className="seg" role="group" aria-label="Canvas renderer">
            <button className={renderer === 'draw' ? 'on' : ''} onClick={() => pickRenderer('draw')}>Excalidraw</button>
            <button className={renderer === 'flow' ? 'on' : ''} onClick={() => pickRenderer('flow')}>React Flow</button>
          </div>
          <SourceSummary nodes={view?.nodes ?? []} />
        </header>
        {body}
      </div>
    </CanvasCtx.Provider>
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
