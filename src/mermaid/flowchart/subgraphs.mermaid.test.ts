import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { parseFlowchart, serialize, subgraphs, type SubgraphEntry } from './model';
import {
  canCreateSubgraph,
  canDissolveSubgraph,
  createSubgraph,
  dissolveSubgraph,
  renameSubgraph,
  setSubgraphDirection,
} from './ops';
import { bindFlowchartSvg } from './svgBinding';

/**
 * Conformance, not unit testing (M29.37). Everything here is a CLAIM ABOUT THE
 * BUNDLED MERMAID (11.16.0), measured against `flowDb.getSubGraphs()` rather
 * than read out of the vendored 11.16.1 grammar — the plan this task came from
 * described subgraph ids from that grammar and four of its claims turned out
 * to be false on the build we ship.
 *
 * What was measured, and what it cost:
 *
 * - ordinals DO follow close order, inner before outer, and explicit and
 *   single-word blocks consume one too. That part of the plan held.
 * - an ANONYMOUS `subgraph` block is not "valid mermaid that renders fine": it
 *   is a TypeError inside `addSubGraph` that kills the whole diagram, so it
 *   never reaches `subCount` at all. The plan (and a comment in `parse.ts`
 *   since M29.14) said the opposite.
 * - the whitespace that zeroes an id is tested UNTRIMMED, so `subgraph Alpha `
 *   with one trailing space is `subGraph0`, not `Alpha`. Trimming first would
 *   have mis-keyed every padded block.
 * - a `click` or `style` line inside a block claims NO membership. The plan
 *   had `click` claiming it, which would have created subgraphs that render
 *   empty.
 * - the LAST own-depth `direction` line wins, and mermaid's rule is the whole
 *   LINE (`.*direction\s+<DIR>[^\n]*`), so `direction LR %% note` counts. The
 *   plan read the first and only the tidy form.
 * - a top-level `direction` line is INERT — the header's reduction runs last
 *   and wins — so the "orphaned direction silently overrides the header"
 *   hazard the plan built a decision on does not exist on 11.16.0.
 * - `end;` closes a block, and `subgraph s1[T] ` (one trailing space) does not
 *   open one.
 *
 * The M29.37 REVIEW added a second layer of measurement, and it found that the
 * first one had trusted `quoteLabel` outside the lexer state it was measured
 * in:
 *
 * - a BARE subgraph title is not a bracket label. Unquoted, `Build --> Ship`,
 *   `a -- b`, `a o--o b`, `Design, Build, Ship`, `Latency < 200ms`,
 *   `Ops > Eng`, `env = prod`, `a ~ b`, `a | b`, `a (p) b`, `a @ b`,
 *   `a [b] c` and `a {b} c` all KILL the diagram, and three more change it
 *   silently — `Q1 ; Q2` mints a phantom node, `Start end` and `a click b`
 *   make the block's node vanish. Quoted, every one of them renders, and the
 *   effective-id rule is untouched. Hence `bareSubgraphTitle` quotes always.
 * - `direction <DIR>` is fatal or destructive on ANY line in ANY form, and
 *   quoting does NOT rescue it — but `click A "a direction LR b.md"` and
 *   `A@{ label: "a direction LR b" }` are immune, so the defusal belongs to
 *   the bracket-state emitters and not to `flattenForLine`.
 * - a LEADING `%%` makes a direction line a comment mermaid ignores; the same
 *   phrase after other content on the line does NOT.
 * - generated ids are close-order ordinals, so grouping above a block or
 *   dissolving before it silently re-keys it. Hence the pins.
 * - a foreign direction line inside a NESTED block re-directs its PARENT once
 *   the block is dissolved; at top level the same orphan is inert.
 */

const TIMEOUT = 60_000;

function polyfill(): void {
  // jsdom implements no SVG layout; every shape handler sizes itself from the
  // label's bbox. Fixed values keep renders comparable and finite.
  const proto = (globalThis as unknown as { SVGElement: { prototype: Record<string, unknown> } })
    .SVGElement.prototype;
  proto.getBBox = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto.getComputedTextLength = () => 60;
}

