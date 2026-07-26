import { useEffect, useRef, useState } from 'react';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import { spliceTitleIntoBlocks } from '@/editor/markdown';
import { setNoteTitle } from '@/lib/ipc';
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
  // Task 12: the body lives in the BlockNote editor (NoteBodyEditor owns
  // load/save). The handle is only needed for the rename splice below.
  const editorRef = useRef<CerebroEditor | null>(null);

  useEffect(() => {
    setTitle(entry?.title ?? '');
    // The keyed NoteBodyEditor remounts on path change; drop the stale
    // handle until the new editor reports ready.
    editorRef.current = null;
  }, [entry?.path, entry?.title]);

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
    // Failed rename: toast and revert the input to disk truth (16a guard
    // discipline). The rescan is caught separately — after a successful
    // rename the disk already holds the new name, so a refresh failure must
    // not claim the rename failed.
    try {
      await setNoteTitle(vaultPath, entry.path, trimmed);
    } catch {
      toast("Couldn't rename item");
      setTitle(entry.title);
      return;
    }
    // M1.x stale-body-after-rename, block edition: splice the new H1 into
    // the LIVE editor so its next debounced save writes the renamed title
    // (and keeps any dirty description edits).
    if (editorRef.current !== null) spliceTitleIntoBlocks(editorRef.current, trimmed);
    try {
      await rescan();
    } catch {
      toast("Couldn't refresh vault");
    }
  };

  return (
    <aside
      data-testid="detail-panel"
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
          data-testid="detail-title"
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
        {/* Task 12: rich markdown editor replaces the raw textarea. Keyed by
            path so switching items reloads cleanly. */}
        <NoteBodyEditor
          key={entry.path}
          path={entry.path}
          compact
          onReady={({ editor }) => {
            editorRef.current = editor;
          }}
        />
      </div>
      <footer className="flex items-center gap-3 border-t border-[var(--n-100)] px-4 py-2.5 [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
        <span>Created {entry.createdAt.slice(0, 10)}</span>
        <span>Modified {entry.modifiedAt.slice(0, 10)}</span>
      </footer>
    </aside>
  );
}
