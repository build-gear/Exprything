import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Api, initToken } from './api.ts';
import { App } from './App.tsx';
import { korean, tRich } from './i18n.ts';
// After the canvas libraries' own CSS, so our overrides win.
import './styles.css';

document.documentElement.lang = korean ? 'ko' : 'en';

const token = initToken();
const root = createRoot(document.getElementById('root')!);

root.render(
  <StrictMode>
    {token ? (
      <App api={new Api(token)} />
    ) : (
      <div className="empty">{tRich('Open this canvas with {command} so the browser receives its access token.', { command: <code>exp open</code> })}</div>
    )}
  </StrictMode>,
);
