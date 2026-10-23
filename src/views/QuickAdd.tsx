import type { TimeSlot } from '@/engine/timeGrid';
import { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { createTarget, type FiledUnder } from '@/engine/createRecord';
import { createOnDayValue } from '@/engine/schedule';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/** Create in a database's home, inheriting a view's band and related host. */
export function useQuickAdd(typeName: string, host: FiledUnder | null = null) {
  const createItem = useVaultStore((s) => s.createItem);
  const entries = useVaultStore((s) => s.entries);
  // M20.1: `createTarget` coerces a band's key into what the field actually
  // stores, which it cannot do without knowing the field's kind.
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);

  return async (
    title: string,
    band: { groupBy?: string | null; groupValue?: string | null } = {},
    extra: Record<string, unknown> = {},
  ): Promise<boolean> => {
    const trimmed = title.trim();
    if (trimmed === '') return false;
    const target = createTarget(typeName, { host, entries, schema, ...band });
    // slugify('!!!') is '' and create_note rejects an empty name. The
    // record's own key is the meaningful fallback where there is one; a
    // timestamp only when the type carries no key.
    const key = target.frontmatter.key;
    const fallback =
      typeof key === 'string' && key !== ''
        ? key.toLowerCase()
        : `record-${Date.now().toString(36)}`;
    try {
      await createItem({
        folder: target.folder,
        slug: slugify(trimmed) || fallback,
        frontmatter: { ...target.frontmatter, ...extra },
        // The body carries the typed title verbatim so the H1 keeps its
        // capitalization rather than the humanized slug.
        body: `# ${trimmed}\n`,
      });
      return true;
    } catch {
      toast(`Couldn't create "${trimmed}"`);
      return false;
    }
  };
}

/**
 * A calendar day's "+" (M53.16): creates a record of `typeName` dated to the
 * day or selected hours, in the shape `field` declares.
 *
 * The date cannot ride the band mechanism — a band sets a grouping value, not
 * an arbitrary property — so it goes through `useQuickAdd`'s `extra`
 * frontmatter, shaped by `createOnDayValue`. One hook, because the type screen
 * and a List each wrote the bare day for themselves, and a `daterange` field
 * rejects a bare day on the very next read. A page's embedded database, which
 * had no day "+" at all, creates through it too.
 */
export function useCreateOnDay(typeName: string, host: FiledUnder | null = null) {
  const quickAdd = useQuickAdd(typeName, host);
  const schema = useSchema();
  return (title: string, day: string, field: string, slot?: TimeSlot): Promise<boolean> =>
    quickAdd(title, {}, { [field]: createOnDayValue(typeName, field, day, schema, slot) });
}

/**
 * The tab row's New button (M12.8): creates an untitled record of the view's
 * type and opens it in the panel, where the title gets written — Notion's
 * "New", where naming happens on the page rather than in a prompt.
 */
export function useNewRecord(typeName: string) {
  const createItem = useVaultStore((s) => s.createItem);
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const openPath = useOpenPath('in-place');

  return async () => {
    const target = createTarget(typeName, { entries, schema });
    const key = target.frontmatter.key;
    const slug =
      typeof key === 'string' && key !== ''
        ? key.toLowerCase()
        : `untitled-${Date.now().toString(36)}`;
    try {
      const path = await createItem({
        folder: target.folder,
        slug,
        frontmatter: target.frontmatter,
        body: '# Untitled\n',
      });
      openPath(path);
    } catch {
      toast("Couldn't create a record");
    }
  };
}

/**
 * The inline "add a record here" control. Renders as a muted button until
 * clicked, then as a bare input — the same two-state shape the list row has
 * used since M1.
 */
export function QuickAddInline({
  label = 'New',
  ariaLabel,
  onCreate,
  compact = false,
  initiallyEditing = false,
  onClose,
}: {
  label?: string;
  ariaLabel: string;
  onCreate: (title: string) => Promise<boolean>;
  compact?: boolean;
  /** A group heading can open this draft directly instead of a second button. */
  initiallyEditing?: boolean;
  onClose?: (restoreFocus: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(initiallyEditing);
  const [title, setTitle] = useState('');
  // Double-Enter while the write is pending must not create two records.
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const ok = await onCreate(title);
    setSubmitting(false);
    if (ok) {
      setTitle('');
      setEditing(false);
      onClose?.(document.activeElement === inputRef.current);
    }
    // On failure the draft stays editable for retry.
  };

  const height = compact ? 'h-[30px]' : 'h-[34px]';

  if (!editing) {
    return (
      <button
        type="button"
        data-testid="quick-add"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
        className={`flex ${height} w-full items-center gap-2 border-b border-n-100 px-3 text-sm text-n-400 hover:bg-n-25 hover:text-n-700`}
      >
        <Icon name="plus" size={13} />
        {label}
      </button>
    );
  }

  return (
    <div className={`flex ${height} items-center gap-2 border-b border-n-100 px-3`}>
      <Icon name="plus" size={13} color="var(--n-400)" />
      <input
        ref={inputRef}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setTitle('');
            setEditing(false);
            onClose?.(document.activeElement === inputRef.current);
          }
        }}
        placeholder="Title — Enter to create"
        aria-label={ariaLabel}
        className="h-6 flex-1 border-none bg-transparent text-sm text-n-900 outline-none"
      />
    </div>
  );
}
