import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Api, initToken } from './api.ts';
import { App } from './App.tsx';
import { Crashed, ErrorBoundary } from './ErrorBoundary.tsx';
import { korean, t, tRich } from './i18n.ts';
import './hangul-font.css';
// After the canvas libraries' own CSS, so our overrides win.
import './styles.css';

document.documentElement.lang = korean ? 'ko' : 'en';

const token = initToken();
const root = createRoot(document.getElementById('root')!);

root.render(
  <StrictMode>
    {token ? (
      <ErrorBoundary fallback={(error, retry) => <Crashed what={t('Exprything stopped working.')} error={error} retry={retry} />}>
        <App api={new Api(token)} />
      </ErrorBoundary>
    ) : (
      <div className="empty">{tRich('Open this canvas with {command} so the browser receives its access token.', { command: <code>exp open</code> })}</div>
    )}
  </StrictMode>,
);
