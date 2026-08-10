/**
 * `ParsedLine` → source text, and the quoting rules that keep what we emit
 * something `./parse` reads straight back.
 */

import type { EdgeHead, EdgeStroke, FlowchartModel, ModelLine, NodeRef, Shape } from './types';

export const SHAPE_BRACKETS: Record<Shape, [string, string]> = {
  circle: ['((', '))'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  hexagon: ['{{', '}}'],
  rect: ['[', ']'],
  rounded: ['(', ')'],
  diamond: ['{', '}'],
};

/**
 * The minimum-length token for a stroke × head. `prevRaw` keeps an existing
 * o/x double family alive across rewrites; heads have no meaning on `~~~`.
 *
 * Every string this can produce is a token `matchArrow` reads back to the same
 * stroke and head — the last-boundary discipline, proven exhaustively in
 * model.test.ts rather than asserted here.
 */
export function emitArrow(stroke: EdgeStroke, head: EdgeHead, prevRaw: string): string {
  if (stroke === 'invisible') return '~~~';
  const core = stroke === 'thick' ? '==' : stroke === 'dotted' ? '-.-' : '--';
  if (head === 'double') {
    const start = prevRaw.startsWith('o') || prevRaw.startsWith('x') ? prevRaw[0] : '<';
    return `${start}${core}${start === '<' ? '>' : start}`;
  }
  if (head === 'open') return stroke === 'dotted' ? core : `${core}${core[0]}`;
  const marker = head === 'arrow' ? '>' : head === 'circle' ? 'o' : 'x';
  return `${core}${marker}`;
}

/**
 * The one character no quoting can rescue, at every emitter at once.
 *
 * A line break breaks the LINE-ORIENTED MODEL itself, before mermaid ever sees
 * it: `parseFlowchart` splits on `\n`, so a newline emitted inside a line
 * silently turns one `ModelLine` into two and every line index the ops layer
 * holds goes stale. MEASURED on 11.16.0, both halves of the damage are real
 * and they are different:
 *
 * - through a meta value, `A@{ label: a<LF>b }` is a PARSE ERROR — "end of the
 *   stream or a document separator is expected (2:1)" — which kills the whole
 *   diagram, not just the line;
 * - through brackets, `A[a<LF>b] --> B` is a document mermaid accepts happily,
 *   while OUR parser reads two opaque lines and the edge disappears from
 *   `edges()`.
 *
 * So it is substituted at the last boundary before the file, exactly as
 * `setEdgeLabel` substitutes `|` and every emitter below substitutes `"`.
 * Substituting is lossless where quoting cannot be; dropping the text silently
 * would not be. CRLF collapses to a single space, not two.
 *
 * `style` values need no such call: `STYLE_VALUE_SAFE` already excludes every
 * line terminator, and `styleDecl` refuses anything it would not read back.
 */
function flattenForLine(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, ' ');
}

/**
 * Bracket labels: quote whatever mermaid's `text` lexer state cannot take
 * bare. Measured char by char against 11.16.0 — `"()@[]{|}` are parse errors
 * unquoted and every one of them but `"` itself is fine inside quotes, so
 * quoting is lossless and `parseNodeToken` strips the quotes back off.
 *
 * `@` was the gap: `A[a@b]` kills the whole diagram, which made a rename to
 * any label carrying an `@` (an email, a handle) a render-stopper.
 */
