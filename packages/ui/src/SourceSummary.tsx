import type { NodeView, SourceState } from '@exprything/schema';
import { t } from './i18n.ts';

/** Health of the sources a canvas reads from: how many, and which need a person's attention. */
export function SourceSummary({ nodes }: { nodes: NodeView[] }) {
  const states = new Map<string, SourceState>();
  for (const n of nodes) if (n.sourceState) states.set(n.sourceState.id, n.sourceState);
  if (states.size === 0) return null;
  const count = (s: string) => [...states.values()].filter((x) => x.status === s).length;
  const bad = count('error') + count('stale');
  const approve = count('needs_approval');
  return (
    <div className="summary">
      {t(states.size === 1 ? '{n} source' : '{n} sources', { n: states.size })}
      {approve > 0 && <span className="pill warn">{t('{n} awaiting approval', { n: approve })}</span>}
      {bad > 0 && <span className="pill bad">{t('{n} need repair', { n: bad })}</span>}
    </div>
  );
}