function init(): void {
  polyfill();
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', handDrawnSeed: 1 });
}

interface SubGraph {
  id: string;
  title: string;
  nodes: string[];
  dir?: string;
}

interface Db {
  getSubGraphs: () => SubGraph[];
  getVertices: () => Map<string, unknown>;
  getDirection: () => string;
}

async function db(code: string): Promise<Db> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  return (await mermaidAPI.getDiagramFromText(code)).db as Db;
}

/** True when mermaid accepts the document at all. */
async function parses(code: string): Promise<boolean> {
  try {
    await db(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE invariant (spec D10's shape, applied to blocks): every subgraph our
 * model reports — its effective id, its title, its direction, its membership —
 * is one mermaid reports, and every subgraph mermaid reports is one of ours.
 * This is the subgraph twin of the phantom-node check in `model.test.ts`, and
 * it is the only assertion here that can catch a whole CLASS of mis-keying:
 * an id we get wrong is a cluster M29.38's binding silently never finds.
 *
 * Two reconciliations, both measured rather than assumed:
 *
 * - mermaid lists a nested block's ID among its parent's `nodes`; our
 *   `memberIds` is documented as NODE ids, so the child ids are added back
 *   here rather than papered over;
 * - mermaid's node order is neither document nor insertion order (`ops` comes
 *   back `["B","A"]`), so membership is compared as a SET. The ORDER is ours
 *   to choose; the CONTENT is not.
 */
async function expectAgrees(code: string, where: string): Promise<void> {
  const upstream = (await db(code)).getSubGraphs();
  const ours = subgraphs(parseFlowchart(code)!);
  expect([where, ours.map((s) => s.id).sort()]).toEqual([where, upstream.map((s) => s.id).sort()]);
  const byId = new Map(upstream.map((s) => [s.id, s]));
  for (const sub of ours) {
    const theirs = byId.get(sub.id)!;
    // DIRECT children only: mermaid lists a block's immediate children, not
    // its grandchildren (measured on the three-deep fixture).
    const parentOf = (s: SubgraphEntry): SubgraphEntry | undefined =>
      ours
        .filter((o) => o.startLine < s.startLine && o.endLine > s.endLine)
        .sort((a, b) => b.startLine - a.startLine)[0];
    const children = ours.filter((s) => parentOf(s)?.index === sub.index).map((s) => s.id);
    const claimed = [...new Set([...sub.memberIds, ...children])].sort();
    expect([where, sub.id, sub.title, sub.direction ?? null, claimed]).toEqual([
      where,
      sub.id,
      // `sanitizeText` HTML-escapes `<` on the way into the stored title
      // (measured: only `<` — `>` and `&` come back verbatim). That is a
      // display escape applied after parsing, not a disagreement about what
      // the title IS, so it is undone rather than mirrored into our model.
      theirs.title.replaceAll('&lt;', '<'),
      theirs.dir ?? null,
      [...new Set(theirs.nodes)].sort(),
    ]);
  }
}

/**
 * The lines of `after` that were not in `before`, or null when a line of
 * `before` went missing or changed a byte. `createSubgraph` may RELOCATE a
 * line, so relative order is not the property to assert here — survival is:
 * every original line still present, byte for byte, and nothing new but the
 * markers and minted references. (The exact resulting ORDER is pinned by the
 * unit tests in `ops.test.ts`, which assert whole documents.)
 */
function addedLines(before: string[], after: string[]): string[] | null {
  const pool = new Map<string, number>();
  for (const line of after) pool.set(line, (pool.get(line) ?? 0) + 1);
  for (const line of before) {
    const left = pool.get(line) ?? 0;
    if (left === 0) return null;
    pool.set(line, left - 1);
  }
  return [...pool].flatMap(([line, n]) => Array<string>(n).fill(line));
}

/**
 * The rename titles the sweep drives. The first two are ordinary; the rest are
 * the ones that killed or silently changed the diagram through the BARE form
 * before the review — renaming only to `Re named`/`Solo` is exactly what let a
 * diagram-killer through a 42-document instrument.
 */
const RENAME_TITLES = [
  'Re named',
  'Solo',
  'Build --> Ship',
  'Q1 ; Q2',
  'Start end',
  'a click b',
  'Design, Build, Ship',
  'Latency < 200ms',
  'env = prod',
  'a (p) b',
  'a direction LR b',
];

const notDirection = (l: string): boolean => !/^\s*direction\s/.test(l);
const notOpener = (l: string): boolean => !/^\s*subgraph\b/.test(l);

/**
 * The lines a dissolve REMOVED, or null when it changed a surviving line's
 * bytes or invented one. The most destructive op had only "it still parses"
 * behind it: deleting an arbitrary body line passed the whole sweep. Openers
 * are filtered out by the caller — a PIN rewrites one on purpose, and the
 * before/after id comparison is what holds that honest.
 */
function dissolveLoss(before: string[], after: string[]): string[] | null {
  const pool = new Map<string, number>();
  for (const line of before) pool.set(line, (pool.get(line) ?? 0) + 1);
  for (const line of after) {
    const left = pool.get(line) ?? 0;
    if (left === 0) return null; // a line appeared, or one changed its bytes
    pool.set(line, left - 1);
  }
  return [...pool].flatMap(([line, n]) => Array<string>(n).fill(line));
}

/**
 * Structure, not values — the lesson from M29.36, whose 500-input sweep missed
 * a live defect because every document in it linked the same node id. Nesting
 * depth, sibling order, id form, marker spelling, direction placement and the
 * statements that do and do not claim membership all vary here.
 */
const DOCS: [string, string][] = [
  ['flat', 'flowchart TD\n  subgraph s1[One]\n    A --> B\n  end\n  C'],
  ['bare-word', 'flowchart TD\n  subgraph Alpha\n    A\n  end'],
  ['bare-words', 'flowchart TD\n  subgraph Two Words\n    A\n  end'],
  ['bare-quoted', 'flowchart TD\n  subgraph "Two Words"\n    A\n  end'],
  ['bare-quoted-solo', 'flowchart TD\n  subgraph "Solo"\n    A\n  end'],
  ['padded-title', 'flowchart TD\n  subgraph Alpha \n    A\n  end'],
  ['padded-lead', 'flowchart TD\n  subgraph  Padded\n    A\n  end'],
  ['spaced-explicit-id', 'flowchart TD\n  subgraph Two Words[T]\n    A\n  end'],
  ['explicit-gap', 'flowchart TD\n  subgraph s1 [T]\n    A\n  end'],
  ['explicit-quoted', 'flowchart TD\n  subgraph s1["A (weird) name"]\n    A\n  end'],
  ['empty-block', 'flowchart TD\n  A\n  subgraph s1[T]\n  end'],
  [
    'nested',
    'flowchart TD\n  subgraph Outer Zone\n    D --> E\n    subgraph Inner Zone\n      F\n    end\n  end',
  ],
  [
    'nested-three',
    'flowchart TD\n  subgraph a[A]\n    subgraph b[B]\n      subgraph c[C]\n        X\n      end\n    end\n  end',
  ],
  [
    'siblings-then-nest',
    'flowchart TD\n  subgraph P Q\n    X\n  end\n  subgraph R\n    Y\n    subgraph S T\n      Z\n    end\n  end',
  ],
  [
    'siblings-share-node',
    'flowchart TD\n  subgraph P[P]\n    X\n  end\n  subgraph Q[Q]\n    X\n  end',
  ],
  [
    'inner-claims-first',
    'flowchart TD\n  subgraph O[O]\n    A\n    subgraph I[I]\n      A\n    end\n  end',
  ],
  ['direction', 'flowchart TD\n  subgraph s1[T]\n    direction LR\n    A\n  end'],
  [
    'two-directions',
    'flowchart TD\n  subgraph s1[T]\n    direction LR\n    A\n    direction BT\n  end',
  ],
  ['direction-comment', 'flowchart TD\n  subgraph s1[T]\n    direction LR %% note\n    A\n  end'],
  ['direction-semicolon', 'flowchart TD\n  subgraph s1[T]\n    direction LR;\n    A\n  end'],
  [
    'nested-directions',
    'flowchart TD\n  subgraph o[O]\n    direction LR\n    subgraph i[I]\n      direction RL\n      A\n    end\n    direction BT\n  end',
  ],
  ['top-direction', 'flowchart TD\n  direction LR\n  subgraph s1[T]\n    A\n  end'],
  ['click-inside', 'flowchart TD\n  A\n  subgraph s1[T]\n    click A "a.md"\n  end'],
  ['style-inside', 'flowchart TD\n  A\n  subgraph s1[T]\n    style A fill:#f96\n  end'],
  ['meta-inside', 'flowchart TD\n  A\n  subgraph s1[T]\n    A@{ shape: cyl }\n  end'],
  ['edge-crossing', 'flowchart TD\n  subgraph s1[T]\n    A\n  end\n  A --> B'],
  ['edge-claims-outsider', 'flowchart TD\n  B\n  subgraph s1[T]\n    A --> B\n  end'],
  ['chain-inside', 'flowchart TD\n  subgraph s1[T]\n    A --> B --> C\n    D & E --> F\n  end'],
  ['end-semicolon', 'flowchart TD\n  subgraph s1[T]\n    A\n  end;\n  B'],
  ['end-padded', 'flowchart TD\n  subgraph s1[T]\n    A\n  end \n  B'],
  ['tab-indent', 'flowchart TD\n\tsubgraph s1[T]\n\t\tA --> B\n\tend'],
  ['crlf', 'flowchart TD\r\n  subgraph Alpha\r\n    A --> B\r\n  end'],
  [
    'frontmatter',
    '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  subgraph s1[T]\n    A --> B\n  end',
  ],
  ['no-subgraphs', 'flowchart TD\n  A[Start] --> B{Choice}\n  click A "a.md"'],
  ['end-x', 'flowchart TD\n  subgraph s1[T]\n    A\n  end x\n  B'],
  ['commented-direction', 'flowchart TD\n  subgraph s1[T]\n    %% direction LR\n    A\n  end'],
  [
    'shadowed-direction',
    'flowchart TD\n  subgraph s1[T]\n    direction LR\n    A\n    %% direction BT\n  end',
  ],
  [
    'midline-comment-direction',
    'flowchart TD\n  subgraph s1[T]\n    B[x] %% direction LR\n    A\n  end',
  ],
  [
    'nested-foreign-direction',
    'flowchart TD\n  subgraph o[O]\n    direction TB\n    subgraph i[I]\n      direction LR %% note\n      A\n    end\n  end',
  ],
  [
    'generated-neighbour-below',
    'flowchart TD\n  A\n  B\n  A --> B\n  subgraph Two Words\n    X\n  end',
  ],
  [
    'generated-neighbour-above',
    'flowchart TD\n  subgraph Two Words\n    X\n  end\n  A\n  B\n  A --> B',
  ],
  [
    'generated-pair',
    'flowchart TD\n  subgraph One Two\n    P\n  end\n  subgraph Three Four\n    Q\n  end\n  A\n  A --> B',
  ],
  ['scruffy-spacing', 'flowchart TD\n  A[ Start ]\n  %% c\n  B\n  A    -->    B\n  C[Odd]   '],
  ['scruffy-arrows', 'flowchart TD\n  A ----> B\n  C -.-> D\n  E ==> F'],
  ['scruffy-inside', 'flowchart TD\n  subgraph s1[T]\n     A[ pad ]  \n\t\tB\n  end'],
  ['free-scattered', 'flowchart TD\n  A[Start]\n  %% c\n  B[Mid]\n  A --> C\n  A --> B'],
  ['free-with-meta', 'flowchart TD\n  A@{ shape: cyl }\n  B\n  A --> B\n  click A "a.md"'],
  ['free-beside-block', 'flowchart TD\n  subgraph s1[T]\n    X\n  end\n  A --> B\n  C'],
  ['free-chain', 'flowchart TD\n  A --> B --> C\n  D & E --> F'],
  [
    'free-styled',
    'flowchart TD\n  A --> B\n  style A fill:#f96\n  classDef hot fill:#f96\n  class B hot',
  ],
  [
    'free-after-block',
    'flowchart TD\n  subgraph Two Words\n    X --> Y\n  end\n  P\n  Q\n  P --> Q',
  ],
  ['id-collides-node', 'flowchart TD\n  S[Node]\n  subgraph S[Sub]\n    A\n  end'],
  [
    'generated-clash',
    'flowchart TD\n  subgraph subGraph9[T]\n    A\n  end\n  subgraph Two Words\n    B\n  end',
  ],
];

describe('subgraph conformance (M29.37)', () => {
  it(
    'every corpus document renders, and our reading of its blocks is mermaid’s',
    async () => {
      init();
      for (const [name, src] of DOCS) {
        expect([name, await parses(src)]).toEqual([name, true]);
        await expectAgrees(src, name);
      }
    },
    TIMEOUT,
  );

  it(
    'the forms the plan called harmless are the ones that kill the diagram',
    async () => {
      init();
      // An anonymous block is a TypeError inside addSubGraph, not a render.
      expect(await parses('flowchart TD\n  subgraph\n    A\n  end')).toBe(false);
      // …and our parser keeps it opaque, which is why the bytes survive.
      const anon = parseFlowchart('flowchart TD\n  subgraph\n    A\n  end')!;
      expect(anon.lines[1].parsed.kind).toBe('opaque');
      expect(serialize(anon)).toBe('flowchart TD\n  subgraph\n    A\n  end');
      // A stray `end`, an unclosed block, an empty bracket title, and one
      // trailing space after the bracket are all fatal too.
      for (const src of [
        'flowchart TD\n  A\n  end',
        'flowchart TD\n  subgraph S\n    A',
        'flowchart TD\n  subgraph s1[]\n    A\n  end',
        'flowchart TD\n  subgraph s1[T] \n    A\n  end',
        'flowchart TD\n  subgraph A (weird) name\n    A\n  end',
      ]) {
        expect([src, await parses(src)]).toEqual([src, false]);
      }
      // A top-level `direction` is INERT: the header wins, both before and
      // after. This is the hazard the plan's dissolve decision was built on.
      expect((await db('flowchart TD\n  direction LR\n  A --> B')).getDirection()).toBe('TB');
      expect((await db('flowchart LR\n  direction TB\n  A --> B')).getDirection()).toBe('LR');
    },
    TIMEOUT,
  );

  it(
    'every op leaves a document mermaid still renders, still agreeing with us',
    async () => {
      init();
      let checked = 0;
      let grouped = 0;
      let refused = 0;
      for (const [name, src] of DOCS) {
        const before = parseFlowchart(src)!;
        const beforeLines = src.split('\n');
        const entries: SubgraphEntry[] = subgraphs(before);
        const idsBefore = entries.map((s) => s.id).sort();

        for (const entry of entries) {
          const ops: [string, string][] = [
            ...RENAME_TITLES.map((t): [string, string] => [
              `rename:${t}`,
              serialize(renameSubgraph(parseFlowchart(src)!, entry.index, t)),
            ]),
            ['dissolve', serialize(dissolveSubgraph(parseFlowchart(src)!, entry.index))],
            ['dir-lr', serialize(setSubgraphDirection(parseFlowchart(src)!, entry.index, 'LR'))],
            ['dir-off', serialize(setSubgraphDirection(parseFlowchart(src)!, entry.index, null))],
          ];
          for (const [op, out] of ops) {
            const where = `${name}#${entry.index} ${op}`;
            expect([where, await parses(out)]).toEqual([where, true]);
            await expectAgrees(out, where);
            // The check the first sweep could not make, because it only ever
            // compared the OUTPUT against itself: an op must not re-key a
            // block. Generated ids are close-order ordinals, so an edit
            // anywhere can move one — `dissolve` drops exactly the block it
            // was given and every other id survives.
            const idsAfter = subgraphs(parseFlowchart(out)!)
              .map((s) => s.id)
              .sort();
            // A dissolve drops exactly the block it was given — unless it
            // DECLINED, in which case nothing moved and the refusal has to
            // name itself.
            const declined = out === src;
            if (declined && op === 'dissolve') {
              expect([where, canDissolveSubgraph(parseFlowchart(src)!, entry.index)]).not.toEqual([
                where,
                null,
              ]);
            }
            const expected =
              op === 'dissolve' && !declined
                ? idsBefore.filter((_, i) => i !== idsBefore.indexOf(entry.id)).sort()
                : idsBefore;
            expect([where, idsAfter]).toEqual([where, expected]);
            checked += 1;
          }
          // A rename is one line: every other line comes back byte-identical.
          // (A PIN may rewrite one more — a neighbouring opener whose
          // generated id the edit would otherwise have moved — so openers are
          // compared by the id check above, not byte-wise.)
          const renamed = serialize(
            renameSubgraph(parseFlowchart(src)!, entry.index, 'Re named'),
          ).split('\n');
          expect([name, renamed.length]).toEqual([name, beforeLines.length]);
          for (let i = 0; i < beforeLines.length; i += 1) {
            if (i === entry.startLine) continue;
            expect([name, i, renamed[i]]).toEqual([name, i, beforeLines[i]]);
          }
          // A direction set never rewrites a line that was not a direction
          // line, and never moves a marker.
          const turned = serialize(
            setSubgraphDirection(parseFlowchart(src)!, entry.index, 'LR'),
          ).split('\n');
          expect([name, turned.filter(notDirection)]).toEqual([
            name,
            beforeLines.filter(notDirection),
          ]);
          // A dissolve is the most destructive op here and had the weakest
          // assertion: it may drop ONLY its two markers and its own owned
          // direction lines, and everything else survives byte for byte.
          const gone = dissolveLoss(
            beforeLines.filter(notOpener),
            serialize(dissolveSubgraph(parseFlowchart(src)!, entry.index))
              .split('\n')
              .filter(notOpener),
          );
          expect([name, entry.index, gone]).not.toEqual([name, entry.index, null]);
          expect([
            name,
            entry.index,
            gone?.every((l) => /^\s*(end\b|direction\s)/.test(l)),
          ]).toEqual([name, entry.index, true]);
        }

        // …and grouping. FREE nodes (claimed by no block) are the ones a group
        // can actually take; the claimed and mixed picks are here to keep the
        // refusal paths exercised rather than assumed.
        const claimed = [...new Set(entries.flatMap((s) => s.memberIds))];
        const free = [...(await db(src)).getVertices().keys()].filter((k) => !claimed.includes(k));
        const picks = [
          free.slice(0, 1),
          free.slice(0, 2),
          free.slice(1, 3),
          free.slice(0, 3),
          claimed.slice(0, 2),
          [...claimed.slice(0, 1), ...free.slice(0, 1)],
        ];
        for (const pick of picks) {
          if (pick.length === 0) continue;
          const where = `${name} group ${pick.join('+')}`;
          const { model: out, id } = createSubgraph(parseFlowchart(src)!, pick, 'New Group');
          const text = serialize(out);
          if (id === null) {
            refused += 1;
            expect([where, text]).toEqual([where, src]);
            expect([where, canCreateSubgraph(parseFlowchart(src)!, pick, 'New Group')]).not.toEqual(
              [where, null],
            );
            continue;
          }
          grouped += 1;
          expect([where, await parses(text)]).toEqual([where, true]);
          await expectAgrees(text, where);
          // The point of the op: mermaid really does put those nodes in it.
          const made = (await db(text)).getSubGraphs().find((s) => s.id === id)!;
          expect([where, pick.every((p) => made.nodes.includes(p))]).toEqual([where, true]);
          // Nothing appeared or vanished, and no existing block was re-keyed.
          expect([where, [...(await db(text)).getVertices().keys()].sort()]).toEqual([
            where,
            [...(await db(src)).getVertices().keys()].sort(),
          ]);
          const idsAfter = subgraphs(parseFlowchart(text)!).map((s) => s.id);
          for (const was of idsBefore) {
            expect([where, was, idsAfter.includes(was)]).toEqual([where, was, true]);
          }
          // Every original line survives byte-for-byte — openers excepted,
          // since a pin rewrites one on purpose and the id check above is what
          // holds that honest. The only new lines are the two markers and any
          // minted membership reference.
          const added = addedLines(
            beforeLines.filter(notOpener),
            text.split('\n').filter(notOpener),
          );
          expect([where, added]).not.toEqual([where, null]);
          expect([
            where,
            added?.every((l) => /^\s*end\b/.test(l) || pick.includes(l.trim())),
          ]).toEqual([where, true]);
          expect([where, (added?.length ?? 99) <= 1 + pick.length]).toEqual([where, true]);
          checked += 1;
        }
      }
      // A sweep that can pass on a no-op is worse than no sweep: a refusal
      // asserts almost nothing, so the count of groups that actually LANDED is
      // pinned too — as is the count that refused, so the refusal paths stay
      // exercised rather than assumed.
      expect(checked).toBeGreaterThan(400);
      expect(grouped).toBeGreaterThan(60);
      expect(refused).toBeGreaterThan(50);
    },
    TIMEOUT,
  );
});

/**
 * The cluster DOM contract M29.38's canvas binding stands on, MEASURED on the
 * bundled 11.16.0 rather than read off the vendored 11.16.1 source — this wave
 * has been bitten by that gap once already, and a mis-keyed cluster is a
 * control that silently never finds the block it names.
 *
 * What the render actually emits:
 *
 * - `<g class="cluster" id="<renderId>-<subgraphId>">`. The id is the
 *   effective subgraph id EXACTLY — no `flowchart-` prefix and no counter,
 *   unlike a node group (`<renderId>-flowchart-<id>-<n>`). The vendored source
 *   writes `'cluster ' + node.cssClasses`, i.e. a TRAILING SPACE when there
 *   are no classes; the bundled build hands back a bare `cluster`. `g.cluster`
 *   covers both, which is why the binding matches on the class SELECTOR and
 *   not on the attribute text.
 * - node groups are NOT descendants of their cluster: they live in a sibling
 *   `g.nodes` layer, so the only thing a click inside a block's box can land
 *   on is a node or the cluster's own `<rect>`.
 */
describe('the cluster DOM contract (M29.38)', () => {
  let seq = 0;
  async function renderSvg(code: string): Promise<string> {
    seq += 1;
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const { svg } = await mermaid.render(`cluster${seq}`, code, host);
      return svg;
    } finally {
      host.remove();
    }
  }

  it(
    'a cluster id is `<renderId>-<subgraphId>`, and bindFlowchartSvg resolves every block',
    async () => {
      init();
      const code = [
        'flowchart TD',
        '  subgraph ops[Operations]',
        '    A[Start] --> B[End]',
        '  end',
        '  subgraph Two Words',
        '    C[Lone]',
        '  end',
        '  subgraph Solo',
        '    D[Dee]',
        '  end',
      ].join('\n');
      const host = document.createElement('div');
      // Mermaid's own strict-mode output, injected the same way the editor does.
      host.innerHTML = await renderSvg(code);

      const clusters = [...host.querySelectorAll<SVGGElement>('g.cluster')];
      expect(clusters.map((c) => c.id).sort()).toEqual([
        'cluster1-Solo',
        'cluster1-ops',
        'cluster1-subGraph1',
      ]);
      // No node group is inside a cluster group — the layers are siblings.
      expect(clusters.some((c) => c.querySelector('g.node') !== null)).toBe(false);

      const model = parseFlowchart(code)!;
      const binding = bindFlowchartSvg(host, model);
      expect([...binding.clusterEls.keys()].sort()).toEqual(['Solo', 'ops', 'subGraph1']);
      // …and those are exactly the ids our model computed, so the binding is
      // an exact-equality lookup and not a heuristic.
      expect(
        subgraphs(model)
          .map((s) => s.id)
          .sort(),
      ).toEqual(['Solo', 'ops', 'subGraph1']);
    },
    TIMEOUT,
  );
});
