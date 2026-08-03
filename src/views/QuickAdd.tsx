import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { createTarget } from '@/engine/createRecord';
import type { Entry } from '@/engine/types';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Create a record from wherever you are looking at records (M9.6).
 *
 * Notion's rule: any surface that lists records can create one, and it
 * inherits the band it was created in. This was previously ListView's
 * private QuickAddRow, which meant only the list layout inside a project
 * could create anything at all.
 */
export function useQuickAdd(typeName: string, project: Entry | null) {
  const createItem = useVaultStore((s) => s.createItem);
  const entries = useVaultStore((s) => s.entries);
  const toast = useUiStore((s) => s.toast);

  return async (
    title: string,
    band: { groupBy?: string | null; groupValue?: string | null } = {},
    extra: Record<string, unknown> = {},
  ): Promise<boolean> => {
    const trimmed = title.trim();
    if (trimmed === '') return false;
    const target = createTarget(typeName, { project, entries, ...band });
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
 * The tab row's New button (M12.8): creates an untitled record of the view's
 * type and opens it in the panel, where the title gets written — Notion's
 * "New", where naming happens on the page rather than in a prompt.
 */
export function useNewRecord(typeName: string) {
  const createItem = useVaultStore((s) => s.createItem);
  const entries = useVaultStore((s) => s.entries);
  const toast = useUiStore((s) => s.toast);
  const openPath = useOpenPath('in-place');

  return async () => {
    const target = createTarget(typeName, { project: null, entries });
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
}: {
  label?: string;
  ariaLabel: string;
  onCreate: (title: string) => Promise<boolean>;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
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
        className={`flex ${height} w-full items-center gap-2 border-b border-n-100 px-3 text-[12.5px] text-n-400 hover:bg-n-25 hover:text-n-700`}
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
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setTitle('');
            setEditing(false);
          }
        }}
        placeholder="Title — Enter to create"
        aria-label={ariaLabel}
        className="h-6 flex-1 border-none bg-transparent text-[13px] text-n-900 outline-none"
      />
    </div>
  );
}
