import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { FieldPopover } from '@/detail/FieldPopover';
import type { FieldPopoverOption } from '@/detail/FieldPopover';
import { formatWikilink } from '@/engine/wikilink';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry, FieldDef, Schema } from '@/engine/types';

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

export const humanize = (s: string) => {
  const t = s.replace(/[-_]/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const dateInputClass =
  'h-[26px] rounded-md border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 [font-family:var(--font-mono)] text-[12px] text-[var(--n-800)] outline-none focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]';

export interface FieldEditorProps {
  entry: Entry;
  def: FieldDef;
  schema: Schema;
}

export function FieldEditor({ entry, def, schema }: FieldEditorProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const entries = useVaultStore((s) => s.entries);
  const resolved = schema.resolveField(entry, def.name);

  const patch = (value: unknown) => void patchFrontmatter(entry.path, { [def.name]: value });

  if (def.kind === 'status' || def.kind === 'select' || def.kind === 'multiselect') {
    const options: FieldPopoverOption[] =
      def.kind === 'status'
        ? schema
            .statusSetForProject(entry.project)
            .map((s) => ({ id: s.id, label: s.label, color: s.color, hollow: s.hollow }))
        : (def.options ?? []).map((o) => ({ id: o.id, label: o.label, color: o.color, hollow: o.hollow }));
    return (
      <span className="relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
        >
          <span
            className="box-border h-[9px] w-[9px] flex-none rounded-full"
            style={{ background: resolved.color ?? 'var(--n-300)' }}
          />
          {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            options={options}
            activeId={typeof resolved.raw === 'string' ? resolved.raw : null}
            onPick={(id) => patch(id)}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'person' || def.kind === 'relation') {
    const targetType = def.kind === 'person' ? 'Person' : (def.target ?? '');
    const options: FieldPopoverOption[] = entries
      .filter((e) => e.type === targetType)
      .map((c) => ({ id: pathStem(c.path), label: c.title, color: null }));
    return (
      <span className="relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-[7px] rounded-md px-2 py-[3px] text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
        >
          {def.kind === 'person' && resolved.display !== '' && <Avatar name={resolved.display} size={20} />}
          {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            searchable
            options={options}
            onPick={(id) => patch(formatWikilink(id))}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'date') {
    const value = typeof resolved.raw === 'string' ? resolved.raw : '';
    return (
      <input
        type="date"
        aria-label={humanize(def.name)}
        value={value}
        onChange={(e) => patch(e.target.value === '' ? null : e.target.value)}
        className={dateInputClass}
      />
    );
  }

  if (def.kind === 'daterange') {
    const raw = (resolved.raw ?? {}) as { start?: string; end?: string };
    const set = (part: 'start' | 'end') => (e: ChangeEvent<HTMLInputElement>) =>
      patch({ start: raw.start ?? null, end: raw.end ?? null, [part]: e.target.value || null });
    return (
      <span className="inline-flex items-center gap-1.5">
        <input type="date" aria-label={`${humanize(def.name)} start`} value={raw.start ?? ''} onChange={set('start')} className={dateInputClass} />
        <span className="text-[var(--n-400)]">to</span>
        <input type="date" aria-label={`${humanize(def.name)} end`} value={raw.end ?? ''} onChange={set('end')} className={dateInputClass} />
      </span>
    );
  }

  if (def.kind === 'checkbox') {
    return <Switch checked={resolved.raw === true} onChange={(checked) => patch(checked)} />;
  }

  // text | number — inline input on click
  if (draft !== null) {
    const commit = () => {
      const trimmed = draft.trim();
      // Number('junk') is NaN, which serde_yaml serializes as `.nan` on disk
      // (M1.x): refuse the commit instead of poisoning the frontmatter.
      if (def.kind === 'number' && trimmed !== '' && Number.isNaN(Number(trimmed))) {
        useUiStore.getState().toast('Enter a number');
        setDraft(null);
        return;
      }
      patch(trimmed === '' ? null : def.kind === 'number' ? Number(trimmed) : trimmed);
      setDraft(null);
    };
    return (
      <input
        autoFocus
        aria-label={humanize(def.name)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className="h-[26px] w-40 rounded-md border border-[var(--cortex-500)] px-1.5 text-[13px] text-[var(--n-900)] shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setDraft(resolved.display)}
      className="inline-flex rounded-md px-2 py-[3px] text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
    >
      {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
    </button>
  );
}
