/**
 * The flowchart model's vocabulary: the line kinds every module names, and the
 * ordered-entry helpers the meta bodies and style declarations share. Re-exported
 * through `./model`, which is the import site for everything outside this folder.
 */

export type Direction = 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
export type Shape =
  'rect' | 'rounded' | 'stadium' | 'circle' | 'diamond' | 'hexagon' | 'cylinder' | 'subroutine';

export type EdgeStroke = 'normal' | 'thick' | 'dotted' | 'invisible';
export type EdgeHead = 'arrow' | 'open' | 'circle' | 'cross' | 'double';

/**
 * One edge's arrow (M29.31). `raw` is the verbatim source token and the
 * emission truth — an untouched segment re-emits its exact bytes even when a
 * line-mate goes dirty, and author-chosen lengths (`----->`) survive until
 * the segment itself is rewritten. `stroke`/`head` are the parsed reading;
 * `head: 'double'` covers <-->, o--o, and x--x, whose marker family lives in
 * `raw` (and is preserved by emitArrow on stroke-only rewrites).
 */
export interface EdgeArrow {
  stroke: EdgeStroke;
  head: EdgeHead;
  raw: string;
}

export const DEFAULT_ARROW: EdgeArrow = { stroke: 'normal', head: 'arrow', raw: '-->' };

export interface NodeRef {
  id: string;
  /** Label carried at this reference site (`A[Start]`), or null for a bare `A`. */
  label: string | null;
  shape: Shape | null;
}

/**
 * Metadata carried by an `id@{ … }` line (M29.29) — mermaid v11.3+'s door to
 * the full shape registry, icons, and (for edge ids) animation.
 *
 * `entries` is the emission source of truth: EVERY key in source order,
 * unknown ones included, values stored unquoted. The typed fields are
 * derived views over `entries` for the keys we understand — always rebuilt
 * through `buildMeta`/`withMetaEntry`, never written directly, so they can
 * never drift from the entries they mirror.
 */
export interface NodeMeta {
  entries: [string, string][];
  shape?: string;
  icon?: string;
  form?: string;
  pos?: string;
  label?: string;
}

const TYPED_META_KEYS = ['shape', 'icon', 'form', 'pos', 'label'] as const;

export function buildMeta(entries: [string, string][]): NodeMeta {
  const meta: NodeMeta = { entries };
  for (const [key, value] of entries) {
    if ((TYPED_META_KEYS as readonly string[]).includes(key)) {
      meta[key as (typeof TYPED_META_KEYS)[number]] = value;
    }
  }
  return meta;
}

/**
 * Ordered entries with `key` set (replacing in place, order kept) or removed
 * (`null`) — the one implementation behind both meta bodies and style
 * declarations, so the two can never disagree about ordering or about what a
 * duplicate key means.
 */
export function withEntry(
  entries: [string, string][],
  key: string,
  value: string | null,
): [string, string][] {
  const out: [string, string][] = [];
  let replaced = false;
  for (const [k, v] of entries) {
    if (k === key) {
      if (value !== null && !replaced) {
        out.push([k, value]);
        replaced = true;
      }
      // value === null → drop; a duplicate key collapses onto its first site
    } else {
      out.push([k, v]);
    }
  }
  if (value !== null && !replaced) out.push([key, value]);
  return out;
}

/** New meta with `key` set (replacing in place, order kept) or removed (`null`). */
export function withMetaEntry(meta: NodeMeta, key: string, value: string | null): NodeMeta {
  return buildMeta(withEntry(meta.entries, key, value));
}

export interface EdgeSegment {
  from: NodeRef[];
  to: NodeRef[];
  arrow: EdgeArrow;
  label: string | null;
  /** `A e1@--> B` — the id riding this segment's arrow, or null. */
  id: string | null;
}

export type ParsedLine =
  | { kind: 'header'; keyword: 'flowchart' | 'graph'; direction: Direction }
  | { kind: 'node'; node: NodeRef }
  | { kind: 'node-meta'; id: string; meta: NodeMeta }
  | { kind: 'style'; id: string; decls: [string, string][] }
  | { kind: 'edges'; segments: EdgeSegment[] }
  | { kind: 'click'; id: string; target: string }
  | { kind: 'subgraph-start'; title: string }
  | { kind: 'subgraph-end' }
  | { kind: 'opaque' };

export interface ModelLine {
  raw: string;
  parsed: ParsedLine;
  dirty: boolean;
}

export interface FlowchartModel {
  lines: ModelLine[];
}
