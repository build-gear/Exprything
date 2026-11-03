import { useContext, useEffect, useState, type CSSProperties } from 'react';
import type { NodeView, SourceState } from '@exprything/schema';
import { CanvasCtx } from './context.ts';
import { fontStack, inkOf, type Look } from './style.ts';
import { widgets } from './widgets/index.tsx';

/**
 * The card every live widget is drawn in. It draws no lines of its own: a frame comes from its style
 * and is drawn by Excalidraw. Only a selected (`active`) card takes wheel and pointer input inside
 * its body.
 */
export function WidgetCard({ view: n, look, active = false }: { view: NodeView; look: Look; active?: boolean }) {
  const { api, reload } = useContext(CanvasCtx);
  const Widget = widgets[n.type];
  const st = n.sourceState;
  const ink = inkOf(look);
  const className = ['wn', st && `st-${st.status}`, active && 'is-active'].filter(Boolean).join(' ');
  const vars = { '--w-font': fontStack(look), '--w-ink': ink, '--w-line': look.strokeStyle } as CSSProperties;

  const approve = async () => {
    const src = (await api.sources()).find((s) => s.id === n.source);
    const cmd = src?.cmd ? `\n\n${src.cmd.join(' ')}${src.cwd ? `\n(in ${src.cwd})` : ''}` : '';
    if (window.confirm(`Allow source "${n.source}" to run on schedule?${cmd}`)) {
      await api.approve(n.source!);
      reload();
    }
  };

  return (
    <div className={className} style={vars}>
      <div className="wn-head">
        <span className={ink ? 'wn-title wn-ink' : 'wn-title'}>{n.title ?? n.id}</span>
        {n.pinned && <span className="wn-pin" title="Moved by you; agents will not move it">●</span>}
        {st && <Freshness state={st} onRefresh={() => api.refresh(st.id).then(reload, reload)} />}
      </div>
      {st?.status === 'needs_approval' && (
        <div className="wn-banner warn">
          This recipe runs a command on your machine. <button onClick={approve}>Review & approve</button>
        </div>
      )}
      {(n.error || st?.lastError) && <div className="wn-banner bad" title={n.error ?? st?.lastError}>{n.error ?? st?.lastError}</div>}
      <div className="wn-body">
        {Widget ? <Widget data={n.data} props={n.props} look={look} seedKey={n.id} /> : <div>Unknown widget: {n.type}</div>}
      </div>
    </div>
  );
}

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
