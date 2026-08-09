import type { Shape } from './model';

/**
 * The mermaid shape registry (M29.32) — MEASURED against the mermaid the app
 * actually bundles, not the docs and not the vendored checkout.
 *
 * `flowDb.addVertex` throws outright on a name outside the registry, on any
 * uppercase letter, and on any underscore (`No such shape: X. Shape names
 * should be lowercase.`, flowDb.ts:236-241), and a throw there kills the whole
 * diagram — so this table is the last boundary before a shape name reaches the
 * file, exactly like `styleDecl` is for style values.
 *
 * Three deliberate exclusions, each measured:
 *
 * - **`ellipse`** is not in the registry at all (it survives only as a legacy
 *   flowchart *type* name, flowDb.ts:995) and is broken upstream
 *   (mermaid#5976). `@{ shape: ellipse }` → `No such shape: ellipse.`
 * - **`person`** IS in mermaid 11.16.1 — and is the whole difference between
 *   11.16.1's 49 short names and the **48** here. The app bundles **11.16.0**
 *   (`package.json` "mermaid": "^11.16.0", pnpm resolves 11.16.0), where
 *   `@{ shape: person }` throws `No such shape: person.` A palette button that
 *   kills the render is worse than a missing one; when the dependency moves,
 *   `shapes.mermaid.test.ts` fails and this table can grow.
 * - **internal aliases with underscores or capitals** (`squareRect`,
 *   `lean_right`, `rect_left_inv_arrow`, …) are real keys in mermaid's shape
 *   map but are rejected by the lowercase/underscore guard *before* the lookup
 *   runs — mermaid contradicting itself. We never write them.
 *
 * The alias lists are a verified SUBSET of upstream's: every one was rendered
 * and compared against its short name (identical geometry, zero mismatches).
 * A stricter set is strictly safe — this table only gates what WE write, and
 * we only ever write short names.
 */
export const SHAPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  rect: ['proc', 'process', 'rectangle'],
  rounded: ['event'],
  stadium: ['terminal', 'pill'],
  'fr-rect': ['subproc', 'subroutine'],
  cyl: ['db', 'database', 'cylinder'],
  circle: ['circ'],
  diam: ['decision', 'diamond', 'question'],
  hex: ['hexagon', 'prepare'],
  'lean-r': ['in-out'],
  'lean-l': ['out-in'],
  'trap-b': ['priority', 'trapezoid'],
  'trap-t': ['manual', 'inv-trapezoid'],
  'dbl-circ': ['double-circle', 'doublecircle'],
  text: [],
  'notch-rect': ['card'],
  'lin-rect': ['lined-process'],
  'sm-circ': ['start'],
  'fr-circ': ['stop'],
  fork: ['join'],
  hourglass: ['collate'],
  brace: ['comment'],
  'brace-r': [],
  braces: [],
  bolt: ['com-link'],
  doc: ['document'],
  delay: [],
  'h-cyl': ['das'],
  'lin-cyl': ['disk'],
  'curv-trap': ['display'],
  'div-rect': ['div-proc'],
  tri: ['extract'],
  'win-pane': ['internal-storage'],
  'f-circ': ['junction'],
  'notch-pent': ['loop-limit'],
  'flip-tri': ['manual-file'],
  'sl-rect': ['manual-input'],
  docs: ['st-doc'],
  'st-rect': ['procs'],
  'bow-rect': ['stored-data'],
  'cross-circ': ['summary'],
  'tag-doc': [],
  'tag-rect': ['tag-proc'],
  flag: ['paper-tape'],
  odd: [],
  'lin-doc': [],
  datastore: [],
  bang: [],
  cloud: [],
};

/**
 * Every spelling mermaid accepts from us: short names + verified aliases.
 *
 * NOT a production gate any more — `setNodeShape` decides with
 * `SHORT_NAME_FOR`, whose key set is exactly this one (`shapes.test.ts` pins
 * the equality, which is what makes the `cylinder` alias above load-bearing).
 * This is the CONFORMANCE SURFACE: `shapes.mermaid.test.ts` sweeps it against
 * the bundled mermaid, so every writable spelling is proven to parse. Deleting
 * it as dead code would silently delete that proof.
 */
