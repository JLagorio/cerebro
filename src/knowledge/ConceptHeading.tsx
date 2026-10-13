import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { Concept } from '@/engine/okf';
import { useConcepts } from '@/knowledge/useConcepts';
import { useLedgerStore } from '@/stores/ledgerStore';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * One line of frontmatter, edited in place (M50.1). A textarea because real
 * titles wrap; Enter commits, Escape abandons. Aligned to the editor's 54px
 * block gutter (45 + 1px border + 8px padding) so the header and the body
 * share one left edge.
 */
function FieldText({
  value,
  label,
  placeholder,
  className,
  testId,
  onCommit,
}: {
  value: string;
  label: string;
  placeholder: string;
  className: string;
  testId: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const fit = () => {
      el.style.height = 'auto';
      // scrollHeight excludes the border, and the box is border-box.
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    // A narrower column rewraps the text onto lines the old height does not
    // show — "Sync error" with "rate" hidden below it (M52.5), DocPage's
    // title fixed the same way. Width only: the fit itself changes the
    // height, and refitting on that would chase its own tail.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);
  return (
    <textarea
      ref={ref}
      data-testid={testId}
      aria-label={label}
      placeholder={placeholder}
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value.trim()) onCommit(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(value);
        }
      }}
      className={`ml-[45px] block w-[calc(100%-45px)] resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-0 outline-none placeholder:text-n-400 hover:border-n-200 focus-visible:border-cortex-500 focus-visible:shadow-[var(--ring)] ${className}`}
    />
  );
}

/**
 * A concept page's header (M50.1): what the concept is called and what it
 * claims to cover, both frontmatter under OKF, both editable here — an edit
 * goes through `updateFrontmatter`, which the capture valve records as the
 * person's own (M23.7, M49).
 *
 * Above them, the two things a reader must not miss: that the bundle no
 * longer believes this (M15: the reading pane gave no sign a retired claim
 * was retired), and that the file on disk is not the one the ledger recorded
 * (M49.6, K27).
 */
export function ConceptHeading({ concept }: { concept: Concept }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const navigate = useNavStore((s) => s.navigate);
  const all = useConcepts();
  const ledgerVault = useLedgerStore((s) => s.vault);
  const ledgerRead = useLedgerStore((s) => s.read);
  const disputed =
    ledgerVault !== vaultPath || ledgerRead.kind !== 'read'
      ? undefined
      : ledgerRead.status.quarantined.find((q) => q.path === concept.entry.path);
  // A replaced concept carries no back-pointer of its own (M8.7: the
  // replacement holds `supersedes`), so what replaced it is looked up.
  const replacement =
    concept.supersededBy === null
      ? null
      : (all.find((c) => c.entry.path === concept.supersededBy) ?? null);

  return (
    <div data-testid="concept-heading" className="mb-3">
      {concept.supersededBy !== null && (
        <div
          data-testid="superseded-banner"
          className="mb-3 ml-[54px] flex flex-wrap items-center gap-1.5 rounded-lg border border-warn-300 bg-warn-50 px-3 py-2 text-xs text-warn-700"
        >
          <Icon name="archive" size={12} />
          <span>Replaced by</span>
          <button
            type="button"
            data-path={concept.supersededBy}
            onClick={() => navigate({ kind: 'doc', path: concept.supersededBy as string })}
            className="border-0 bg-transparent p-0 text-xs font-medium text-warn-700 underline underline-offset-2"
          >
            {replacement?.title ?? 'a newer concept'}
          </button>
        </div>
      )}
      {disputed !== undefined && (
        <p
          data-testid="concept-disputed"
          data-class={disputed.class}
          className="mb-3 ml-[54px] rounded-md border border-warn-300 bg-warn-50 px-2 py-1 text-xs text-warn-700"
        >
          This file differs from its recorded history — what is shown is the file on disk, not what
          was recorded or reviewed. Keep or Restore it from the banner above.
        </p>
      )}
      <FieldText
        testId="concept-title"
        label="Concept title"
        placeholder="Untitled concept"
        value={concept.title}
        className="text-4xl font-bold leading-[52px] text-n-900"
        onCommit={(next) => {
          if (next !== '') void patchFrontmatter(concept.entry.path, { title: next });
        }}
      />
      <FieldText
        testId="concept-description"
        label="Concept description"
        placeholder="What this concept covers"
        value={concept.description ?? ''}
        className="mt-1 text-md leading-[22px] text-n-600"
        onCommit={(next) =>
          void patchFrontmatter(concept.entry.path, { description: next === '' ? null : next })
        }
      />
    </div>
  );
}
