import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';

/**
 * Light-ramp token hexes (src/styles/tokens/colors.css): the 50 tint and 500
 * strong of each of the six ramps. Literal on purpose — mermaid text is
 * portable, so the file gets fixed bytes, not var() references that only this
 * app could resolve (D5).
 */
export const STYLE_SWATCHES: readonly string[] = [
  '#f6f7fa', // n-50
  '#7e8699', // n-500
  '#eef1fe', // cortex-50
  '#3d5bde', // cortex-500
  '#f5f0fe', // synapse-50
  '#8250dc', // synapse-500
  '#e9f7f0', // success-50
  '#1f9d61', // success-500
  '#fcf3e1', // warn-50
  '#de8f0a', // warn-500
  '#fdedef', // danger-50
  '#de3b4e', // danger-500
];

const ROWS = [
  { key: 'fill', label: 'Fill' },
  { key: 'stroke', label: 'Border' },
  { key: 'color', label: 'Text' }, // mermaid's text-color key is `color`
] as const;

/**
 * Node color menu (M29.33): three declaration rows, 12 swatches + clear each,
 * every press one setNodeStyle patch — one style-line edit, one undo step.
 *
 * `current` is the FOLDED reading of every style line for the node
 * (`nodeStyle`), which is what mermaid actually renders, so the marked swatch
 * is the colour on screen even when two `style` lines disagree.
 *
 * A press that cannot change anything emits no patch at all. StructuralEditor's
 * `apply` already drops byte-identical output, but that only catches an
 * existing line whose bytes are already canonical: re-picking the colour of
 * `style A fill: #eef1fe` would re-emit it reformatted and cost a real undo
 * step for a click that changed no colour. Here the answer is known without
 * looking at the bytes.
 *
 * Keyboard behavior is ShapePalette's, deliberately: these two popovers open
 * from adjacent buttons on one toolbar, and `trapFocus` on one but not the
 * other would make Tab mean different things a centimetre apart.
 */
export function NodeStyleMenu({
  current,
  onPatch,
  onClose,
}: {
  /** The node's current style declarations (nodeStyle(model, id)). */
  current: Record<string, string>;
  onPatch: (patch: Record<string, string | null>) => void;
  onClose: () => void;
}) {
  return (
    <Popover
      onClose={onClose}
      role="dialog"
      ariaLabel="Node colors"
      trapFocus
      // Popover contributes `cb-menu-in`, which is an ANIMATION and nothing
      // else — the panel is always the caller's. See ShapePalette for the
      // failure this quartet prevents.
      className="rounded-lg border border-n-200 bg-n-0 p-2 shadow-[var(--shadow-lg)]"
    >
      <div
        data-testid="node-style-menu"
        // Portals bubble through the REACT tree, so a keystroke in here reaches
        // StructuralEditor's onKeyDown — where Backspace/Delete removes the
        // selected node. Tab in, press Backspace, and the node you came to
        // colour is gone. (ShapePalette's search box stops the same leak for
        // the same reason; its buttons needed this too.)
        onKeyDown={(e) => e.stopPropagation()}
        className="flex flex-col gap-1.5"
      >
        {ROWS.map((row) => (
          <div key={row.key} className="flex items-center gap-1">
            {/* A heading, not a span: the three rows are this menu's only
                structure, and heading navigation is how a screen reader walks
                it — the same call ShapePalette made for its categories. */}
            <h3 className="w-10 flex-none text-[11px] font-normal text-n-500">{row.label}</h3>
            {STYLE_SWATCHES.map((hex, i) => (
              <button
                key={hex}
                // The first control takes focus on open, as ShapePalette's
                // search box does: two sibling popovers where Tab means
                // different things is worse than either behavior alone.
                autoFocus={row.key === 'fill' && i === 0}
                type="button"
                aria-label={`${row.label} ${hex}`}
                aria-pressed={current[row.key] === hex}
                title={hex}
                onClick={() => {
                  // A press that cannot change anything still DISMISSES —
                  // closing is the caller's job, done through onPatch, so an
                  // early return alone left this one swatch inert while its
                  // eleven neighbours closed the menu.
                  if (current[row.key] === hex) {
                    onClose();
                    return;
                  }
                  onPatch({ [row.key]: hex });
                }}
                className={`h-4 w-4 flex-none rounded-sm border ${
                  current[row.key] === hex ? 'border-cortex-500' : 'border-n-200'
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
            <button
              type="button"
              aria-label={`Clear ${row.label.toLowerCase()}`}
              title={`Clear ${row.label.toLowerCase()}`}
              onClick={() => {
                if (current[row.key] === undefined) {
                  onClose();
                  return;
                }
                onPatch({ [row.key]: null });
              }}
              className="rounded border-0 bg-transparent p-0.5 hover:bg-n-50"
            >
              <Icon name="eraser" size={12} color="var(--n-500)" />
            </button>
          </div>
        ))}
      </div>
    </Popover>
  );
}
