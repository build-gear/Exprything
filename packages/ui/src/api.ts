import type {
  AgentId, AgentPresence, AgentStatus, CanvasDrawing, CanvasView, ChatItem, ChatSummary, NodeStyle, SelectionReport,
  ServerMessage,
} from '@exprything/schema';

/** What the daemon says about the AI sidebar's conversations as they run. */
export type ChatEvent = Extract<ServerMessage, { type: 'chat' | 'chat.delta' }>;

/** What an agent changed in a canvas's drawing. */
export type DrawingEvent = Extract<ServerMessage, { type: 'drawing' }>;

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
  /** The open change-notification socket, which also carries selection reports to the daemon. */
  private ws?: WebSocket;
  private selection?: SelectionReport;
  private presence: AgentPresence[] = [];
  private presenceListeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private chatListeners = new Set<(e: ChatEvent) => void>();
  private drawingListeners = new Set<(e: DrawingEvent) => void>();
  private openListeners = new Set<() => void>();

  constructor(private token: string) {}

  /** The agents at work on any canvas, as the daemon last said. */
  getPresence = () => this.presence;

  subscribePresence = (listener: () => void) => {
    this.presenceListeners.add(listener);
    return () => { this.presenceListeners.delete(listener); };
  };

  private setPresence(agents: AgentPresence[]) {
    this.presence = agents;
    this.presenceListeners.forEach((l) => l());
  }

  /** What this page last reported as selected. */
  getSelection = () => this.selection;

  subscribeSelection = (listener: () => void) => {
    this.selectionListeners.add(listener);
    return () => { this.selectionListeners.delete(listener); };
  };

  onChat(listener: (e: ChatEvent) => void): () => void {
    this.chatListeners.add(listener);
    return () => { this.chatListeners.delete(listener); };
  }

  onDrawing(listener: (e: DrawingEvent) => void): () => void {
    this.drawingListeners.add(listener);
    return () => { this.drawingListeners.delete(listener); };
  }

  /** Calls back whenever the connection to the daemon (re)opens; what happened while it was down was missed. */
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => { this.openListeners.delete(listener); };
  }

  chats(canvas: string): Promise<ChatSummary[]> {
    return this.call('GET', `/api/chats?canvas=${encodeURIComponent(canvas)}`);
  }

  chat(id: string): Promise<{ chat: ChatSummary; items: ChatItem[] }> {
    return this.call('GET', `/api/chats/${id}`);
  }

  createChat(agent: AgentId, canvas: string): Promise<ChatSummary> {
    return this.call('POST', '/api/chats', { agent, canvas });
  }

  sendChat(id: string, text: string, selection?: SelectionReport) {
    return this.call('POST', `/api/chats/${id}/messages`, { text, selection });
  }

  answerChat(id: string, request: string, allow: boolean) {
    return this.call('POST', `/api/chats/${id}/answers`, { request, allow });
  }

  stopChat(id: string) {
    return this.call('POST', `/api/chats/${id}/stop`);
  }

  canvases(): Promise<{ id: string; title: string; nodes: number }[]> {
    return this.call('GET', '/api/canvases');
  }

  createCanvas(title: string): Promise<{ id: string }> {
    return this.call('POST', '/api/canvases', { title });
  }

  deleteCanvas(id: string) {
    return this.call('DELETE', `/api/canvases/${encodeURIComponent(id)}`);
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

  agents(): Promise<AgentStatus[]> {
    return this.call('GET', '/api/agents');
  }

  connectAgent(agent: AgentId): Promise<AgentStatus> {
    return this.call('POST', `/api/agents/${agent}/connect`, {});
  }

  setAgentActivity(agent: AgentId, on: boolean): Promise<AgentStatus> {
    return this.call('POST', `/api/agents/${agent}/activity`, { on });
  }

  disconnectAgent(agent: AgentId): Promise<AgentStatus> {
    return this.call('POST', `/api/agents/${agent}/disconnect`);
  }

  /**
   * Tell the daemon what is selected on the open canvas, so agents can read it. The daemon keeps it
   * for as long as this page stays connected; it is sent again whenever the connection reopens.
   */
  reportSelection(report: SelectionReport): void {
    this.selection = report;
    this.selectionListeners.forEach((l) => l());
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(report));
  }

  subscribe(onChange: () => void): () => void {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
      ws = socket;
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === 'presence') this.setPresence(msg.agents);
        else if (msg.type === 'chat' || msg.type === 'chat.delta') this.chatListeners.forEach((l) => l(msg));
        else if (msg.type === 'drawing') this.drawingListeners.forEach((l) => l(msg));
        else onChange();
      };
      socket.onopen = () => {
        this.ws = socket;
        if (this.selection) socket.send(JSON.stringify(this.selection));
        onChange();
        this.openListeners.forEach((l) => l());
      };
      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = undefined;
          // Nothing holds what the daemon can no longer say is held.
          this.setPresence([]);
        }
        if (!closed) retry = window.setTimeout(open, 2_000);
      };
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
