import type { CanvasDrawing, CanvasView, NodeStyle } from '@exprything/schema';

const TOKEN_KEY = 'exprything.token';

/** `exp open` passes the token in the URL hash (never sent to the server); keep it and strip it from the URL. */
export function initToken(): string | null {
  const m = /[?&]token=([^&]+)/.exec(location.hash);
  if (m) {
    try { localStorage.setItem(TOKEN_KEY, m[1]); } catch { /* storage may be blocked */ }
    history.replaceState(null, '', location.pathname + location.hash.replace(/[?&]token=[^&]+/, ''));
    return m[1];
  }
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function canvasFromHash(): string {
  return /^#\/c\/([^?]+)/.exec(location.hash)?.[1] ?? 'main';
}

export class Api {
  constructor(private token: string) {}

  canvases(): Promise<{ id: string; title: string; nodes: number }[]> {
    return this.call('GET', '/api/canvases');
  }

  view(id: string): Promise<CanvasView> {
    return this.call('GET', `/api/canvases/${encodeURIComponent(id)}`);
  }

  moveNode(canvas: string, node: string, rect: { x?: number; y?: number; w?: number; h?: number }) {
    return this.call('PATCH', `/api/canvases/${encodeURIComponent(canvas)}/nodes/${encodeURIComponent(node)}`, rect);
  }

  restyleNode(canvas: string, node: string, style: Partial<NodeStyle>) {
    return this.call('PATCH', `/api/canvases/${encodeURIComponent(canvas)}/nodes/${encodeURIComponent(node)}`, { style });
  }

  drawing(canvas: string): Promise<CanvasDrawing> {
    return this.call('GET', `/api/canvases/${encodeURIComponent(canvas)}/drawing`);
  }

  /** `keepalive` lets the save finish while the page is being closed. */
  saveDrawing(canvas: string, drawing: CanvasDrawing, keepalive = false) {
    return this.call('PUT', `/api/canvases/${encodeURIComponent(canvas)}/drawing`, drawing, keepalive);
  }

  sources(): Promise<{ id: string; kind: string; cmd?: string[]; cwd?: string }[]> {
    return this.call('GET', '/api/sources');
  }

  approve(source: string) {
    return this.call('POST', `/api/sources/${encodeURIComponent(source)}/approve`);
  }

  refresh(source: string) {
    return this.call('POST', `/api/sources/${encodeURIComponent(source)}/refresh`);
  }

  subscribe(onChange: () => void): () => void {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
      ws.onmessage = () => onChange();
      ws.onopen = () => onChange();
      ws.onclose = () => { if (!closed) retry = window.setTimeout(open, 2_000); };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      // Closing a socket that is still connecting logs a browser warning (StrictMode remounts do this).
      if (ws?.readyState === WebSocket.CONNECTING) ws.onopen = () => ws?.close();
      else ws?.close();
    };
  }

  private async call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
    const res = await fetch(path, {
      method,
      keepalive,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status}`);
    return json as T;
  }
}
