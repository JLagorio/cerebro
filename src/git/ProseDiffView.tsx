import { useMemo, useState } from 'react';
import { proseDiff, summarize, type DiffBlock, type WordPart } from '@/engine/proseDiff';

/** Unchanged blocks kept beside each change, as context. */
const CONTEXT = 1;

/** A run of unchanged blocks, folded, or one block shown. */
type Row = { kind: 'block'; block: DiffBlock } | { kind: 'fold'; blocks: DiffBlock[]; at: number };

/** The body's blocks with every unchanged run longer than its context folded. */
function rows(blocks: DiffBlock[]): Row[] {
  const out: Row[] = [];
  const changedAt = blocks.flatMap((b, i) => (b.op === 'same' ? [] : [i]));
  const near = (i: number) => changedAt.some((c) => Math.abs(c - i) <= CONTEXT);
  let fold: DiffBlock[] = [];
  let foldAt = 0;
  blocks.forEach((block, i) => {
    if (block.op !== 'same' || near(i)) {
      if (fold.length > 0) out.push({ kind: 'fold', blocks: fold, at: foldAt });
      fold = [];
      out.push({ kind: 'block', block });
      return;
    }
    if (fold.length === 0) foldAt = i;
    fold.push(block);
  });
  if (fold.length > 0) out.push({ kind: 'fold', blocks: fold, at: foldAt });
  return out;
}

function Words({ parts }: { parts: WordPart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.op === 'same' ? (
          <span key={i}>{part.text}</span>
        ) : part.op === 'ins' ? (
          <ins
            key={i}
            data-testid="prose-ins"
            className="bg-success-50 text-success-700 no-underline"
          >
            {part.text}
          </ins>
        ) : (
          <del key={i} data-testid="prose-del" className="bg-danger-50 text-danger-700">
            {part.text}
          </del>
        ),
      )}
    </>
  );
}

/** What a reader sees of one block: its label, then its words. */
function label(block: DiffBlock): string | null {
  if (block.kind === 'property') return block.name ?? null;
  if (block.kind === 'container' || block.kind === 'fence' || block.kind === 'code') {
    return block.name !== undefined && block.name !== '' ? block.name : null;
  }
  return null;
}

function Block({ block }: { block: DiffBlock }) {
  const side = block.after ?? block.before;
  const tag = label(block);
  const text = (t: string) => (t === '' ? ' ' : t);
  let body: React.ReactNode;
  if (block.op === 'changed' && block.parts != null) {
    body = <Words parts={block.parts} />;
  } else if (block.op === 'changed') {
    body = (
      <>
        <del data-testid="prose-del" className="block bg-danger-50 text-danger-700">
          {text(block.before?.text ?? '')}
        </del>
        <ins data-testid="prose-ins" className="block bg-success-50 text-success-700 no-underline">
          {text(block.after?.text ?? '')}
        </ins>
      </>
    );
  } else if (block.op === 'added') {
    body = (
      <ins data-testid="prose-ins" className="bg-success-50 text-success-700 no-underline">
        {text(side?.text ?? '')}
      </ins>
    );
  } else if (block.op === 'removed') {
    body = (
      <del data-testid="prose-del" className="bg-danger-50 text-danger-700">
        {text(side?.text ?? '')}
      </del>
    );
  } else {
    body = <span className="text-n-600">{text(side?.text ?? '')}</span>;
  }
  const heading = block.kind === 'heading';
  return (
    <div
      data-testid="prose-block"
      data-op={block.op}
      data-kind={block.kind}
      className={[
        'whitespace-pre-wrap break-words border-l-2 py-0.5 pl-2.5 text-sm',
        block.op === 'same' ? 'border-transparent' : 'border-cortex-300',
        heading ? 'font-semibold text-n-900' : 'text-n-800',
      ].join(' ')}
    >
      {tag !== null && <span className="mr-1.5 text-2xs text-n-400">{tag}</span>}
      {body}
    </div>
  );
}

/**
 * One version against the one before it, as prose (M58.4): the summary
 * sentence, then the properties that changed, then each changed block with
 * one unchanged block of context on either side; a longer unchanged run
 * folds into "Show N unchanged blocks". Every word is a React text node:
 * nothing from a page becomes markup.
 */
export function ProseDiffView({
  before,
  after,
  previousPath = null,
}: {
  /** The version before, or null for none (the page was created). */
  before: string | null;
  /** This version, or null when it removed the page. */
  after: string | null;
  previousPath?: string | null;
}) {
  const diff = useMemo(() => proseDiff(before, after), [before, after]);
  const summary = useMemo(() => summarize(diff, previousPath), [diff, previousPath]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());

  if (diff.kind === 'too_large') {
    return (
      <div data-testid="prose-diff">
        <p data-testid="prose-summary" className="m-0 text-sm text-n-600">
          {summary}
        </p>
      </div>
    );
  }
  const properties = diff.blocks.filter((b) => b.kind === 'property' && b.op !== 'same');
  const body = diff.blocks.filter((b) => b.kind !== 'property');
  return (
    <div data-testid="prose-diff" className="flex flex-col gap-3">
      <p data-testid="prose-summary" className="m-0 text-sm text-n-600">
        {summary}
      </p>
      {properties.length > 0 && (
        <section data-testid="prose-properties" className="flex flex-col gap-1">
          <h3 className="m-0 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            Properties
          </h3>
          {properties.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </section>
      )}
      {!diff.created && !diff.removed && !diff.onlySpacing && (
        <div className="flex flex-col gap-1">
          {rows(body).map((row, i) =>
            row.kind === 'block' ? (
              <Block key={i} block={row.block} />
            ) : opened.has(row.at) ? (
              row.blocks.map((b, k) => <Block key={`${i}.${k}`} block={b} />)
            ) : (
              <button
                key={i}
                type="button"
                data-testid="prose-unchanged"
                onClick={() => setOpened((prev) => new Set(prev).add(row.at))}
                className="self-start border-0 bg-transparent px-2.5 py-0.5 text-2xs text-n-400 hover:text-cortex-600"
              >
                {row.blocks.length === 1
                  ? 'Show 1 unchanged block'
                  : `Show ${row.blocks.length} unchanged blocks`}
              </button>
            ),
          )}
        </div>
      )}
      {(diff.created || diff.removed) && (
        <div className="flex flex-col gap-1">
          {body.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}
