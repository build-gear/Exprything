import type { NodeView, SourceState } from '@exprything/schema';

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
      {states.size} {states.size === 1 ? 'source' : 'sources'}
      {approve > 0 && <span className="pill warn">{approve} awaiting approval</span>}
      {bad > 0 && <span className="pill bad">{bad} need repair</span>}
    </div>
  );
}
