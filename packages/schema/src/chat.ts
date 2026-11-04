import type { AgentId } from './agents.ts';

// ---------- chats: Claude Code and Codex in the canvas's AI sidebar ----------

/** idle: the agent waits for the person. working: it is in a turn. waiting: it asks the person to approve something. */
export type ChatStatus = 'idle' | 'working' | 'waiting';

/** A conversation with an agent that runs on this computer, in `cwd`, next to a canvas. */
export interface ChatSummary {
  id: string;
  agent: AgentId;
  /** The canvas it belongs to, which the agent is told the person is looking at. */
  canvas: string;
  cwd: string;
  /** The person's first message, shortened. */
  title: string;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
}

/** One entry of a conversation, as the sidebar shows it. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; at: string; /** What was selected on the canvas and sent along. */ context?: string }
  | { kind: 'assistant'; id: string; text: string; at: string }
  | { kind: 'tool'; id: string; name: string; summary?: string; state: 'running' | 'done' | 'failed'; at: string }
  | { kind: 'approval'; id: string; tool: string; summary?: string; state: 'pending' | 'allowed' | 'denied' | 'cancelled'; at: string }
  | { kind: 'error'; id: string; text: string; at: string }
  /** Something the person should know that is not an error, like a turn they stopped. */
  | { kind: 'notice'; id: string; text: string; at: string };
