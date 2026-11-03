import '@xyflow/react/dist/style.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Api, initToken } from './api.ts';
import { App } from './App.tsx';

const token = initToken();
const root = createRoot(document.getElementById('root')!);

root.render(
  <StrictMode>
    {token ? (
      <App api={new Api(token)} />
    ) : (
      <div className="empty">Open this canvas with <code>exp open</code> so the browser receives its access token.</div>
    )}
  </StrictMode>,
);
