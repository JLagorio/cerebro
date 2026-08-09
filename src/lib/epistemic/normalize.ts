/**
 * `normalize_alias_v1` — the TS half of the one alias-key normalization
 * (M22.4). Pipeline: NFKC → default full lowercase (with Final_Sigma via
 * String.prototype.toLowerCase) → each run of Unicode White_Space becomes
 * one ASCII space → trim. Parity with the Rust implementation is pinned by
 * the shared conformance vectors (`conformance/derivations.json`), not
 * trusted from either runtime.
 */

// Unicode White_Space, the exact set Rust's char::is_whitespace tests.
// (JS \s also matches U+FEFF, which is NOT White_Space — so no regex.)
const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function normalizeAliasV1(alias: string): string {
  const folded = alias.normalize('NFKC').toLowerCase();
  let out = '';
  let pendingSpace = false;
  for (const ch of folded) {
    if (WHITE_SPACE.has(ch.codePointAt(0) ?? -1)) {
      pendingSpace = out.length > 0;
    } else {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      out += ch;
    }
  }
  return out;
}
