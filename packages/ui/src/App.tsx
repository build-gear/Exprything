import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasView } from '@exprything/schema';
import { AiSidebar, TOGGLE_AI } from './AiSidebar.tsx';
import { Api, canvasFromHash } from './api.ts';
import { CanvasCtx } from './context.ts';
import { DrawCanvas } from './DrawCanvas.tsx';
import { Crashed, ErrorBoundary } from './ErrorBoundary.tsx';
import { t, tMessage } from './i18n.ts';

export function App({ api }: { api: Api }) {
  const [canvas, setCanvas] = useState(canvasFromHash);
  const [canvases, setCanvases] = useState<{ id: string; title: string }[]>([]);
  const [view, setView] = useState<CanvasView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [aiOpen, setAiOpen] = useState(() => { try { return localStorage.getItem(AI_OPEN_KEY) === '1'; } catch { return false; } });
  const [aiSettings, setAiSettings] = useState(false);
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

  const showAi = useCallback((open: boolean) => {
    setAiOpen(open);
    if (!open) setAiSettings(false);
    try { localStorage.setItem(AI_OPEN_KEY, open ? '1' : '0'); } catch { /* storage may be blocked */ }
  }, []);
  useEffect(() => {
    const on = () => {
      if (takeAgentsFlag()) {
        showAi(true);
        setAiSettings(true);
      }
      setCanvas(canvasFromHash());
    };
    on(); // the flag may have come before this listener did
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [showAi]);
  const aiRef = useRef(aiOpen);
  aiRef.current = aiOpen;
  useEffect(() => {
    const toggle = () => showAi(!aiRef.current);
    // ⌘J (Ctrl+J): Excalidraw has no J shortcut, and the plain I is its eyedropper.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener(TOGGLE_AI, toggle);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener(TOGGLE_AI, toggle);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [showAi]);

  // A canvas no agent has drawn on yet is still a blank canvas people can draw on.
  const missing = error === 'no such canvas';
  let body: React.ReactNode;
  if (!loaded) body = <div className="empty">{t('Loading…')}</div>;
  else if (error && !missing) body = <div className="empty">{tMessage(error)}</div>;
  else body = <DrawCanvas key={canvas} view={view} title={view?.canvas.title ?? canvas} />;

  return (
    <CanvasCtx.Provider value={{ api, canvas, reload }}>
      <main className="stage">
        <div className="canvas-area">
          <ErrorBoundary
            resetKey={canvas}
            fallback={(error, retry) => <Crashed what={t('The canvas stopped working.')} error={error} retry={retry} />}
          >
            {body}
          </ErrorBoundary>
          <CanvasPicker canvas={canvas} canvases={canvases} />
        </div>
        {aiOpen && (
          <ErrorBoundary
            fallback={(error, retry) => (
              <aside className="ai-sidebar">
                <Crashed what={t('The AI sidebar stopped working.')} error={error} retry={retry} />
              </aside>
            )}
          >
            <AiSidebar api={api} canvas={canvas} settings={aiSettings} onSettings={setAiSettings} onClose={() => showAi(false)} />
          </ErrorBoundary>
        )}
      </main>
    </CanvasCtx.Provider>
  );
}

/** `#/c/<canvas>?agents` opens the AI sidebar's settings; the desktop app's Help > Connect an Agent… goes there. */
function takeAgentsFlag(): boolean {
  if (!/[?&]agents\b/.test(location.hash)) return false;
  history.replaceState(null, '', location.pathname + location.hash.replace(/[?&]agents\b/, ''));
  return true;
}

/** Not a canvas id (ids start with a letter or digit): the picker's entry for the AI sidebar. */
const AI_ENTRY = '~ai';
const AI_OPEN_KEY = 'exprything.ai.open';

/**
 * Switches canvases; drawn over the canvas where Excalidraw's main menu button used to be. Its last
 * entry opens the AI sidebar, which narrow windows have no room for a button for.
 */
function CanvasPicker({ canvas, canvases }: { canvas: string; canvases: { id: string; title: string }[] }) {
  const pick = (value: string) => {
    if (value === AI_ENTRY) window.dispatchEvent(new Event(TOGGLE_AI));
    else location.hash = `#/c/${value}`;
  };
  return (
    <label className="canvas-picker">
      <select aria-label={t('Canvas')} value={canvas} onChange={(e) => pick(e.target.value)}>
        {[...new Set([canvas, ...canvases.map((c) => c.id)])].map((id) => (
          <option key={id} value={id}>{canvases.find((c) => c.id === id)?.title ?? id}</option>
        ))}
        <option disabled>──────────</option>
        <option value={AI_ENTRY}>{t('AI sidebar')}</option>
      </select>
    </label>
  );
}