export const VALID_SHAPES: ReadonlySet<string> = new Set(
  Object.entries(SHAPE_ALIASES).flatMap(([name, aliases]) => [name, ...aliases]),
);

/** Classic bracket shape → the registry short name we write into `@{ shape }`. */
export const BRACKET_SHAPE_TO_REGISTRY: Readonly<Record<Shape, string>> = {
  rect: 'rect',
  rounded: 'rounded',
  stadium: 'stadium',
  circle: 'circle',
  diamond: 'diam',
  hexagon: 'hex',
  cylinder: 'cyl',
  subroutine: 'fr-rect',
};

/**
 * Any spelling (short name, alias, or bracket-shape literal) that denotes one
 * of the classic 8 → its bracket Shape, for D4's brackets-first path.
 *
 * Null-prototype on purpose. `setNodeShape` indexes this with whatever string
 * a caller hands it, and a plain `{}` answers `toString`, `constructor` and
 * `hasOwnProperty` from the prototype chain — a truthy value that would send
 * an Object.prototype member down the brackets-first path, where it becomes
 * `SHAPE_BRACKETS[<function>]`, undefined, destructured, and thrown, taking
 * the whole editor with it.
 */
export const REGISTRY_TO_BRACKET: Readonly<Record<string, Shape | undefined>> = (() => {
  const out = Object.create(null) as Record<string, Shape>;
  for (const [bracket, registry] of Object.entries(BRACKET_SHAPE_TO_REGISTRY)) {
    out[bracket] = bracket as Shape;
    out[registry] = bracket as Shape;
    for (const alias of SHAPE_ALIASES[registry] ?? []) out[alias] = bracket as Shape;
  }
  return out;
})();

/**
 * Every accepted spelling → the registry SHORT NAME it denotes, including the
 * eight bracket-`Shape` literals. This is the canonicalizer: `setNodeShape`
 * writes what this table returns, never the spelling it was handed, so a file
 * only ever gains one name per shape and the palette can always find the
 * button that matches what a node renders as.
 *
 * Null-prototype for the same reason REGISTRY_TO_BRACKET is: it is indexed
 * with untrusted strings, and `SHORT_NAME_FOR['toString']` must be undefined,
 * not a function.
 */
export const SHORT_NAME_FOR: Readonly<Record<string, string | undefined>> = (() => {
  const out = Object.create(null) as Record<string, string>;
  for (const [name, aliases] of Object.entries(SHAPE_ALIASES)) {
    out[name] = name;
    for (const alias of aliases) out[alias] = name;
  }
  for (const [bracket, registry] of Object.entries(BRACKET_SHAPE_TO_REGISTRY)) {
    out[bracket] = registry;
  }
  return out;
})();

export interface PaletteShape {
  /** Registry short name — what setNodeShape writes. */
  name: string;
  label: string;
  /** lucide icon (kebab-case), verified against lucide-react 0.525. */
  icon: string;
  category: 'Basic' | 'Process' | 'Technical' | 'Annotation';
}

/**
 * The palette shows the ENTIRE registry (D4, spec §4.4) — every short name in
 * SHAPE_ALIASES, one entry each; the covering test enforces set equality.
 * Categories are OUR editorial grouping — upstream has none. The three brace
 * comments share one lucide glyph on purpose (no single-brace icon exists);
 * their labels disambiguate.
 */
