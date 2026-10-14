import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EntryIcon, PageIconGlyph } from '@/components/PageIcon';
import { Icon } from '@/components/ui/Icon';
import { pageIconOf } from '@/engine/pageChrome';
import {
  isLinkablePage,
  linkTargetOf,
  resolvePageRef,
  statusFieldOf,
  type PageRef,
} from '@/engine/pageCard';
import type { Entry, Schema } from '@/engine/types';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { FieldChip } from '@/views/FieldChip';

/**
 * The page card's face (M55.14): one other page, shown live.
 *
 * Three faces, chosen by the pointer and the vault alone:
 *
 * - unset — the picker, "Find a page", when the card may be written; "No page
 *   chosen" when it may not.
 * - resolved — the page's icon, title, where it lives, its status when its
 *   type has one, and Open.
 * - missing — `No page named "<target>"`. The pointer is kept as written: a
 *   page that comes back later is found again, and the card is rewritten only
 *   when the person picks another page.
 *
 * Read-only by design (M29.48): the card names a page and opens it, and never
 * renders its body or an editor. The root is our own element, so its
 * attributes are set even at their defaults (DOM trap 4), and every control
 * takes onClick, never onPointerDown (DOM trap 9).
 */

/** Rows the picker lists before it asks for more letters. */
export const PICKER_LIMIT = 50;

export interface PageCardViewProps {
  target: string;
  alias: string;
  entries: Entry[];
  schema: Schema;
  onOpen: (path: string) => void;
  /** Absent when the card may not be written: no picker, no Choose button. */
  onChange?: (ref: PageRef) => void;
}

export function PageCardView({
  target,
  alias,
  entries,
  schema,
  onOpen,
  onChange,
}: PageCardViewProps) {
  const [choosing, setChoosing] = useState(false);
  const entry = useMemo(
    () => (target === '' ? null : resolvePageRef({ target, alias }, entries)),
    [target, alias, entries],
  );
  const state = target === '' ? 'unset' : entry === null ? 'missing' : 'resolved';
  const pick =
    onChange === undefined
      ? undefined
      : (picked: Entry) => {
          setChoosing(false);
          onChange({ target: linkTargetOf(picked), alias: '' });
        };

  return (
    <div
      data-testid="page-card"
      data-state={state}
      contentEditable={false}
      className="my-1 w-full rounded-lg border border-n-200 bg-n-0 px-3 py-2 text-sm"
    >
      {state === 'resolved' && entry !== null ? (
        <ResolvedFace entry={entry} alias={alias} schema={schema} onOpen={onOpen} />
      ) : state === 'missing' && !choosing ? (
        <div className="flex items-center gap-2">
          <Icon name="file-x" size={16} color="var(--n-400)" />
          <span className="min-w-0 flex-1 truncate text-n-500" data-testid="page-card-missing">
            No page named &ldquo;{target}&rdquo;
          </span>
          {pick !== undefined && (
            <button
              type="button"
              data-testid="page-card-choose"
              onClick={() => setChoosing(true)}
              className="flex-none rounded-md border border-n-300 bg-n-0 px-2 py-0.5 text-xs text-n-700 hover:bg-n-50"
            >
              Choose a page
            </button>
          )}
        </div>
      ) : pick === undefined ? (
        <p className="m-0 text-n-500">No page chosen</p>
      ) : (
        <PagePicker
          entries={entries}
          onPick={pick}
          onCancel={state === 'missing' ? () => setChoosing(false) : undefined}
        />
      )}
    </div>
  );
}

function ResolvedFace({
  entry,
  alias,
  schema,
  onOpen,
}: {
  entry: Entry;
  alias: string;
  schema: Schema;
  onOpen: (path: string) => void;
}) {
  const field = statusFieldOf(entry, schema);
  const status = field === null ? null : schema.resolveField(entry, field.name);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <EntryIcon entry={entry} size={18} fallback={{ name: 'file-text', color: 'var(--n-500)' }} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-n-900" data-testid="page-card-title">
          {alias === '' ? entry.title : alias}
        </div>
        <div className="truncate text-2xs text-n-500">{entry.type ?? entry.path}</div>
      </div>
      {status !== null && status.display !== '' && (
        <span data-testid="page-card-status" className="flex-none">
          <FieldChip resolved={status} />
        </span>
      )}
      <button
        type="button"
        data-testid="page-card-open"
        onClick={() => onOpen(entry.path)}
        className="flex-none rounded-md border border-n-300 bg-n-0 px-2 py-0.5 text-xs text-n-700 hover:bg-n-50"
      >
        Open
      </button>
    </div>
  );
}

/**
 * Pick a page by title or path containment, up to PICKER_LIMIT rows. The
 * shared ranker replaces the containment test in M59.3.
 */
function PagePicker({
  entries,
  onPick,
  onCancel,
}: {
  entries: Entry[];
  onPick: (entry: Entry) => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState('');
  const pages = useMemo(
    () => entries.filter(isLinkablePage).sort((a, b) => a.title.localeCompare(b.title)),
    [entries],
  );
  const q = query.trim().toLowerCase();
  const matches =
    q === ''
      ? pages
      : pages.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
  const shown = matches.slice(0, PICKER_LIMIT);
  const more = matches.length - shown.length;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Icon name="search" size={14} color="var(--n-500)" />
        {/* No autoFocus: a page that merely LOADS with an unset card must not
            take the caret. The `/` insert focuses this field itself. */}
        <input
          data-testid="page-card-search"
          aria-label="Find a page"
          placeholder="Find a page"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (shown[0] !== undefined) onPick(shown[0]);
            }
            if (e.key === 'Escape' && onCancel !== undefined) {
              e.preventDefault();
              onCancel();
            }
          }}
          className="min-w-0 flex-1 rounded-xs border border-n-200 bg-n-0 px-1.5 py-0.5 text-sm outline-none"
        />
      </div>
      <ul className="m-0 max-h-56 overflow-y-auto p-0">
        {shown.map((e) => (
          <li key={e.path} className="list-none">
            <button
              type="button"
              data-testid="page-card-option"
              onClick={() => onPick(e)}
              className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-sm text-n-800 hover:bg-n-50"
            >
              <PageIconGlyph
                icon={pageIconOf(e)}
                fallback={{ name: 'file-text', color: 'var(--n-500)' }}
              />
              <span className="truncate">{e.title}</span>
              <span className="ml-auto truncate pl-2 text-2xs text-n-400">{e.path}</span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="m-0 px-1.5 text-2xs text-n-500" data-testid="page-card-more">
          {more} more — keep typing
        </p>
      )}
    </div>
  );
}

/** The card over the live vault: re-rendered on every scan, so a renamed or
 *  re-iconed target shows as it is now. */
export function ConnectedPageCard({
  target,
  alias,
  onChange,
}: {
  target: string;
  alias: string;
  onChange?: (ref: PageRef) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const open = useOpenPath();
  return (
    <PageCardView
      target={target}
      alias={alias}
      entries={entries}
      schema={schema}
      onOpen={open}
      onChange={onChange}
    />
  );
}
