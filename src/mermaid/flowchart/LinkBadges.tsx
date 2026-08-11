import type { CSSProperties } from 'react';
import { Icon } from '@/components/ui/Icon';
import { isVaultPath, isWebUrl } from './linkTargets';

export interface LinkBadge {
  /** The node id this badge belongs to. */
  id: string;
  target: string;
  /** True when a click statement the editor does not own also writes this slot. */
  contested: boolean;
  /**
   * The node's own top-right corner, in host-relative plane coordinates
   * (already divided by the canvas scale). The half-badge offset that centres
   * the dot on it is a SCREEN constant and lives in `chrome`, not here.
   */
  x: number;
  y: number;
}

/**
 * The hit target for a node's link (M29.38).
 *
 * The BADGE navigates, never the node — clicking a node selects it, which is
 * the whole reason `bindFlowchartSvg` strips mermaid's own `<a href>` off the
 * rendered picture. So the affordance has to exist somewhere visible, and this
 * is it: one small button pinned to each linked node's top-right corner, in
 * the same plane coordinates every other overlay uses (so it rides a
 * CanvasViewport pan and zoom instead of drifting off its node) and
 * counter-scaled, so it stays a 14px dot rather than growing into a 56px one.
 *
 * Only `http(s)` ever reaches `window.open`, and never with an opener to
 * hijack. A scheme-less target is a vault path handed to the host's own router
 * — or, where the host gave none, nothing at all: degradation, never a crash.
 * A target that is NEITHER (`mailto:`, `tel:`, `file:` — hand-written only,
 * since the popover offers no such thing) disables the badge and says why,
 * rather than asking the router to open a doc called `mailto:x@y.com`.
 */
/** What the badge says about itself — a refusal names itself, as everywhere else here. */
function badgeTitle(b: LinkBadge): string {
  if (!isWebUrl(b.target) && !isVaultPath(b.target)) {
    return `${b.target} — not a web address or a vault path, so the editor cannot open it`;
  }
  if (b.contested) {
    return `${b.target} — another click line also links this node, so the diagram may open something else`;
  }
  return b.target;
}

export function LinkBadges({
  badges,
  onOpenPath,
  chrome,
}: {
  badges: LinkBadge[];
  onOpenPath?: (path: string) => void;
  /**
   * The counter-scale that keeps a 14px badge 14px at every zoom (M29.51),
   * plus the half-badge offset that centres it on its node's corner — both
   * built fresh per render by the editor's `screenChrome`, so a wheel-zoom
   * re-applies them instead of leaving a badge measured at the old scale
   * (M29.53). `undefined` off a viewport with nothing to offset.
   */
  chrome?: CSSProperties;
}) {
  return (
    <>
      {badges.map((b) => (
        <button
          key={b.id}
          type="button"
          data-testid="mermaid-link-badge"
          aria-label={`Open link on ${b.id}`}
          disabled={!isWebUrl(b.target) && !isVaultPath(b.target)}
          title={badgeTitle(b)}
          className="absolute z-10 flex h-4 w-4 items-center justify-center rounded-full border border-n-200 bg-n-0 shadow-sm hover:bg-n-50 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ left: b.x, top: b.y, ...chrome }}
          onClick={(e) => {
            e.stopPropagation();
            if (isWebUrl(b.target)) {
              window.open(b.target, '_blank', 'noopener,noreferrer');
            } else if (isVaultPath(b.target)) {
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
