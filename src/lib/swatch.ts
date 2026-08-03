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

// --- Is this actually a colour? (M16.35) -----------------------------------

/**
 * A vault-supplied colour is interpolated straight into `background`, into a
 * `border` shorthand and into `color-mix(…)`. Vault content is not trusted
 * input — a workspace gets synced, shared, cloned and sent — so "contains a
 * paren" was never proof of a colour. `url(https://…)` in a background is a
 * live outbound request from the renderer the moment the record is opened,
 * which leaks that the vault was opened and lets the sender probe the
 * network; `image-set(…)` fetches the same way, `var(--x, url(…))` and
 * `attr(…)` smuggle a token stream we never validated, and `element(#id)`
 * paints another part of the app into the swatch.
 *
 * So: an allowlist. A value is emitted only if it parses as a hex literal, a
 * CSS named colour, or one of the colour functions below with numeric
 * arguments. Everything else takes the neutral swatch — the same answer an
 * unrecognised bare word already got.
 */

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — nothing else after the hash. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The only functional forms allowed, and the list is closed.
 *
 * `url`, `image-set`, `var`, `attr` and `element` are absent deliberately:
 * the first two fetch, and the rest expand to tokens that were never checked.
 * Adding any of them re-opens the hole this allowlist exists to close.
 */
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
]);

/** `color()` leads with a predefined colour space rather than a number. */
const COLOR_SPACES = new Set([
  'srgb',
  'srgb-linear',
  'display-p3',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'xyz',
  'xyz-d50',
  'xyz-d65',
]);

/** A number, a percentage or an angle. An identifier is not an argument we
 * will emit — that rules out `from` (relative colour syntax), a bare custom
 * property name, and anything else that resolves to who-knows-what. */
const NUMERIC_ARG = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:%|deg|grad|rad|turn)?$/i;

/** Every CSS named colour, so a hand-written `crimson` keeps working. Words
 * are inert: unlike a function they cannot fetch, and unlike `var()` they
 * cannot expand into something else. */
const NAMED_CSS_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
   blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
   crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
   darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
   darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
   dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
   gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
   lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
   lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
   lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
   magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
   mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
   mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
   palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
   powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
   seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
   steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
   yellowgreen transparent currentcolor`
    .trim()
    .split(/\s+/),
);

/**
 * `name(arg arg arg)` where `name` is a colour function and every argument is
 * a number, a percentage, an angle or `none`.
 *
 * The body may not contain a second paren. That single rule is what stops a
 * nested payload: `var(--x, url(…))` never gets past the function name, and
 * `rgb(0,0,0) , url(…)` and `rgb(calc(1 * 2) 0 0)` both die on the inner
 * parens rather than on argument parsing.
 */
function isColorFunction(value: string): boolean {
  const open = value.indexOf('(');
  if (open === -1 || !value.endsWith(')')) return false;
  const name = value.slice(0, open).toLowerCase();
  if (!COLOR_FUNCTIONS.has(name)) return false;
  const body = value.slice(open + 1, -1);
  // Parens, quotes, escapes and declaration punctuation all mean this is no
  // longer a plain argument list.
  if (/[()'"\\;{}@]/.test(body)) return false;
  const args = body.split(/[\s,/]+/).filter((token) => token !== '');
  const channels = name === 'color' ? args.slice(1) : args;
  if (name === 'color' && (args.length === 0 || !COLOR_SPACES.has(args[0].toLowerCase()))) {
    return false;
  }
  if (channels.length === 0 || channels.length > 5) return false;
  return channels.every((arg) => arg.toLowerCase() === 'none' || NUMERIC_ARG.test(arg));
}

/** The one gate every raw vault colour passes through before it reaches CSS. */
function isCssColor(value: string): boolean {
  if (HEX_COLOR.test(value)) return true;
  if (NAMED_CSS_COLORS.has(value.toLowerCase())) return true;
  return isColorFunction(value);
}

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
 *
 * "Raw" stops at values that are actually colours (M16.35). A `var(…)` no
 * longer survives: its fallback is an unvalidated token stream — `var(--x,
 * url(https://…))` is a fetch — and no vault on disk stores one, only this
 * repo's own test fixtures did.
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
  // Legacy: a hex, an rgb()/hsl()/oklch(), or a bare CSS colour keyword
  // someone hand-wrote into their vault. `isCssColor` is an allowlist, not a
  // paren check — see its comment for what that stops (M16.35).
  if (!isCssColor(value)) return NEUTRAL;
  return {
    name: null,
    solid: value,
    tint: `color-mix(in srgb, ${value} 14%, var(--n-0))`,
    // Deliberately not `value`: painting the label in the option's own hue
    // over a 14% tint of that hue is the contrast bug this replaces.
    ink: 'var(--n-700)',
  };
}
