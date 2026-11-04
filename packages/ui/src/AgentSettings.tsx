import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus } from '@exprything/schema';
import type { Api } from './api.ts';

/**
 * The AI sidebar's settings, for the agents' own sessions outside it; the sidebar needs none of this. They
 * connect Claude Code and Codex the way `exp connect` does: the exprything MCP server in each agent, which the
 * desktop app adds once by itself, and, when the person turns it on, the hooks that report what the agent does
 * to the agent-activity canvas.
 */
export function AgentSettings({ api }: { api: Api }) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agents().then(setAgents, (e: Error) => setError(e.message));
  }, [api]);

  const act = useCallback(async (key: string, change: () => Promise<AgentStatus>) => {
    setBusy(key);
    setError(null);
    try {
      const s = await change();
      setAgents((list) => list?.map((a) => (a.agent === s.agent ? s : a)) ?? [s]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="ai-settings">
      <p className="ai-muted">
        This sidebar needs no setup. Connected agents can also draw on your canvases from their own sessions, such as
        in your terminal.
      </p>
      {error && <p className="agent-error">{error}</p>}
      {!agents && !error && <p className="ai-muted">Looking for agents…</p>}
      {agents?.map((s) => <Agent key={s.agent} status={s} busy={busy} act={act} api={api} />)}
      <footer className="ai-settings-foot">
        {agents?.some((a) => a.activity !== 'off') && <a href="#/c/agent-activity">Open agent activity</a>}
        <span className="ai-muted">Agents pick up changes in their next session.</span>
      </footer>
    </div>
  );
}

function Agent({ status: s, busy, act, api }: {
  status: AgentStatus;
  busy: string | null;
  act: (key: string, change: () => Promise<AgentStatus>) => void;
  api: Api;
}) {
  const id = s.agent;
  const label = (key: string, text: string) => (busy === `${id}:${key}` ? '…' : text);
  const mcp = s.mcp.connected ? (s.mcp.outdated ? 'Connected, with an older setup' : 'Connected') : 'Not connected';
  return (
    <div className="agent">
      <div className="agent-name">
        {s.name}
        <span className="ai-muted">{s.cli ? (s.cli.version ?? '') : 'not found on this computer'}</span>
      </div>
      <div className="agent-row">
        <span>Canvas tools</span>
        <span className={s.mcp.connected ? 'agent-state on' : 'agent-state'} title={s.mcp.command?.join(' ')}>{mcp}</span>
        {s.mcp.connected && !s.mcp.outdated ? (
          <button disabled={!!busy} onClick={() => act(`${id}:mcp`, () => api.disconnectAgent(id))}>{label('mcp', 'Disconnect')}</button>
        ) : (
          <button disabled={!!busy || !s.cli} onClick={() => act(`${id}:mcp`, () => api.connectAgent(id))}>
            {label('mcp', s.mcp.outdated ? 'Update' : 'Connect')}
          </button>
        )}
      </div>
      <div className="agent-row">
        <span>Activity</span>
        <span className={s.activity === 'on' ? 'agent-state on' : 'agent-state'}>
          {s.activity === 'on' ? 'Reported to the canvas' : s.activity === 'partial' ? 'Partly on' : 'Off'}
        </span>
        <button disabled={!!busy} onClick={() => act(`${id}:activity`, () => api.setAgentActivity(id, s.activity !== 'on'))}>
          {label('activity', s.activity === 'on' ? 'Turn off' : 'Turn on')}
        </button>
      </div>
      {s.notes.map((n) => <p key={n} className="agent-note">{n}</p>)}
      {!s.cli && <pre className="agent-manual">{s.manual.join('\n')}</pre>}
    </div>
  );
}
