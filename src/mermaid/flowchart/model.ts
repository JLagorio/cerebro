/**
 * The line-oriented flowchart model (M29.14).
 *
 * Every source line is either UNDERSTOOD (header, node definition, edge line —
 * chains and & groups included — subgraph markers, `@{ … }` metadata, `style`,
 * the plain-link `click` form) or OPAQUE (frontmatter, comments,
 * classDef/class/linkStyle, every other `click` variant, and anything the
 * parser is not 100% sure about, a half-owned `style` body
 * included). Serialization re-emits `raw` for every non-dirty line,
 * so opaque content survives byte-for-byte BY CONSTRUCTION — the invariant the
 * whole structural editor stands on.
 */

export * from './types';
export * from './parse';
export * from './emit';
export * from './views';
