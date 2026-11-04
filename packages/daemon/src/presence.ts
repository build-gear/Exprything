import type { AgentIdentity, AgentPresence, AgentTarget } from '@exprything/schema';

/** How long a dry run holds what it touched, while the agent decides whether to apply. */
const LEASE_MS = 20_000;
/** An apply is instant; what it changed stays held long enough for the person to see the cursor go over it. */
const APPLY_HOLD_MS = 1_500;
const APPLY_HOLD_PER_TARGET_MS = 500;
const MAX_APPLY_HOLD_MS = 6_000;
/** How long a cursor stays once the agent holds nothing and has stopped calling. */
const LINGER_MS = 10_000;

/** Which agents are at work on which canvas, and what they hold. An agent is on one canvas at a time. */
export class Presence {
  private agents = new Map<string, { presence: AgentPresence; timer: NodeJS.Timeout }>();

  constructor(private publish: (agents: AgentPresence[]) => void) {}

  list(): AgentPresence[] {
    return [...this.agents.values()].map((a) => a.presence);
  }

  /** The agent read the canvas: its cursor shows there, and anything it holds stays held. */
  visit(agent: AgentIdentity, canvas: string): void {
    const now = this.agents.get(agent.id)?.presence;
    if (now?.canvas === canvas && now.targets.length) return;
    this.set(agent, canvas, []);
  }

  /** A dry run: `targets` are held until the agent applies or the lease runs out. */
  reserve(agent: AgentIdentity, canvas: string, targets: AgentTarget[]): void {
    this.set(agent, canvas, targets, LEASE_MS);
  }

  /** A real apply: `targets` are held a moment longer, then let go. */
  applying(agent: AgentIdentity, canvas: string, targets: AgentTarget[]): void {
    this.set(agent, canvas, targets, Math.min(APPLY_HOLD_MS + APPLY_HOLD_PER_TARGET_MS * targets.length, MAX_APPLY_HOLD_MS));
  }

  /** The agent's request failed: nothing it asked for is happening. */
  release(agent: AgentIdentity): void {
    const now = this.agents.get(agent.id)?.presence;
    if (now) this.set(agent, now.canvas, []);
  }

  private set(agent: AgentIdentity, canvas: string, targets: AgentTarget[], holdMs = LINGER_MS): void {
    const before = this.agents.get(agent.id);
    clearTimeout(before?.timer);
    const presence: AgentPresence = { id: agent.id, name: agent.name, canvas, targets };
    // What it holds goes first; the cursor stays a while longer.
    const timer = setTimeout(() => (targets.length ? this.release(agent) : this.leave(agent.id)), holdMs);
    timer.unref();
    this.agents.set(agent.id, { presence, timer });
    if (JSON.stringify(before?.presence) !== JSON.stringify(presence)) this.publish(this.list());
  }

  private leave(id: string): void {
    this.agents.delete(id);
    this.publish(this.list());
  }
}
