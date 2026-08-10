import { Icon } from '@/components/ui/Icon';

export interface LinkBadge {
  /** The node id this badge belongs to. */
  id: string;
  target: string;
  /** True when a click statement the editor does not own also writes this slot. */
  contested: boolean;
  /** Host-relative plane coordinates, already divided by the canvas scale. */
  x: number;
  y: number;
}

/** A target the badge hands to `window.open`; everything else is a vault path. */
const URL_RE = /^https?:\/\//;

/**
 * The hit target for a node's link (M29.38).
 *
 * The BADGE navigates, never the node — clicking a node selects it, which is
 * the whole reason `bindFlowchartSvg` strips mermaid's own `<a href>` off the
 * rendered picture. So the affordance has to exist somewhere visible, and this
 * is it: one small button pinned to each linked node's top-right corner, in
 * the same plane coordinates every other overlay uses (so it scales with a
 * CanvasViewport zoom instead of drifting off its node).
 *
 * Only `http(s)` ever reaches `window.open`, and never with an opener to
 * hijack. Everything else is a vault path handed to the host's own router —
 * or, where the host gave none, nothing at all: degradation, never a crash.
 */
export function LinkBadges({
  badges,
  onOpenPath,
}: {
  badges: LinkBadge[];
  onOpenPath?: (path: string) => void;
}) {
  return (
    <>
      {badges.map((b) => (
        <button
          key={b.id}
          type="button"
          data-testid="mermaid-link-badge"
          aria-label={`Open link on ${b.id}`}
          title={
            b.contested
              ? `${b.target} — another click line also links this node, so the diagram may open something else`
              : b.target
          }
          className="absolute z-10 flex h-4 w-4 items-center justify-center rounded-full border border-n-200 bg-n-0 shadow-sm hover:bg-n-50"
          style={{ left: b.x, top: b.y }}
          onClick={(e) => {
            e.stopPropagation();
            if (URL_RE.test(b.target)) {
              window.open(b.target, '_blank', 'noopener,noreferrer');
            } else {
              onOpenPath?.(b.target);
            }
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Icon name="link" size={9} color="var(--cortex-600)" />
        </button>
      ))}
    </>
  );
}
