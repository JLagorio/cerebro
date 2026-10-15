import { memo, useId, type ReactNode } from 'react';
import { paintOrder } from '@/engine/scene/board';
import { arrowHead, edgeLabelBox, edgeRoute, groupLabelBox, sceneBox } from '@/engine/scene/figure';
import { strokeOutline } from '@/engine/scene/ink';
import type { Board, BoardEdge, BoardNode, InkStroke, ItemKey } from '@/engine/scene/model';
import { CanvasText } from './CanvasText';
import { presetPaint } from './palette';

const pointList = (points: readonly { x: number; y: number }[]) =>
  points.map((p) => `${p.x},${p.y}`).join(' ');
export const NodeView = memo(function NodeView({
  node,
  prefix,
  editing = false,
  renderNodeContent,
}: {
  node: BoardNode;
  prefix: string;
  editing?: boolean;
  renderNodeContent?: (node: BoardNode) => ReactNode;
}) {
  const paint = presetPaint(node.color);
  const stroke = paint ?? 'var(--n-300)';
  const fill = paint ? `color-mix(in srgb, ${paint} 10%, var(--n-0))` : 'var(--n-0)';
  const { x, y, width, height } = node;
  const ellipse = node.type === 'text' && node.shape === 'ellipse';
  const diamond = node.type === 'text' && node.shape === 'diamond';
  const clip = `${prefix}-${[...node.id].map((c) => c.codePointAt(0)!.toString(16)).join('-')}`;
  const shape = ellipse ? (
    <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} />
  ) : diamond ? (
    <polygon
      points={`${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`}
    />
  ) : (
    <rect x={x} y={y} width={width} height={height} rx={6} />
  );
  const text =
    node.type === 'text'
      ? node.text
      : node.type === 'file'
        ? node.file + (node.subpath ?? '')
        : node.type === 'link'
          ? node.url
          : (node.label ?? '');
  if (node.type === 'group') {
    const label = groupLabelBox(node);
    return (
      <g data-testid="wb-node" data-node-id={node.id} data-node-type={node.type}>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={8}
          fill={paint ?? 'var(--n-200)'}
          fillOpacity={0.06}
          stroke={stroke}
          strokeWidth={1.5}
        />
        {text !== '' && !editing && (
          <>
            <defs>
              <clipPath id={clip}>
                <rect {...label} />
              </clipPath>
            </defs>
            <text
              x={label.x + 4}
              y={label.y + 17}
              fontSize={14}
              fontWeight={600}
              fill="var(--n-600)"
              clipPath={`url(#${clip})`}
            >
              {text}
            </text>
          </>
        )}
      </g>
    );
  }
  const padX = diamond ? width * 0.23 : ellipse ? width * 0.16 : 12;
  const padY = diamond ? height * 0.25 : ellipse ? height * 0.18 : 12;
  return (
    <g
      data-testid="wb-node"
      data-node-id={node.id}
      data-node-type={node.type}
      data-node-shape={node.type === 'text' ? node.shape : undefined}
    >
      <defs>
        <clipPath id={clip}>{shape}</clipPath>
      </defs>
      <g fill={fill} stroke={stroke} strokeWidth={1.5}>
        {shape}
      </g>
      <foreignObject
        data-board-export-text={text}
        visibility={editing ? 'hidden' : undefined}
        x={x + padX}
        y={y + padY}
        width={Math.max(0, width - 2 * padX)}
        height={Math.max(0, height - 2 * padY)}
        clipPath={`url(#${clip})`}
      >
        {node.type !== 'text' && renderNodeContent ? (
          renderNodeContent(node)
        ) : node.type === 'text' ? (
          <CanvasText text={text} />
        ) : (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              color: 'var(--n-700)',
              overflowWrap: 'anywhere',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'var(--n-500)',
                marginBottom: 6,
              }}
            >
              {node.type === 'file' ? 'File' : 'Link'}
            </div>
            {text}
          </div>
        )}
      </foreignObject>
    </g>
  );
});
export const EdgeView = memo(function EdgeView({
  edge,
  from,
  to,
  editing = false,
}: {
  edge: BoardEdge;
  from: BoardNode | undefined;
  to: BoardNode | undefined;
  editing?: boolean;
}) {
  if (from === undefined || to === undefined) return null;
  const route = edgeRoute(edge, from, to);
  const color = presetPaint(edge.color) ?? 'var(--n-500)';
  const label = edgeLabelBox(edge, route);
  return (
    <g data-testid="wb-edge" data-edge-id={edge.id}>
      <path d={route.path} fill="none" stroke={color} strokeWidth={1.7} />
      {edge.fromEnd === 'arrow' && (
        <polygon points={pointList(arrowHead(route.from, route.c1))} fill={color} />
      )}
      {edge.toEnd !== 'none' && (
        <polygon points={pointList(arrowHead(route.to, route.c2))} fill={color} />
      )}
      {edge.label && !editing && (
        <text
          x={label.x + label.width / 2}
          y={label.y + 16}
          textAnchor="middle"
          fontSize={12}
          fill="var(--n-700)"
          stroke="var(--n-0)"
          strokeWidth={5}
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          {edge.label}
        </text>
      )}
    </g>
  );
});
const InkView = memo(function InkView({ ink }: { ink: InkStroke }) {
  return (
    <path
      data-testid="wb-ink"
      data-ink-id={ink.id}
      d={strokeOutline(ink).path}
      fill={presetPaint(ink.color) ?? 'var(--n-700)'}
    />
  );
});
/** editingId hides only that card's painted text; fadedIds previews an eraser
 * without changing the scene or its file. Neither enters the saved model. */
export function SceneSvg({
  board,
  name = 'Whiteboard',
  editingId,
  editingEdgeId,
  fadedIds,
  renderNodeContent,
}: {
  board: Board;
  name?: string;
  editingId?: string;
  editingEdgeId?: string;
  fadedIds?: ReadonlySet<ItemKey>;
  renderNodeContent?: (node: BoardNode) => ReactNode;
}) {
  const prefix = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const box = sceneBox(board);
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        data-testid="wb-scene"
        data-canvas-content="true"
        width={box.width}
        height={box.height}
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        role="img"
        aria-label={name}
        style={{ overflow: 'visible' }}
      >
        <title>{name}</title>
        {paintOrder(board).map((entry) => (
          <g key={entry.key} opacity={fadedIds?.has(entry.key) ? 0.2 : undefined}>
            {entry.kind === 'n' ? (
              <NodeView
                node={entry.item}
                prefix={prefix}
                editing={editingId === entry.item.id}
                renderNodeContent={renderNodeContent}
              />
            ) : entry.kind === 'e' ? (
              <EdgeView
                key={entry.key}
                edge={entry.item}
                editing={editingEdgeId === entry.item.id}
                from={board.nodes.get(entry.item.fromNode)}
                to={board.nodes.get(entry.item.toNode)}
              />
            ) : (
              <InkView key={entry.key} ink={entry.item} />
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
