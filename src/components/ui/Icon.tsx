import React from 'react';
import { icons } from 'lucide-react';

/** Lucide line icon (bundled via lucide-react), 1.75 stroke, currentColor. */
export interface IconProps {
  /** lucide icon name, kebab-case, e.g. "target", "layout-grid" */
  name: string;
  /** px, default 16 */
  size?: number;
  /** default 1.75 */
  strokeWidth?: number;
  /** css color; defaults to currentColor */
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * Lucide renamed its shape-qualified icons in 0.4xx (`check-square` ->
 * `square-check`) and dropped the old exports entirely. Vault type files and
 * user-authored `icon:` frontmatter still carry the old names — and used to
 * render as an empty svg. Aliasing keeps those vaults working.
 */
export const ICON_ALIASES: Record<string, string> = {
  'alert-circle': 'circle-alert',
  'alert-octagon': 'octagon-alert',
  'alert-triangle': 'triangle-alert',
  'arrow-down-circle': 'circle-arrow-down',
  'arrow-left-circle': 'circle-arrow-left',
  'arrow-right-circle': 'circle-arrow-right',
  'arrow-up-circle': 'circle-arrow-up',
  'check-circle': 'circle-check',
  'check-circle-2': 'circle-check-big',
  'check-square': 'square-check',
  'check-square-2': 'square-check-big',
  'chevron-down-circle': 'circle-chevron-down',
  'chevron-left-circle': 'circle-chevron-left',
  'chevron-right-circle': 'circle-chevron-right',
  'chevron-up-circle': 'circle-chevron-up',
  // Renamed twice: help-circle -> circle-help -> circle-question-mark. The
  // middle hop is dead too, so both old spellings map straight to the survivor.
  'circle-help': 'circle-question-mark',
  'edit-2': 'pencil',
  'edit-3': 'pen-line',
  'external-link': 'square-arrow-out-up-right',
  'gantt-chart': 'chart-gantt',
  'help-circle': 'circle-question-mark',
  // The spec name for the layout-editor doors (M45.2) — lucide shipped the
  // rename before the doors did.
  layout: 'panels-top-left',
  'minus-circle': 'circle-minus',
  'more-horizontal': 'ellipsis',
  'more-vertical': 'ellipsis-vertical',
  'pause-circle': 'circle-pause',
  'play-circle': 'circle-play',
  'plus-circle': 'circle-plus',
  'stop-circle': 'circle-stop',
  'user-circle': 'circle-user',
  'wand-2': 'wand-sparkles',
  'x-circle': 'circle-x',
  'x-octagon': 'octagon-x',
  'x-square': 'square-x',
};

/** Drawn when a name resolves to nothing, so a bad icon is visible, not blank. */
const FALLBACK_ICON = 'square-dashed';

const pascal = (n: string) =>
  n
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join('');

const warned = new Set<string>();

/** Resolve a kebab-case lucide name through the alias table. Exported for tests. */
export function resolveIcon(name: string): { Comp: (typeof icons)[keyof typeof icons] | null } {
  const direct = icons[pascal(name) as keyof typeof icons];
  if (direct) return { Comp: direct };
  const aliased = ICON_ALIASES[name];
  if (aliased) {
    const viaAlias = icons[pascal(aliased) as keyof typeof icons];
    if (viaAlias) return { Comp: viaAlias };
  }
  return { Comp: null };
}

export function Icon({ name, size = 16, strokeWidth = 1.75, color, style, className }: IconProps) {
  const baseStyle: React.CSSProperties = {
    flex: 'none',
    display: 'inline-block',
    verticalAlign: 'middle',
    color,
    ...style,
  };
  const { Comp } = resolveIcon(name);
  if (!Comp) {
    // Silence used to mean a user typo produced an invisible hole with no clue
    // anywhere — in the UI, the console, or the type editor. Warn once per bad
    // name and draw a visible placeholder instead.
    if (import.meta.env.DEV && !warned.has(name)) {
      warned.add(name);
      console.warn(
        `[Icon] unknown icon name "${name}" — no such lucide icon. Rendering "${FALLBACK_ICON}".`,
      );
    }
    const Fallback = icons[pascal(FALLBACK_ICON) as keyof typeof icons];
    return (
      <Fallback
        size={size}
        strokeWidth={strokeWidth}
        className={className}
        style={baseStyle}
        aria-hidden="true"
        data-icon={name}
        data-unknown-icon={name}
      />
    );
  }
  return (
    <Comp
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={baseStyle}
      aria-hidden="true"
      // The name, in the DOM (M16.35). lucide's own `lucide-*` class is a
      // third-party string that has already been renamed once in this
      // codebase's lifetime (see ICON_ALIASES), so a stylesheet that needs to
      // tell one glyph from another — the table hiding its dropdown chevrons
      // at rest, styles/table-chrome.css — keys on an attribute we own.
      data-icon={name}
    />
  );
}
