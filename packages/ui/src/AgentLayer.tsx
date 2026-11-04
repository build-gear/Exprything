import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { AgentPresence, AgentTarget } from '@exprything/schema';

/** A rectangle of the scene, turned like the element it belongs to. */
export type Zone = { x: number; y: number; w: number; h: number; angle: number };

/** Gap between a target and its zone's border, in screen px. */
export const ZONE_PADDING = 6;
/** How fast a cursor glides: the time to cover about two thirds of the way. */
const GLIDE_MS = 140;
/** How long a cursor stays on each target of several. */
const VISIT_MS = 800;
/** Where a cursor first shows, in screen px from where it is going. */
const ARRIVAL = { x: 180, y: 110 };

/** Each agent's colour, by the name a canvas knows it by. */
export const AGENT_COLORS: Record<string, string> = { 'Claude Code': '#d97757', Codex: '#10a37f' };
export const OTHER_AGENT_COLOR = '#1971c2';

interface SceneProps {
  excalidraw: ExcalidrawImperativeAPI;
  zoneOf: (target: AgentTarget) => Zone;
  /** Calls back when the canvas pans or zooms, or something on it moves. */
  subscribeScene: (listener: () => void) => () => void;
}

/**
 * Who is working on this canvas: each agent's cursor, and a zone around everything it holds. It only
 * draws. DrawCanvas keeps the person's input off what agents hold, so this layer never takes the pointer.
 */
export function AgentLayer({ agents, root, ...scene }: SceneProps & { agents: AgentPresence[]; root: Element }) {
  return createPortal(
    <div className="agent-layer" aria-hidden>
      {agents.map((agent) => (
        <div key={agent.id} style={{ '--agent': AGENT_COLORS[agent.name] ?? OTHER_AGENT_COLOR } as CSSProperties}>
          {agent.targets.map((target) => <AgentZone key={target.node} target={target} {...scene} />)}
          <AgentCursor agent={agent} {...scene} />
        </div>
      ))}
    </div>,
    root,
  );
}

function AgentZone({ target, excalidraw, zoneOf, subscribeScene }: SceneProps & { target: AgentTarget }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const place = () => {
      const zone = zoneOf(target);
      const { scrollX, scrollY, zoom } = excalidraw.getAppState();
      Object.assign(box.current!.style, {
        left: `${(zone.x + scrollX) * zoom.value - ZONE_PADDING}px`,
        top: `${(zone.y + scrollY) * zoom.value - ZONE_PADDING}px`,
        width: `${zone.w * zoom.value + ZONE_PADDING * 2}px`,
        height: `${zone.h * zoom.value + ZONE_PADDING * 2}px`,
        transform: zone.angle ? `rotate(${zone.angle}rad)` : '',
      });
    };
    place();
    return subscribeScene(place);
  }, [target, excalidraw, zoneOf, subscribeScene]);

  return <div ref={box} className="agent-zone" />;
}

/** Glides from target to target in scene coordinates, and stays at the edge of the view when its target is off it. */
function AgentCursor({ agent, excalidraw, zoneOf, subscribeScene }: SceneProps & { agent: AgentPresence }) {
  const box = useRef<HTMLDivElement>(null);
  const at = useRef<{ x: number; y: number } | null>(null);
  const [visit, setVisit] = useState(0);
  const count = agent.targets.length;
  const target = count ? agent.targets[visit % count] : undefined;

  useEffect(() => {
    if (count < 2) return;
    const timer = setInterval(() => setVisit((v) => v + 1), VISIT_MS);
    return () => clearInterval(timer);
  }, [count]);

  useEffect(() => {
    const place = () => {
      const { scrollX, scrollY, zoom, width, height } = excalidraw.getAppState();
      const el = box.current!;
      const x = (at.current!.x + scrollX) * zoom.value;
      const y = (at.current!.y + scrollY) * zoom.value;
      const shownX = Math.max(0, Math.min(x, width - el.offsetWidth));
      const shownY = Math.max(0, Math.min(y, height - el.offsetHeight));
      el.style.transform = `translate(${shownX}px, ${shownY}px)`;
      el.classList.toggle('off-view', x < 0 || x > width || y < 0 || y > height);
    };

    const { scrollX, scrollY, zoom, width, height } = excalidraw.getAppState();
    const zone = target && zoneOf(target);
    // With nothing to change it comes to the middle of the view, and then stays where it is.
    const goal = zone
      ? { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 }
      : at.current ?? { x: width / 2 / zoom.value - scrollX, y: height / 2 / zoom.value - scrollY };
    at.current ??= { x: goal.x + ARRIVAL.x / zoom.value, y: goal.y + ARRIVAL.y / zoom.value };

    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const p = at.current!;
      const k = smooth ? 1 - Math.exp((last - now) / GLIDE_MS) : 1;
      last = now;
      p.x += (goal.x - p.x) * k;
      p.y += (goal.y - p.y) * k;
      place();
      if (Math.hypot(goal.x - p.x, goal.y - p.y) > 0.5) frame = requestAnimationFrame(step);
    };
    place();
    frame = requestAnimationFrame(step);
    const unsubscribe = subscribeScene(place);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [target?.node, target?.x, target?.y, target?.w, target?.h, excalidraw, zoneOf, subscribeScene]);

  return (
    <div ref={box} className="agent-cursor">
      <svg width="20" height="24" viewBox="0 0 20 24">
        <path
          d="M2 2v16l4.6-4 3.2 7.4 3-1.3-3.2-7.3H16z"
          fill="var(--agent)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"
        />
      </svg>
      <span>{agent.name}</span>
    </div>
  );
}
