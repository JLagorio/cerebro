const FALLBACK = 'var(--cortex-500)';

/** Resolve a frontmatter color value (hex, css var, or DS swatch name) to a CSS color. */
export function swatchColor(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return FALLBACK;
  const value = raw.trim();
  if (value.startsWith('#') || value.startsWith('var(')) return value;
  return `var(--swatch-${value})`;
}

// --- Option and status colours (M16.12) ------------------------------------

/**
 * Notion's ten, verbatim and in its order.
 *
 * `default` is stored as NULL, never as the word: `optionToSpec`
 * (engine/typeCatalog) drops a null colour so an uncoloured option round-trips
 * through YAML as a bare string instead of a mapping. Writing "default" would
 * turn every plain option into `{ id, color: default }` on disk.
 */
export const OPTION_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;

export type OptionColorName = (typeof OPTION_COLORS)[number];

/** The ones a round-robin hands out — `default` is the absence of a choice. */
export const PICKABLE_OPTION_COLORS = OPTION_COLORS.filter((c) => c !== 'default');

const NAMED = new Set<string>(OPTION_COLORS);

export interface OptionSwatch {
  /** The stored name, or null for default / a legacy raw value. */
  name: OptionColorName | null;
  /** Dot, fill, border. */
  solid: string;
  /** The pill behind a tag. */
  tint: string;
  /** Text on that pill. Never the raw hue — that is the 1.8:1 bug. */
  ink: string;
}

const NEUTRAL: OptionSwatch = {
  name: 'default',
  solid: 'var(--n-300)',
  tint: 'var(--n-100)',
  ink: 'var(--n-700)',
};

/**
 * One resolver for every option, status and group colour (M16.12).
 *
 * Two shapes have to coexist forever. A named colour is what the pickers
 * write from now on, and reads as a token triple. A RAW value — every one of
 * the 81 `color:` entries in the demo vault, and every user vault in
 * existence — keeps rendering exactly as it did; a files-first app does not
 * get to invalidate what is already on disk.
 *
 * The tint is `color-mix`, not `${hex}22`. String concatenation only works
 * for a 6-digit hex: `#fff` became `#fff22`, an invalid declaration the
 * browser drops, so a three-digit hex rendered a transparent pill. `var(…)`
 * was worse — it produced `var(--x)22` and failed the same way, silently.
 *
 * An unrecognised bare word is NOT passed to `swatchColor`. That would route
 * `teal` and `amber` to the older `--swatch-*` palette while `blue` and
 * `green` came from here, shipping two different blues; and it would pair a
 * coloured dot with a neutral pill. Unknown means neutral, all the way.
 */
export function resolveOptionColor(raw: unknown): OptionSwatch {
  if (typeof raw !== 'string' || raw.trim() === '') return NEUTRAL;
  const value = raw.trim();
  if (value === 'default') return NEUTRAL;
  if (NAMED.has(value)) {
    return {
      name: value as OptionColorName,
      solid: `var(--opt-${value})`,
      tint: `var(--opt-${value}-bg)`,
      ink: `var(--opt-${value}-ink)`,
    };
  }
  // Legacy: a hex, an rgb()/hsl(), a css var, or a bare CSS keyword someone
  // hand-wrote into their vault. color-mix accepts all of them.
  const legacy = value.startsWith('#') || value.includes('(') || CSS_WORD.test(value);
  if (!legacy) return NEUTRAL;
  return {
    name: null,
    solid: value,
    tint: `color-mix(in srgb, ${value} 14%, var(--n-0))`,
    // Deliberately not `value`: painting the label in the option's own hue
    // over a 14% tint of that hue is the contrast bug this replaces.
    ink: 'var(--n-700)',
  };
}

/** A bare word that a browser would accept as a colour keyword. Conservative
 * on purpose — anything not matching falls through to neutral rather than
 * emitting a declaration the browser drops. */
const CSS_WORD = /^[a-z]+$/i;