export const PALETTE_SHAPES: readonly PaletteShape[] = [
  // Basic
  { name: 'rect', label: 'Rectangle', icon: 'square', category: 'Basic' },
  { name: 'rounded', label: 'Rounded', icon: 'square-round-corner', category: 'Basic' },
  { name: 'stadium', label: 'Stadium', icon: 'rectangle-horizontal', category: 'Basic' },
  { name: 'circle', label: 'Circle', icon: 'circle', category: 'Basic' },
  { name: 'sm-circ', label: 'Small circle', icon: 'circle-small', category: 'Basic' },
  { name: 'dbl-circ', label: 'Double circle', icon: 'circle-dot', category: 'Basic' },
  { name: 'diam', label: 'Decision', icon: 'diamond', category: 'Basic' },
  { name: 'hex', label: 'Hexagon', icon: 'hexagon', category: 'Basic' },
  { name: 'tri', label: 'Triangle', icon: 'triangle', category: 'Basic' },
  { name: 'text', label: 'Text', icon: 'type', category: 'Basic' },
  { name: 'fr-circ', label: 'Stop', icon: 'circle-stop', category: 'Basic' },
  { name: 'f-circ', label: 'Junction', icon: 'dot', category: 'Basic' },
  { name: 'odd', label: 'Odd', icon: 'octagon', category: 'Basic' },
  // Process
  { name: 'fr-rect', label: 'Subprocess', icon: 'square-stack', category: 'Process' },
  { name: 'lin-rect', label: 'Lined process', icon: 'columns-2', category: 'Process' },
  { name: 'div-rect', label: 'Divided process', icon: 'panel-top', category: 'Process' },
  { name: 'notch-rect', label: 'Card', icon: 'credit-card', category: 'Process' },
  { name: 'trap-b', label: 'Priority', icon: 'dock', category: 'Process' },
  { name: 'trap-t', label: 'Manual operation', icon: 'hand', category: 'Process' },
  { name: 'lean-r', label: 'Input / output', icon: 'move-right', category: 'Process' },
  { name: 'lean-l', label: 'Output / input', icon: 'move-left', category: 'Process' },
  { name: 'hourglass', label: 'Collate', icon: 'hourglass', category: 'Process' },
  { name: 'fork', label: 'Fork / join', icon: 'git-fork', category: 'Process' },
  { name: 'delay', label: 'Delay', icon: 'timer', category: 'Process' },
  { name: 'notch-pent', label: 'Loop limit', icon: 'pentagon', category: 'Process' },
  { name: 'flip-tri', label: 'Manual file', icon: 'flip-vertical', category: 'Process' },
  { name: 'sl-rect', label: 'Manual input', icon: 'keyboard', category: 'Process' },
  { name: 'st-rect', label: 'Stacked process', icon: 'layers', category: 'Process' },
  { name: 'tag-rect', label: 'Tagged process', icon: 'tag', category: 'Process' },
  { name: 'flag', label: 'Paper tape', icon: 'flag', category: 'Process' },
  { name: 'bolt', label: 'Com link', icon: 'zap', category: 'Process' },
  // Technical
  { name: 'cyl', label: 'Database', icon: 'database', category: 'Technical' },
  { name: 'h-cyl', label: 'Direct access storage', icon: 'cylinder', category: 'Technical' },
  { name: 'lin-cyl', label: 'Disk storage', icon: 'hard-drive', category: 'Technical' },
  { name: 'doc', label: 'Document', icon: 'file-text', category: 'Technical' },
  { name: 'docs', label: 'Documents', icon: 'files', category: 'Technical' },
  { name: 'lin-doc', label: 'Lined document', icon: 'scroll-text', category: 'Technical' },
  { name: 'curv-trap', label: 'Display', icon: 'monitor', category: 'Technical' },
  { name: 'win-pane', label: 'Internal storage', icon: 'grid-2x2', category: 'Technical' },
  { name: 'cloud', label: 'Cloud', icon: 'cloud', category: 'Technical' },
  { name: 'datastore', label: 'Data store', icon: 'server', category: 'Technical' },
  { name: 'bow-rect', label: 'Stored data', icon: 'save', category: 'Technical' },
  { name: 'tag-doc', label: 'Tagged document', icon: 'file-badge', category: 'Technical' },
  { name: 'cross-circ', label: 'Summary', icon: 'circle-x', category: 'Technical' },
  { name: 'bang', label: 'Bang', icon: 'sparkles', category: 'Technical' },
  // Annotation
  { name: 'brace', label: 'Comment (left brace)', icon: 'braces', category: 'Annotation' },
  { name: 'brace-r', label: 'Comment (right brace)', icon: 'braces', category: 'Annotation' },
  { name: 'braces', label: 'Comment (both braces)', icon: 'braces', category: 'Annotation' },
];
