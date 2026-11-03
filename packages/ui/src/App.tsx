import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasView } from '@exprything/schema';
import { Api, canvasFromHash } from './api.ts';
import { CanvasCtx } from './context.ts';
import { DrawCanvas } from './DrawCanvas.tsx';

export function App({ api }: { api: Api }) {
  const [canvas, setCanvas] = useState(canvasFromHash);
  const [canvases, setCanvases] = useState<{ id: string; title: string }[]>([]);
  const [view, setView] = useState<CanvasView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
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

  // A canvas no agent has drawn on yet is still a blank canvas people can draw on.
  const missing = error === 'no such canvas';
  let body: React.ReactNode;
  if (!loaded) body = <div className="empty">Loading…</div>;
  else if (error && !missing) body = <div className="empty">{error}</div>;
  else body = <DrawCanvas key={canvas} view={view} title={view?.canvas.title ?? canvas} />;

  return (
    <CanvasCtx.Provider value={{ api, canvas, reload }}>
      <main className="stage">
        {body}
        <CanvasPicker canvas={canvas} canvases={canvases} />
      </main>
    </CanvasCtx.Provider>
  );
}

/** Switches canvases; drawn over the canvas where Excalidraw's main menu button used to be. */
function CanvasPicker({ canvas, canvases }: { canvas: string; canvases: { id: string; title: string }[] }) {
  return (
    <label className="canvas-picker">
      <select aria-label="Canvas" value={canvas} onChange={(e) => { location.hash = `#/c/${e.target.value}`; }}>
        {[...new Set([canvas, ...canvases.map((c) => c.id)])].map((id) => (
          <option key={id} value={id}>{canvases.find((c) => c.id === id)?.title ?? id}</option>
        ))}
      </select>
    </label>
  );
}
