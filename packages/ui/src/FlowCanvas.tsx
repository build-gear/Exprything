import {
  Background, Controls, NodeResizer, ReactFlow, useNodesState,
  type Node, type NodeProps, type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useContext, useEffect, useRef } from 'react';
import type { CanvasView, NodeView } from '@exprything/schema';
import { CanvasCtx } from './context.ts';
import { WidgetCard } from './WidgetCard.tsx';

type WidgetNodeType = Node<{ view: NodeView }, 'widget'>;

/** The original React Flow renderer: widgets only, no drawing tools. */
export function FlowCanvas({ view }: { view: CanvasView }) {
  const { api, canvas } = useContext(CanvasCtx);
  const [nodes, setNodes, onNodesChange] = useNodesState<WidgetNodeType>([]);
  const dragging = useRef<string | null>(null);

  useEffect(() => {
    setNodes((prev) =>
      view.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id);
        const keep = old && dragging.current === n.id;
        return {
          id: n.id,
          type: 'widget',
          dragHandle: '.wn-head',
          position: keep ? old.position : { x: n.x, y: n.y },
          width: n.w,
          height: n.h,
          data: { view: n },
        };
      }),
    );
  }, [view, setNodes]);

  const onDragStart: OnNodeDrag<WidgetNodeType> = (_e, n) => { dragging.current = n.id; };
  const onDragStop: OnNodeDrag<WidgetNodeType> = (_e, n) => {
    dragging.current = null;
    void api.moveNode(canvas, n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) });
  };

  return (
    <ReactFlow
      nodes={nodes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onDragStart}
      onNodeDragStop={onDragStop}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function WidgetNode({ data, selected }: NodeProps<WidgetNodeType>) {
  const { api, canvas } = useContext(CanvasCtx);
  const n = data.view;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={100}
        onResizeEnd={(_e, p) => void api.moveNode(canvas, n.id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
      />
      <WidgetCard view={n} />
    </>
  );
}

const nodeTypes = { widget: WidgetNode };
