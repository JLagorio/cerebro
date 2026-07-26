import { useEffect, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { DocProperties } from '@/detail/DocProperties';
import { DocOutline } from '@/editor/DocOutline';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import type { Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';

export type DocSelection = Extract<Selection, { kind: 'doc' }>;

/**
 * Full-page markdown document (M2 Task 10). The title is the doc's H1,
 * edited inside the editor — each save rescans, so the header and every
 * other surface pick the new title up from the scanner.
 */
export function DocPage({ selection }: { selection: DocSelection }) {
  const entry = useEntry(selection.path);
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const schema = useSchema();
  // Task 16: properties panel, collapsible and persisted.
  const propsCollapsed = useUiStore((s) => s.docPropsCollapsed);
  const setPropsCollapsed = useUiStore((s) => s.setDocPropsCollapsed);

  // Task 15: the outline needs the live editor and the scroll container.
  const [editor, setEditor] = useState<BlockNoteEditor | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setEditor(null); // the keyed editor remounts per doc; wait for onReady
  }, [selection.path]);

  if (entry === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="file-x"
          title="This page no longer exists"
          description="It may have been renamed or moved to the Trash."
          action={
            <Button variant="secondary" onClick={() => navigate({ kind: 'home' })}>
              Go home
            </Button>
          }
        />
      </div>
    );
  }

  const project =
    entry.project === null ? null : (entries.find((e) => e.path === entry.project) ?? null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="doc-page">
      <div className="flex flex-none items-center gap-1.5 px-5 pb-2 pt-3.5">
        {project !== null && (
          <>
            <button
              type="button"
              onClick={() => navigate({ kind: 'project', path: project.path })}
              className="inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[13px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
            >
              <Icon name="folder-kanban" size={13} />
              {project.title}
            </button>
            <Icon name="chevron-right" size={13} color="var(--n-400)" />
          </>
        )}
        <Icon name="file-text" size={15} color="var(--n-600)" />
        <h1
          data-testid="doc-title"
          className="m-0 min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[-0.005em]"
        >
          {entry.title}
        </h1>
        <span className="flex-1" />
        <IconButton
          icon="panel-right"
          label={propsCollapsed ? 'Show properties' : 'Hide properties'}
          size="sm"
          onClick={() => setPropsCollapsed(!propsCollapsed)}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div ref={scrollRef} className="h-full overflow-y-auto px-5 pb-6">
            <NoteBodyEditor path={entry.path} onReady={({ editor: e }) => setEditor(e)} />
          </div>
          {editor !== null && <DocOutline editor={editor} scrollRef={scrollRef} />}
        </div>
        {!propsCollapsed && <DocProperties entry={entry} schema={schema} />}
      </div>
    </div>
  );
}