function quoteLabel(rawLabel: string): string {
  const label = flattenForLine(rawLabel);
  return /[|()[\]{}&"@]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}

/**
 * Edge labels answer to the same lexer state as bracket labels, so the same
 * characters are fatal bare — measured: `-->|Deploy (prod)|` is a PARSE
 * ERROR, and so are `@ [ ] { } "`. Every one of them is legal quoted, and
 * mermaid strips the quotes again (flowDb.ts:304-306), so quoting is
 * lossless and parseEdgeLine reads it straight back.
 *
 * `|` is the one character quoting cannot rescue HERE: a quoted pipe is legal
 * upstream but our own scanner closes the label at the first `|` it sees, so
 * `setEdgeLabel` substitutes `|` → `/` before this ever runs — the Stage-C
 * scar, kept on purpose. Everything else is preserved, never dropped.
 */
function quoteEdgeLabel(rawLabel: string): string {
  const label = flattenForLine(rawLabel);
  return /[()[\]{}"@]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}

/** `|label|`, or nothing. Empty is "no label": `-->||` is a parse error. */
function emitEdgeLabel(label: string | null): string {
  return label === null || label === '' ? '' : `|${quoteEdgeLabel(label)}|`;
}

/**
 * Quote a meta value whenever bare text would not mean itself: the flow
 * mapping's own structural characters (`,` `:` `{` `}`), a `^` (illegal bare
 * per `flow.jison:57`, fine quoted per `flow.jison:52`), a comment-opening
 * ` #`, a leading YAML sigil, or edge whitespace/emptiness.
 *
 * Two characters are substituted rather than quoted, because quoting cannot
 * save either: `"` is the quote character itself and has no escape inside
 * `[^\"]+`, and a line break would end the LINE (see `flattenForLine` above —
 * a newline here is a parse error that kills the diagram, which is why the
 * claim below is only true once it has been flattened). Everything else is
 * PRESERVED by quoting rather than dropped: quoting is lossless, dropping
 * silently loses what the user typed.
 *
 * Every branch here emits something `parseMetaBody` can read back, so an edit
 * never costs a line its structural editability.
 */
function emitMetaValue(value: string): string {
  const cleaned = flattenForLine(value).replaceAll('"', "'");
  return /[,:{}^]|\s#|^[#'&*!]|^\s|\s$|^$/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/**
 * A click target that can sit inside `click <id> "…"` without taking the
 * diagram or this parser down with it. Null means "there is no link here" —
 * the caller must remove the line rather than write one.
 *
 * Three hazards, all MEASURED on the bundled 11.16.0 (`links.mermaid.test.ts`):
 *
 * - a line break ends the LINE before mermaid ever sees it, so `flattenForLine`
 *   runs first (see its comment — the same boundary every other emitter here
 *   answers to). Without it, `click A "a<LF>b.md"` splits into two lines that
 *   OUR OWN parser reads as opaque junk and the link silently vanishes;
 * - `"` closes the target string and has no escape, so it is substituted
 *   rather than dropped — substituting is lossless where quoting cannot be;
 * - an EMPTY target is a parse error (`click A ""` kills the whole diagram)
 *   and a whitespace-only one is a link mermaid discards (`utils.formatUrl`
 *   returns undefined for a blank url). Neither is a link, so both come back
 *   as null. This matters because Stage H feeds user-controlled vault paths
 *   through here: a caller must not be able to hand us a string that emits a
 *   line the renderer rejects.
 *
 * Everything else survives verbatim — spaces, `|`, `#`, `%%`, brackets,
 * backslashes and non-ASCII all measured safe inside the quoted target.
 */
export function clickTarget(target: string): string | null {
  const safe = flattenForLine(target).replaceAll('"', "'");
  return safe.trim() === '' ? null : safe;
}

export function emitNodeRef(ref: NodeRef): string {
  if (ref.label === null) return ref.id;
  const [open, close] = SHAPE_BRACKETS[ref.shape ?? 'rect'];
  return `${ref.id}${open}${quoteLabel(ref.label)}${close}`;
}

function emitLine(line: ModelLine): string {
  const indent = line.raw.match(/^\s*/)?.[0] ?? '';
  const p = line.parsed;
  switch (p.kind) {
    case 'header':
      return `${indent}${p.keyword} ${p.direction}`;
    case 'node':
      return `${indent}${emitNodeRef(p.node)}`;
    case 'node-meta':
      return `${indent}${p.id}@{ ${p.meta.entries
        .map(([k, v]) => `${k}: ${emitMetaValue(v)}`)
        .join(', ')} }`;
    // Dirty style lines emit canonical `k:v,` spacing; untouched ones keep
    // their quirks through `raw`, which the round-trip tests prove.
    case 'style':
      return `${indent}style ${p.id} ${p.decls.map(([k, v]) => `${k}:${v}`).join(',')}`;
    case 'edges': {
      // Contiguous chains re-emit as chains; ops splits non-contiguous lines.
      let out = `${indent}${p.segments[0].from.map(emitNodeRef).join(' & ')}`;
      for (const seg of p.segments) {
        out += ` ${seg.id !== null ? `${seg.id}@` : ''}${seg.arrow.raw}${emitEdgeLabel(
          seg.label,
        )} ${seg.to.map(emitNodeRef).join(' & ')}`;
      }
      return out;
    }
    // Exactly one space on each side of the id: mermaid's click state pops on
    // ONE whitespace character, so `click A  "x"` is a parse error (measured).
    //
    // `clickTarget` runs here as well as in `setNodeLink` — the emitter
    // validates its OUTPUT, not just its caller's input. A target it refuses
    // cannot be written at all (`click A ""` kills the diagram), so such a
    // line keeps its original bytes; only a hand-mutated model reaches that.
    case 'click': {
      const target = clickTarget(p.target);
      return target === null ? line.raw : `${indent}click ${p.id} "${target}"`;
    }
    case 'subgraph-start':
      return `${indent}subgraph ${p.title}`;
    case 'subgraph-end':
      return `${indent}end`;
    case 'opaque':
      return line.raw;
  }
}

export function serialize(model: FlowchartModel): string {
  return model.lines.map((l) => (l.dirty ? emitLine(l) : l.raw)).join('\n');
}
