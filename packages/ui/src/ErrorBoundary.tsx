import { Component, type ReactNode } from 'react';
import { t } from './i18n.ts';

/**
 * Stops an error thrown while drawing from going further. React empties the whole page for one nothing
 * catches, so without this a bad widget, or a slip in a layer over the canvas, leaves a blank window.
 * Errors in event handlers and timers never come here: they leave the page as it is.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: (error: Error, retry: () => void) => ReactNode;
    /** When this changes, what failed is drawn again. */
    resetKey?: unknown;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidUpdate(before: { resetKey?: unknown }) {
    if (this.state.error && before.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}

/** What stopped working and why, in its place. */
export function Crashed({ what, error, retry }: { what: string; error: Error; retry: () => void }) {
  return (
    <div className="empty crashed" role="alert">
      <p>{what}</p>
      <code>{error.message}</code>
      <button onClick={retry}>{t('Try again')}</button>
    </div>
  );
}
