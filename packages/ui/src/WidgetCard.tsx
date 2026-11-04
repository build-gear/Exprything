import { useContext, useEffect, useState, type CSSProperties } from 'react';
import type { NodeView, SourceState } from '@exprything/schema';
import { Skeleton } from 'skullet/react';
import { CanvasCtx } from './context.ts';
import { t } from './i18n.ts';
import { fontStack, inkOf, type Look } from './style.ts';
import { sampleData, widgets } from './widgets/index.tsx';

/**
 * The card every live widget is drawn in. It draws no lines of its own: a frame comes from its style
 * and is drawn by Excalidraw. Only a selected (`active`) card takes wheel and pointer input inside
 * its body. Until the widget has a value, the whole card is drawn as a skeleton.
 */
export function WidgetCard({ view: n, look, active = false }: { view: NodeView; look: Look; active?: boolean }) {
  const { api, canvas, reload } = useContext(CanvasCtx);
  const Widget = widgets[n.type];
  const st = n.sourceState;
  // A widget gets a Skullet reveal the first time it has no value (a new recipe, or a value dropped
  // when its command changed) and keeps it, so the reveal can play when data lands. Widgets that
  // always had a value go without: once content shows, a reveal keeps re-measuring it to remember
  // its shape, which live widgets would pay on every update.
  const waiting = !!Widget && !!n.source && n.data === undefined;
  const [revealable, setRevealable] = useState(waiting);
  if (waiting && !revealable) setRevealable(true);
  const ink = inkOf(look);
  const className = ['wn', st && `st-${st.status}`, active && 'is-active'].filter(Boolean).join(' ');
  const vars = { '--w-font': fontStack(look), '--w-ink': ink, '--w-line': look.strokeStyle } as CSSProperties;

  const approve = async () => {
    const src = (await api.sources()).find((s) => s.id === n.source);
    const cmd = src?.cmd ? `\n\n${src.cmd.join(' ')}${src.cwd ? `\n${t('(in {cwd})', { cwd: src.cwd })}` : ''}` : '';
    if (window.confirm(`${t('Allow source "{source}" to run on schedule?', { source: n.source! })}${cmd}`)) {
      await api.approve(n.source!);
      reload();
    }
  };

  const banners = (
    <>
      {st?.status === 'needs_approval' && (
        <div className="wn-banner warn">
          {t('This recipe runs a command on your machine.')} <button onClick={approve}>{t('Review & approve')}</button>
        </div>
      )}
      {(n.error || st?.lastError) && <div className="wn-banner bad" title={n.error ?? st?.lastError}>{n.error ?? st?.lastError}</div>}
    </>
  );

  // Inline JSX, not a component, so Skullet sees the widget element and can use Chart.Skeleton.
  const card = (v: NodeView, withBanners: boolean) => (
    <div className={className} style={vars}>
      <div className="wn-head">
        <span className={ink ? 'wn-title wn-ink' : 'wn-title'}>{v.title ?? v.id}</span>
        {v.pinned && <span className="wn-pin" title={t('Moved by you; agents will not move it')}>●</span>}
        {st && <Freshness state={st} onRefresh={() => api.refresh(st.id).then(reload, reload)} />}
      </div>
      {withBanners && banners}
      <div className="wn-body">
        {Widget ? <Widget data={v.data} props={v.props} look={look} seedKey={n.id} /> : <div>{t('Unknown widget: {type}', { type: n.type })}</div>}
      </div>
    </div>
  );

  if (!revealable) return card(n, true);

  // With no value, the whole card is a skeleton traced from sample data or the shape last shown. The
  // banners ask the person to act, so they stay live above it. The skeleton shimmers only while the
  // source runs; waiting on approval or a retry, it holds still.
  return (
    <div className={waiting && st?.status !== 'pending' ? 'wn-reveal is-still' : 'wn-reveal'} style={vars}>
      {waiting && banners}
      <Skeleton
        id={`${canvas}/${n.id}`}
        data={waiting ? null : n}
        sample={{ ...n, data: sampleData(n.type, n.props) }}
        label={t('Loading {name}', { name: n.title ?? n.id })}
      >
        {(v) => card(v, !waiting)}
      </Skeleton>
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
    state.status === 'needs_approval' ? t('needs approval')
      : !state.lastSuccessAt ? t(state.status)
        : state.nextRunAt ? t('{ago} · next {until}', { ago: ago(state.lastSuccessAt), until: until(state.nextRunAt) })
          : ago(state.lastSuccessAt);
  return (
    <button className="wn-fresh" onClick={onRefresh} title={t('{status} — click to refresh now', { status: t(state.status) })}>
      <span className={`dot ${state.status}`} /> {label}
    </button>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.floor(s / 3600) });
  return t('{n}d ago', { n: Math.floor(s / 86400) });
}

function until(iso: string): string {
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  if (s < 60) return t('{n}s', { n: Math.ceil(s) });
  if (s < 3600) return t('{n}m', { n: Math.round(s / 60) });
  return t('{n}h', { n: Math.round(s / 3600) });
}
