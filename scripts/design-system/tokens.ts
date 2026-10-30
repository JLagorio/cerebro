/**
 * Design-system tokens from the app's own CSS (M100.1).
 *
 * Every value comes from `src/styles/tokens/*.css`; `design-system/tokens.notes.json`
 * holds only what CSS cannot say: a usage note per token and the type styles.
 * The result is the `tokens.json` the Design System artifact reads: every family
 * a list of `{ name, value, usage }`, colours keyed by theme.
 */

export type Vars = Map<string, string>;

export interface TypeStyleNote {
  name: string;
  /** A `--fs-*` / `--lh-*` name (without `--`) the style takes its size and leading from. */
  size?: string;
  line?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight: number;
  letterSpacing?: string;
  sample?: string;
  usage?: string;
}

export interface TokenNotes {
  color: Record<string, string>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  size: Record<string, string>;
  fontWeight: Record<string, string>;
  letterSpacing: Record<string, string>;
  type: {
    fonts: { family: string; file: string; weight: string; style: string }[];
    groups: { name: string; family: string; styles: TypeStyleNote[] }[];
  };
}

export interface TokenSources {
  colors: string;
  typography: string;
  spacing: string;
}

interface Token {
  name: string;
  value: string | Record<string, string>;
  usage: string;
}

const MOTION = /^(dur|ease|motion)-/;

/** The custom properties of the first block opened by `selector`, comments stripped, in source order. */
export function readVars(css: string, selector: string): Vars {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`no block ${selector}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}' && --depth === 0) break;
  }
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map(
    [...body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

/** A colour as tokens.json takes it: `var(--x)` becomes the alias `{x}`, hex lowercases. */
export function colorValue(value: string): string {
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (alias) return `{${alias[1]}}`;
  return value.startsWith('#') ? value.toLowerCase() : value;
}

export function buildTokens(
  sources: TokenSources,
  notes: TokenNotes,
  meta: Record<string, unknown>,
): { tokens: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const light = readVars(sources.colors, ':root {');
  const dark = readVars(sources.colors, ":root[data-theme='dark'] {");
  const space = readVars(sources.spacing, ':root {');
  const type = readVars(sources.typography, ':root {');

  const note = (family: keyof Omit<TokenNotes, 'type'>, name: string): string => {
    const usage = notes[family][name];
    if (usage === undefined) problems.push(`${family} token ${name} has no usage note`);
    return usage ?? '';
  };
  const unused = (family: keyof Omit<TokenNotes, 'type'>, names: string[]) => {
    for (const name of Object.keys(notes[family]))
      if (!names.includes(name)) problems.push(`${family} note ${name} names no token`);
  };

  // Light first: a theme with no value of its own inherits the first theme's.
  const themed = (name: string, value: string, read: (v: string) => string) => {
    const out: Record<string, string> = { light: read(value) };
    if (dark.has(name)) out.dark = read(dark.get(name)!);
    return out;
  };
  const color: Token[] = [...light].map(([name, value]) => ({
    name,
    value: themed(name, value, colorValue),
    usage: note('color', name),
  }));
  unused(
    'color',
    color.map((t) => t.name),
  );

  const shadowNames = [...space.keys()].filter((n) => n.startsWith('shadow-') || n === 'ring');
  for (const name of dark.keys())
    if (!light.has(name) && !shadowNames.includes(name))
      problems.push(`dark-only colour ${name} has no light value`);
  const shadow: Token[] = shadowNames.map((name) => ({
    name,
    value: themed(name, space.get(name)!, (v) => v),
    usage: note('shadow', name),
  }));
  unused('shadow', shadowNames);

  const family = (
    vars: Vars,
    test: (name: string) => boolean,
    notesKey: keyof Omit<TokenNotes, 'type'>,
  ) => {
    const names = [...vars.keys()].filter(test);
    unused(notesKey, names);
    return {
      tokens: names.map((name) => ({ name, value: vars.get(name)!, usage: note(notesKey, name) })),
    };
  };
  const spacing = family(space, (n) => n.startsWith('sp-'), 'spacing');
  const radius = family(space, (n) => n.startsWith('r-'), 'radius');
  const size = family(
    space,
    (n) => !/^(sp|r)-/.test(n) && !shadowNames.includes(n) && !MOTION.test(n),
    'size',
  );
  const fontWeight = family(type, (n) => n.startsWith('w-'), 'fontWeight');
  const letterSpacing = family(type, (n) => n.startsWith('track-'), 'letterSpacing');

  // The size scale's notes follow from its names: a role says what it is for,
  // a numeric step is a step.
  const ROLES: Record<string, string> = {
    'page-title': 'Page title',
    'workspace-title': 'Peek and workspace title',
    'section-title': 'Section title',
    prose: 'Document prose',
    ui: 'Standard UI text',
    meta: 'Metadata',
  };
  const scale = (prefix: string, usage: (key: string) => string) => ({
    tokens: [...type.keys()]
      .filter((n) => n.startsWith(prefix))
      .map((name) => ({ name, value: type.get(name)!, usage: usage(name.slice(prefix.length)) })),
  });
  const fontSize = scale('fs-', (key) =>
    key in ROLES
      ? `${ROLES[key]} size.`
      : `Scale step ${key}.${key === 'sm' ? ' Base UI size (body).' : ''}`,
  );
  const lineHeight = scale('lh-', (key) =>
    key in ROLES ? `${ROLES[key]} line height.` : `Line height paired with fs-${key}.`,
  );

  const groups = notes.type.groups.map((group) => ({
    name: group.name,
    family: group.family,
    styles: group.styles.map(({ size: sizeRef, line, ...style }) => {
      const out: Record<string, unknown> = { ...style };
      if (sizeRef !== undefined) {
        if (!type.has(sizeRef)) problems.push(`type style ${style.name} names missing ${sizeRef}`);
        out.fontSize = type.get(sizeRef);
      }
      if (line !== undefined) {
        if (!type.has(line)) problems.push(`type style ${style.name} names missing ${line}`);
        out.lineHeight = type.get(line);
      }
      if (out.fontSize === undefined) problems.push(`type style ${style.name} has no size`);
      return { name: style.name, ...out };
    }),
  }));
  for (const key of ['font-ui', 'font-mono'])
    if (!type.has(key)) problems.push(`typography.css has no --${key}`);

  const tokens = {
    name: 'Cerebro',
    version: 1,
    meta,
    color: {
      themes: [
        { id: 'light', name: 'Light' },
        { id: 'dark', name: 'Dark' },
      ],
      tokens: color,
    },
    type: {
      fonts: notes.type.fonts,
      families: { ui: type.get('font-ui'), mono: type.get('font-mono') },
      groups,
    },
    spacing,
    radius,
    shadow: { tokens: shadow },
    size,
    fontSize,
    lineHeight,
    fontWeight,
    letterSpacing,
  };
  return { tokens, problems };
}
