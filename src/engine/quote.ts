/**
 * Quote-anchored body edits (M55.5): the TS twin of
 * `src-tauri/src/vault/quote.rs`, which `edit_note` plans with.
 *
 * Both replay `src-tauri/fixtures/quote-cases.json`, which pins every message
 * byte for byte (D3). The mock backend's `agentEdit` plans with this, so the
 * browser refuses what the packaged app refuses, in the same words.
 *
 * Offsets here are UTF-16 units and Rust's are bytes, so the cases pin lines
 * and code-point contexts only: the overlapping search steps one code point,
 * and a context is cut and counted in code points, never inside a surrogate
 * pair.
 */

export const QUOTE_LIMITS = {
  /** The most edits one call may carry. */
  maxEdits: 100,
  /** Code points of context shown on each side of a listed match. */
  contextChars: 40,
  /** Code points of a listed match shown before the context after it. */
  matchChars: 80,
  /** Matches listed under a refused edit before the rest are counted. */
  maxListed: 20,
} as const;

/** One replacement: the passage quoted in `old`, the markdown in `new`, and
 * which appearance of `old` is meant (counting from 1) when there are several. */
export interface QuoteEdit {
  old: string;
  new: string;
  occurrence?: number;
}

/** Every edit landed in one splice, with the 1-based line where each edit's
 * new text starts, in the order given; or the refusal, every failing edit
 * listed. */
export type QuotePlan =
  { ok: true; text: string; lines: number[] } | { ok: false; message: string };

const NOTHING_WRITTEN = 'Nothing was written.';

/**
 * Plan `edits` against `body`, the note body as get_note prints it. `prefix`
 * is every character before it (BOM, fences and YAML): never matched or
 * changed, and asked only to say that a quote missing from the body sits in
 * the frontmatter.
 */
export function planEdits(body: string, prefix: string, edits: readonly QuoteEdit[]): QuotePlan {
  if (edits.length === 0) return refused(['edit_note needs at least one edit.']);
  if (edits.length > QUOTE_LIMITS.maxEdits) {
    return refused([
      `edit_note takes at most ${QUOTE_LIMITS.maxEdits} edits in one call; this call has ${edits.length}.`,
    ]);
  }
  const failures: string[] = [];
  const spans: [number, number][] = [];
  edits.forEach((edit, index) => {
    const start = resolve(body, prefix, index + 1, edit);
    if (typeof start === 'number') spans.push([start, start + edit.old.length]);
    else failures.push(...start);
  });
  if (failures.length > 0) return refused(failures);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const start = Math.max(spans[i][0], spans[j][0]);
      if (start < Math.min(spans[i][1], spans[j][1])) {
        failures.push(
          `Edits ${i + 1} and ${j + 1} overlap at line ${lineAt(body, start)}; each edit must replace a passage of its own.`,
        );
      }
    }
  }
  if (failures.length > 0) return refused(failures);
  const order = spans.map((_, i) => i).sort((a, b) => spans[a][0] - spans[b][0]);
  let text = '';
  const lines = new Array<number>(edits.length).fill(0);
  let at = 0;
  for (const i of order) {
    text += body.slice(at, spans[i][0]);
    lines[i] = lineAt(text, text.length);
    text += edits[i].new;
    at = spans[i][1];
  }
  text += body.slice(at);
  return { ok: true, text, lines };
}

/** Where edit `i` lands in `body`, or the lines that say why it cannot. */
function resolve(body: string, prefix: string, i: number, edit: QuoteEdit): number | string[] {
  if (edit.old === '') return [`Edit ${i}: \`old\` is empty — quote the text to replace.`];
  if (edit.new === edit.old) {
    return [`Edit ${i}: \`new\` is the same as \`old\`, so it changes nothing.`];
  }
  if (edit.occurrence === 0) return [`Edit ${i}: \`occurrence\` counts from 1.`];
  const found = matches(body, edit.old);
  const n = found.length;
  const k = edit.occurrence;
  if (n === 0) {
    return prefix.includes(edit.old)
      ? [
          `Edit ${i}: the quoted text is in the frontmatter, which edit_note never changes. Use update_frontmatter for properties.`,
        ]
      : [
          `Edit ${i}: the quoted text is not in the note's body. Quote it exactly as get_note shows it, spacing, line breaks and markdown included, or read the note again if it may have changed.`,
        ];
  }
  if (k === undefined) {
    if (n === 1) return found[0];
    return listed(
      `Edit ${i}: the quoted text appears ${n} times. Pass \`occurrence\` (counting from 1) or quote a longer passage:`,
      body,
      edit.old,
      found,
    );
  }
  if (k > n) {
    return listed(
      `Edit ${i}: \`occurrence\` is ${k}, but the quoted text appears ${n} ${n === 1 ? 'time' : 'times'}:`,
      body,
      edit.old,
      found,
    );
  }
  return found[k - 1];
}

/** Every start of `quote` in `body`, overlapping ones included: after a
 * match the search goes on one code point later, so `aa` is in `aaa` twice. */
function matches(body: string, quote: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const start = body.indexOf(quote, from);
    if (start === -1) return found;
    found.push(start);
    from = start + ((body.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
  }
}

/** `head`, then one line per match (at most `maxListed`), then the count of
 * the rest. */
function listed(head: string, body: string, quote: string, found: number[]): string[] {
  const lines = [head];
  found.slice(0, QUOTE_LIMITS.maxListed).forEach((start, k) => {
    lines.push(
      `  ${k + 1}. line ${lineAt(body, start)}: ${context(body, start, start + quote.length)}`,
    );
  });
  if (found.length > QUOTE_LIMITS.maxListed) {
    lines.push(`  … and ${found.length - QUOTE_LIMITS.maxListed} more`);
  }
  return lines;
}

/** The 1-based line `offset` falls on. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) {
    line++;
  }
  return line;
}

/** The body around the match `start..end`, counted in code points, with an
 * ellipsis at each end that was cut, JSON-escaped. */
function context(body: string, start: number, end: number): string {
  const before = Array.from(body.slice(0, start)).length;
  const within = Array.from(body.slice(start, end)).length;
  const points = Array.from(body);
  const from = Math.max(0, before - QUOTE_LIMITS.contextChars);
  const to = Math.min(
    points.length,
    before + Math.min(within, QUOTE_LIMITS.matchChars) + QUOTE_LIMITS.contextChars,
  );
  const shown =
    (from > 0 ? '…' : '') + points.slice(from, to).join('') + (to < points.length ? '…' : '');
  return JSON.stringify(shown);
}

function refused(lines: string[]): QuotePlan {
  return { ok: false, message: [...lines, NOTHING_WRITTEN].join('\n') };
}
