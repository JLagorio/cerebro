import React from 'react';
import { resolveBundleLink, type Source } from '@/engine/okf';

/**
 * Read-only markdown for knowledge concepts (M5).
 *
 * Deliberately not the BlockNote editor: the bundle is not yours to edit,
 * and mounting a full editing surface to forbid editing invites the very
 * thing it forbids. A renderer also lets citations resolve — OKF attributes
 * claims with `[^id]` footnotes whose label is a `sources[].id` (§5.1), so
 * a citation can render as a chip that points at the source that backs it.
 *
 * OKF asks producers to favour structural markdown (§4.2), which is what
 * this covers: headings, lists, tables, fences, quotes, rules, and the
 * inline set. Anything unrecognised falls through as a paragraph rather
 * than being dropped — consumers must tolerate, not reject (§11).
 */

export interface ConceptBodyProps {
  markdown: string;
  sources: Source[];
  /** The concept's own vault path — relative links resolve against it. */
  fromPath: string;
  /** A bundle-internal markdown link was clicked (path is vault-relative). */
  onOpenConcept?: (path: string) => void;
  /** A `[^id]` citation was clicked. */
  onCite?: (sourceId: string) => void;
}

// Link resolution (OKF §6.1) lives in the engine — the log timeline resolves
// the same shapes, and two copies would drift.
export { resolveBundleLink as resolveLink } from '@/engine/okf';

// --- Inline ---------------------------------------------------------------

// Order matters: code spans win over emphasis so `**` inside a fence-span
// stays literal, and footnotes are matched before links so `[^id]` is never
// read as a link with an empty target.
const INLINE =
  /(`[^`]+`)|(\[\^([^\]\s]+)\](?!:))|(\[([^\]]+)\]\(([^)]+)\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;

interface InlineContext {
  fromPath: string;
  sources: Source[];
  onOpenConcept?: (path: string) => void;
  onCite?: (sourceId: string) => void;
}

function Citation({ id, ctx }: { id: string; ctx: InlineContext }) {
  const index = ctx.sources.findIndex((s) => s.id === id);
  // A label with no matching `sources` entry is a dangling citation. Show it
  // muted rather than hiding it — a claim that cites nothing is exactly what
  // a reviewer needs to see.
  const known = index >= 0;
  return (
    <button
      type="button"
      title={
        known ? (ctx.sources[index].title ?? ctx.sources[index].resource) : `No source "${id}"`
      }
      onClick={known ? () => ctx.onCite?.(id) : undefined}
      className={[
        'mx-[1px] inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-0 px-1 align-super text-[9.5px] font-semibold [font-family:var(--font-mono)]',
        known
          ? 'cursor-pointer bg-cortex-50 text-cortex-600 hover:bg-cortex-100'
          : 'cursor-default bg-n-100 text-n-400',
      ].join(' ')}
    >
      {known ? index + 1 : '?'}
    </button>
  );
}

export function renderInline(text: string, ctx: InlineContext): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    cursor = at + m[0].length;

    if (m[1] !== undefined) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-n-100 px-1 py-[1px] [font-family:var(--font-mono)] text-xs text-n-800"
        >
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(<Citation key={key++} id={m[3]} ctx={ctx} />);
    } else if (m[4] !== undefined) {
      const label = m[5];
      const target = resolveBundleLink(m[6], ctx.fromPath);
      nodes.push(
        'internal' in target ? (
          <button
            key={key++}
            type="button"
            onClick={() => ctx.onOpenConcept?.(target.internal)}
            className="cursor-pointer border-0 bg-transparent p-0 text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500"
          >
            {label}
          </button>
        ) : (
          <a
            key={key++}
            href={target.external}
            target="_blank"
            rel="noreferrer noopener"
            className="text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500"
          >
            {label}
          </a>
        ),
      );
    } else if (m[7] !== undefined) {
      nodes.push(<strong key={key++}>{m[7].slice(2, -2)}</strong>);
    } else if (m[8] !== undefined) {
      nodes.push(<em key={key++}>{m[8].slice(1, -1)}</em>);
    }
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

// --- Blocks ---------------------------------------------------------------

const splitRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

const isDivider = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);

/** `[^id]: text` definitions render in the Sources panel, not in the body. */
const isFootnoteDef = (line: string): boolean => /^\[\^[^\]\s]+\]:/.test(line);

const HEADING_CLASS: Record<number, string> = {
  1: 'mb-2 mt-6 text-[22px] font-semibold tracking-[-0.01em] text-n-900',
  2: 'mb-2 mt-6 text-lg font-semibold text-n-900',
  3: 'mb-1.5 mt-5 text-md font-semibold text-n-800',
};

export function ConceptBody({
  markdown,
  sources,
  onOpenConcept,
  onCite,
  fromPath,
}: ConceptBodyProps) {
  const ctx: InlineContext = { fromPath, sources, onOpenConcept, onCite };
  const lines = markdown.split('\n');
  const blocks: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  const inline = (text: string) => renderInline(text, ctx);

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '' || isFootnoteDef(line)) {
      i += 1;
      continue;
    }

    // Fenced code — consumed first so nothing inside is parsed as markdown.
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence !== null) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF — an unterminated fence still renders)
      blocks.push(
        <pre
          key={key++}
          className="my-3 overflow-x-auto rounded-lg border border-n-200 bg-n-25 px-3 py-2.5 [font-family:var(--font-mono)] text-xs leading-[18px] text-n-800"
        >
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = Math.min(heading[1].length, 3);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
      blocks.push(
        <Tag key={key++} className={HEADING_CLASS[level]}>
          {inline(heading[2])}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-5 border-0 border-t border-n-200" />);
      i += 1;
      continue;
    }

    // Table: a header row followed by a divider row.
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th
                    key={c}
                    className="border-0 border-b border-solid border-n-200 px-2 py-1.5 text-left font-semibold text-n-700"
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="border-0 border-b border-solid border-n-100 px-2 py-1.5 align-top text-n-700"
                    >
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-3 border-0 border-l-2 border-solid border-n-200 pl-3 text-sm text-n-600"
        >
          {inline(quote.join(' '))}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^\s*([-*+]|\d+\.)\s+/.exec(line);
    if (bullet !== null) {
      const ordered = /\d/.test(bullet[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (item === null) break;
        if (/\d/.test(item[1]) !== ordered) break;
        items.push(item[2]);
        i += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={key++}
          className={`my-2 flex list-outside flex-col gap-1 pl-5 text-[13.5px] leading-[21px] text-n-700 ${
            ordered ? 'list-decimal' : 'list-disc'
          }`}
        >
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+\.\s|---|\*\*\*|___)/.test(lines[i]) &&
      !isFootnoteDef(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length > 0) {
      blocks.push(
        <p key={key++} className="my-2.5 text-[13.5px] leading-[21px] text-n-700">
          {inline(paragraph.join(' '))}
        </p>,
      );
    } else {
      i += 1; // never stall on a line no branch consumed
    }
  }

  return <div data-testid="concept-body">{blocks}</div>;
}
