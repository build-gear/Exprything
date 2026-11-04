import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type MouseEvent,
} from 'react';
import type { AgentId, AgentStatus, ChatItem, ChatStatus, ChatSummary } from '@exprything/schema';
import { AGENT_COLORS, OTHER_AGENT_COLOR } from './AgentLayer.tsx';
import { AgentSettings } from './AgentSettings.tsx';
import type { Api, ChatEvent } from './api.ts';
import { t, tMessage, tRich } from './i18n.ts';

/** Opens or closes the sidebar: its button on the canvas, the canvas menu, and ⌘J. */
export const TOGGLE_AI = 'exprything:ai';

const AGENT_KEY = 'exprything.ai.agent';
/** How close to the bottom the log counts as following the conversation, in px. */
const FOLLOW_SLACK = 80;

const remember = (key: string) => { try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; } };
const keep = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ } };

/**
 * Claude Code or Codex next to the canvas. The daemon runs the agent as the person's own CLI, in Exprything's
 * workspace, with its canvas tools; this shows the conversation and answers its approval prompts.
 * A canvas keeps its conversations, newest first. Its settings connect the agents to their own sessions.
 */
export function AiSidebar({ api, canvas, settings, onSettings, onClose }: {
  api: Api;
  canvas: string;
  settings: boolean;
  onSettings: (open: boolean) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [agent, setAgent] = useState<AgentId | undefined>(() => remember(AGENT_KEY) as AgentId | undefined);
  const [error, setError] = useState<string | null>(null);
  const chatRef = useRef(chatId);
  chatRef.current = chatId;

  const chat = chats?.find((c) => c.id === chatId);
  const status: ChatStatus = chat?.status ?? 'idle';
  const installed = agents?.filter((a) => a.cli) ?? [];
  const chosen = installed.find((a) => a.agent === agent) ?? installed[0];

  useEffect(() => {
    api.agents().then(setAgents, (e: Error) => setError(e.message));
  }, [api]);

  // Each canvas opens on its latest conversation.
  useEffect(() => {
    let current = true;
    setChats(null);
    setChatId(null);
    setItems([]);
    api.chats(canvas).then((list) => {
      if (!current) return;
      setChats(list);
      setChatId(list[0]?.id ?? null);
    }, (e: Error) => setError(e.message));
    return () => { current = false; };
  }, [api, canvas]);

  const load = useCallback((id: string) => {
    api.chat(id).then((c) => {
      if (chatRef.current !== id) return;
      setItems(c.items);
      setChats((list) => list?.map((x) => (x.id === id ? c.chat : x)) ?? list);
    }, (e: Error) => setError(e.message));
  }, [api]);

  useEffect(() => { if (chatId) load(chatId); }, [chatId, load]);
  // Whatever happened while the connection was down is in the daemon's copy.
  useEffect(() => api.onOpen(() => { if (chatRef.current) load(chatRef.current); }), [api, load]);

  useEffect(() => api.onChat((e: ChatEvent) => {
    if (e.type === 'chat.delta') {
      if (e.chat !== chatRef.current) return;
      setItems((list) => list.map((i) => (i.id === e.item && i.kind === 'assistant' ? { ...i, text: i.text + e.text } : i)));
      return;
    }
    if (e.chat.canvas !== canvas) return;
    setChats((list) => {
      if (!list) return list;
      const rest = list.filter((c) => c.id !== e.chat.id);
      return [e.chat, ...rest];
    });
    const item = e.item;
    if (!item || e.chat.id !== chatRef.current) return;
    setItems((list) => {
      const at = list.findIndex((i) => i.id === item.id);
      return at < 0 ? [...list, item] : list.map((i, n) => (n === at ? item : i));
    });
  }), [api, canvas]);

  const send = useCallback(async (text: string, withSelection: boolean) => {
    setError(null);
    try {
      let id = chatRef.current;
      if (!id) {
        if (!chosen) throw new Error(t('Neither Claude Code nor Codex is installed on this computer.'));
        const created = await api.createChat(chosen.agent, canvas);
        keep(AGENT_KEY, created.agent);
        setChats((list) => [created, ...(list ?? [])]);
        chatRef.current = id = created.id;
        setChatId(created.id);
        setItems([]);
      }
      const selection = api.getSelection();
      await api.sendChat(id, text, withSelection && selection?.canvas === canvas && selection.total ? selection : undefined);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [api, canvas, chosen]);

  const answer = useCallback((request: string, allow: boolean) => {
    if (chatId) api.answerChat(chatId, request, allow).catch((e: Error) => setError(e.message));
  }, [api, chatId]);

  const name = chat ? agents?.find((a) => a.agent === chat.agent)?.name ?? chat.agent : chosen?.name;
  const color = (name && AGENT_COLORS[name]) ?? OTHER_AGENT_COLOR;
  // Finding the CLIs takes a few seconds right after the daemon starts.
  const blocked = chat || chosen ? undefined : t(agents ? 'Install Claude Code or Codex to start' : 'Looking for agents…');

  return (
    <aside
      className="ai-sidebar"
      aria-label={t('AI sidebar')}
      style={{ '--agent': color } as CSSProperties}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        if (settings) onSettings(false);
        else onClose();
      }}
    >
      <header className="ai-head">
        {settings ? (
          <>
            <button className="ai-icon" title={t('Back (Esc)')} aria-label={t('Back')} autoFocus onClick={() => onSettings(false)}>←</button>
            <h2 className="ai-title">{t('Settings')}</h2>
          </>
        ) : (
          <>
            <span className="ai-dot" aria-hidden />
            <select
              className="ai-history"
              aria-label={t('Conversation')}
              value={chatId ?? ''}
              onChange={(e) => { setError(null); setItems([]); setChatId(e.target.value || null); }}
            >
              <option value="">{t('New conversation')}</option>
              {chats?.map((c) => <option key={c.id} value={c.id}>{c.title || t('Untitled')}</option>)}
            </select>
            <button className="ai-icon" title={t('New conversation')} aria-label={t('New conversation')} onClick={() => { setError(null); setChatId(null); setItems([]); }}>+</button>
            <button className="ai-icon" title={t('Settings')} aria-label={t('Settings')} onClick={() => onSettings(true)}><SettingsIcon /></button>
          </>
        )}
        <button className="ai-icon" title={t(settings ? 'Close' : 'Close (Esc)')} aria-label={t('Close')} onClick={onClose}>×</button>
      </header>

      {settings && <AgentSettings api={api} />}

      {/* Hidden, not unmounted: settings keep what is typed and the place in the conversation. */}
      <div className="ai-chat" hidden={settings}>
        {chat ? (
          <div className="ai-meta" title={chat.cwd}>{name}</div>
        ) : (
          <div className="ai-setup">
            <label>
              <span>{t('Agent')}</span>
              <select value={chosen?.agent ?? ''} onChange={(e) => setAgent(e.target.value as AgentId)} disabled={!agents}>
                {!agents && <option value="">{t('Looking…')}</option>}
                {agents?.map((a) => (
                  <option key={a.agent} value={a.agent} disabled={!a.cli}>{a.cli ? a.name : t('{name} (not installed)', { name: a.name })}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <Log items={items} status={status} name={name ?? t('the agent')} empty={!chat} onAnswer={answer} />

        {error && <p className="ai-error ai-banner">{tMessage(error)}</p>}
        <Composer
          api={api}
          canvas={canvas}
          status={status}
          name={name ?? t('the agent')}
          blocked={blocked}
          active={!settings}
          onSend={send}
          onStop={() => { if (chatId) api.stopChat(chatId).catch(() => {}); }}
        />
      </div>
    </aside>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M2 4.5h6.5M12.5 4.5H14M2 11.5h1.5M7.5 11.5H14" />
      <circle cx="10.5" cy="4.5" r="2" />
      <circle cx="5.5" cy="11.5" r="2" />
    </svg>
  );
}

function Log({ items, status, name, empty, onAnswer }: {
  items: ChatItem[];
  status: ChatStatus;
  name: string;
  empty: boolean;
  onAnswer: (request: string, allow: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // Keeps to the newest message unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  });

  const last = items.at(-1);
  const thinking = status === 'working' && !(last?.kind === 'assistant' && last.text) && last?.kind !== 'tool';

  return (
    <div
      ref={box}
      className="ai-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
      }}
      onClick={followLink}
    >
      {empty && !items.length && (
        <p className="ai-hint">
          {t('Ask {name} about this canvas, or to draw on it. Select something first and say “this”.', { name })}
        </p>
      )}
      {items.map((item) => <Item key={item.id} item={item} name={name} onAnswer={onAnswer} />)}
      {thinking && <div className="ai-typing" aria-label={t('Working')}><i /><i /><i /></div>}
    </div>
  );
}

const Item = memo(function Item({ item, name, onAnswer }: {
  item: ChatItem;
  name: string;
  onAnswer: (request: string, allow: boolean) => void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ai-user">
          {item.context && <span className="ai-chip">{tMessage(item.context)}</span>}
          <p>{item.text}</p>
        </div>
      );
    case 'assistant':
      return item.text ? <Markdown text={item.text} /> : null;
    case 'tool':
      return (
        <div className={`ai-tool ${item.state}`} title={item.summary ? `${item.name}: ${tMessage(item.summary)}` : item.name}>
          <span className="ai-tool-dot" aria-hidden />
          <b>{item.name}</b>
          {item.summary && <code>{tMessage(item.summary)}</code>}
        </div>
      );
    case 'approval':
      return (
        <div className={`ai-approval ${item.state}`}>
          <p>{tRich('{name} asks to use {tool}', { name: <b>{name}</b>, tool: <b>{item.tool}</b> })}</p>
          {item.summary && <code>{tMessage(item.summary)}</code>}
          {item.state === 'pending' ? (
            <div className="ai-approval-actions">
              <button className="ai-allow" onClick={() => onAnswer(item.id, true)}>{t('Allow')}</button>
              <button onClick={() => onAnswer(item.id, false)}>{t('Deny')}</button>
            </div>
          ) : (
            <p className="ai-approval-state">{t({ allowed: 'Allowed', denied: 'Denied', cancelled: 'No longer needed' }[item.state])}</p>
          )}
        </div>
      );
    case 'error':
      return <p className="ai-error">{tMessage(item.text)}</p>;
    case 'notice':
      return <p className="ai-hint">{tMessage(item.text)}</p>;
  }
});

function Markdown({ text }: { text: string }) {
  // Agents break lines without blank lines between them, as in a chat.
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true })), [text]);
  return <div className="ai-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Links to a canvas open it here; anything else opens in the browser (the desktop app hands it to the system). */
function followLink(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as Element).closest('a');
  if (!a?.href) return;
  e.preventDefault();
  const url = new URL(a.href, location.href);
  if (url.origin === location.origin && url.hash.startsWith('#/c/')) location.hash = url.hash.replace(/[?&]token=[^&]+/, '');
  else window.open(url.href, '_blank', 'noopener');
}

function Composer({ api, canvas, status, name, blocked, active, onSend, onStop }: {
  api: Api;
  canvas: string;
  status: ChatStatus;
  name: string;
  /** Why nothing can be sent yet, if so. */
  blocked?: string;
  active: boolean;
  onSend: (text: string, withSelection: boolean) => Promise<boolean>;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const report = useSyncExternalStore(api.subscribeSelection, api.getSelection);
  const selection = report?.canvas === canvas && report.total ? report : undefined;
  const label = selection && (selection.total === 1
    ? selection.nodes[0]?.title ?? selection.nodes[0]?.id ?? selection.drawings[0]?.text ?? selection.drawings[0]?.type
    : t('{n} selected', { n: selection.total }));
  // A selection the person took off stays off until they select something else.
  const key = selection && JSON.stringify([selection.nodes.map((n) => n.id), selection.drawings.map((d) => d.id)]);
  const attached = !!selection && dropped !== key;
  const busy = status !== 'idle';

  useEffect(() => { if (active && !blocked) field.current?.focus(); }, [active, blocked]);

  // Grows with what is typed, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy || sending || blocked) return;
    setSending(true);
    setDraft('');
    const sent = await onSend(text, attached);
    if (!sent) setDraft(text);
    setSending(false);
    field.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while composing Hangul (or any IME) finishes the syllable; it does not send.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="ai-composer">
      {selection && (
        <div className="ai-attach">
          {attached ? (
            <span className="ai-chip">
              {label}
              <button aria-label={t('Do not send the selection')} onClick={() => setDropped(key ?? null)}>×</button>
            </span>
          ) : (
            <button className="ai-link" onClick={() => setDropped(null)}>{t('Send {label} along', { label: label ?? '' })}</button>
          )}
        </div>
      )}
      {status === 'waiting' && <p className="ai-hint">{t('{name} is waiting for your answer above.', { name })}</p>}
      <div className="ai-input">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          placeholder={blocked ?? t('Message {name}', { name })}
          disabled={!!blocked}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="ai-send stop" title={t('Stop')} aria-label={t('Stop')} onClick={onStop}>■</button>
        ) : (
          <button className="ai-send" title={t('Send (Enter)')} aria-label={t('Send')} disabled={!draft.trim() || sending || !!blocked} onClick={() => void submit()}>↑</button>
        )}
      </div>
    </div>
  );
}
