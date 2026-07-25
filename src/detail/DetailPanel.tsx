import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { readNote, saveNote, setNoteTitle } from '@/lib/ipc';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';

export function DetailPanel() {
  const detailPath = useUiStore((s) => s.detailPath);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const toast = useUiStore((s) => s.toast);
  const entry = useEntry(detailPath);
  const schema = useSchema();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState<string | null>(null);
  const [savedBody, setSavedBody] = useState('');

  useEffect(() => {
    setTitle(entry?.title ?? '');
  }, [entry?.path, entry?.title]);

  useEffect(() => {
    setBody(null);
    if (!entry || !vaultPath) return;
    let cancelled = false;
    readNote(vaultPath, entry.path)
      .then((text) => {
        if (!cancelled) {
          // Deviation (execution-log note 10, reported): Rust read_note
          // returns the body verbatim including the blank line after the
          // frontmatter fence, while the mock strips leading newlines —
          // normalize here so both backends display identically.
          const display = text.replace(/^\n+/, '');
          setBody(display);
          setSavedBody(display);
        }
      })
      .catch(() => {
        // Deviation (execution-log note 16a guard discipline, reported): the
        // plan's bare .then left a read failure as an unhandled rejection
        // with the textarea disabled forever and no explanation.
        if (!cancelled) toast("Couldn't load description");
      });
    return () => {
      cancelled = true;
    };
  }, [entry?.path, vaultPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDetail]);

  if (!detailPath || !entry) return null;

  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const declared = typeDef?.fields ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const undeclared = [...Object.keys(entry.properties), ...Object.keys(entry.relationships)].filter(
    (k) => !declaredNames.has(k) && k !== 'type' && k !== 'key',
  );
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  const commitTitle = async () => {
    const trimmed = title.trim();
    if (!vaultPath || trimmed === '' || trimmed === entry.title) {
      setTitle(entry.title);
      return;
    }
    // Deviation (execution-log note 16a, reported): the plan left this
    // direct ipc call unguarded — onBlur fire-and-forgets it, so a failed
    // rename was an unhandled rejection the user never saw. Catch → toast
    // (Task 17/20 precedent) and revert the input to disk truth.
    try {
      await setNoteTitle(vaultPath, entry.path, trimmed);
      await rescan();
    } catch {
      toast("Couldn't rename item");
      setTitle(entry.title);
    }
  };

  const commitBody = async () => {
    if (!vaultPath || body === null || body === savedBody) return;
    // Deviation (execution-log note 16a, reported): same guard discipline as
    // commitTitle — a failed save must surface; savedBody stays stale so the
    // next blur retries.
    try {
      await saveNote(vaultPath, entry.path, body);
      setSavedBody(body);
      toast('Saved');
    } catch {
      toast("Couldn't save description");
    }
  };

  return (
    <aside
      aria-label="Detail panel"
      className="cb-panel-in fixed right-0 top-0 z-30 flex h-full w-[420px] flex-col border-l border-[var(--n-200)] bg-[var(--n-0)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--n-100)] px-4 py-3">
        <span className="inline-flex" style={{ color: typeDef?.color ?? 'var(--n-500)' }}>
          <Icon name={typeDef?.icon ?? 'file-text'} size={14} />
        </span>
        <span className="text-[12px] font-medium text-[var(--n-700)]">{entry.type ?? 'Note'}</span>
        {key !== '' && <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-500)]">{key}</span>}
        <span className="flex-1" />
        <IconButton icon="x" label="Close" size="sm" onClick={closeDetail} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3.5">
        <input
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setTitle(entry.title);
            }
          }}
          className="-ml-2 mb-3.5 w-full rounded-lg border border-transparent px-2 py-1 text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-[var(--n-900)] outline-none hover:border-[var(--n-200)] focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]"
        />
        <div className="mb-4 flex flex-col gap-[7px]">
          {declared.map((f) => (
            <div key={f.name} className="flex items-center gap-2">
              <span className="w-24 flex-none text-[12px] text-[var(--n-500)]">{humanize(f.name)}</span>
              <FieldEditor entry={entry} def={f} schema={schema} />
            </div>
          ))}
          {undeclared.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-24 flex-none text-[12px] text-[var(--n-500)]">{humanize(name)}</span>
              <span className="text-[12.5px] text-[var(--n-700)]">
                {name in entry.relationships
                  ? entry.relationships[name].join(', ')
                  : String(entry.properties[name])}
              </span>
            </div>
          ))}
        </div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">Description</div>
        <textarea
          aria-label="Description"
          placeholder="Add a description…"
          value={body ?? ''}
          disabled={body === null}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => void commitBody()}
          className="mb-4 block min-h-[96px] w-full resize-y rounded-lg border border-[var(--n-200)] px-2.5 py-2 text-[13px] leading-5 text-[var(--n-700)] outline-none focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]"
        />
      </div>
      <footer className="flex items-center gap-3 border-t border-[var(--n-100)] px-4 py-2.5 [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
        <span>Created {entry.createdAt.slice(0, 10)}</span>
        <span>Modified {entry.modifiedAt.slice(0, 10)}</span>
      </footer>
    </aside>
  );
}
