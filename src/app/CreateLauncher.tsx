import { useEffect, useId, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Keycaps } from '@/components/ui/Keycaps';
import { Button } from '@/components/ui/Button';
import { nameMatches } from '@/lib/nameRank';
import { captureNote } from '@/lib/capture';
import { createLibraryItem, libraryItemPlace } from '@/library/libraryActions';
import { NewPrototypeDialog } from '@/pages/StudioPage';
import { createContext, useLauncherStore, type CreateFlow } from '@/stores/launcherStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { availableRows, groupRows, recentRows, type CreateRow } from './createCatalog';
import { CollectionDialog } from './CollectionDialog';
import { NewDocDialog, NewRecordDialog } from './CreateMenu';
import { CsvImportDialog } from './CsvImportDialog';
import { NewTypeDialog } from './TypeDialogs';
import { addSubPage } from './pageActions';
import { useOpenPath } from './useOpenPath';
import { NewBoardDialog } from '@/whiteboard/NewBoardDialog';
import { ImportSheetDialog } from '@/sheet/ImportSheetDialog';

/** Mounted once beside the palette, including when the sidebar is collapsed. */
export function CreateLauncher() {
  const open = useLauncherStore((s) => s.open);
  const flow = useLauncherStore((s) => s.flow);
  const vault = useVaultStore((s) => s.vaultPath);
  useEffect(() => {
    if (flow !== null && flow.vault !== vault) useLauncherStore.getState().endFlow();
  }, [flow, vault]);
  return (
    <>
      {open && <LauncherBody />}
      {flow !== null && flow.vault === vault && <CreateFlowHost flow={flow} />}
    </>
  );
}

function LauncherBody() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const vault = useVaultStore((s) => s.vaultPath);
  // These subscriptions keep availability and the landing sentence current.
  useVaultStore((s) => s.entries);
  useVaultStore((s) => s.status);
  useVaultStore((s) => s.entriesVault);
  useNavStore((s) => s.selection);
  useUiStore((s) => s.inboxEnabled);
  const recents = useLauncherStore((s) => s.recents);
  const close = useLauncherStore((s) => s.closeLauncher);
  const start = useLauncherStore((s) => s.startCreate);
  const ctx = createContext();
  const rows = availableRows(ctx).filter((row) => nameMatches(query, [row.label, row.tagline]));
  const groups = groupRows(rows);
  const recent = recentRows(rows, vault === null ? [] : (recents[vault] ?? []));
  const listed = [...recent, ...rows];
  const index = Math.min(active, listed.length - 1);
  const selected = listed[index];
  const id = useId();
  useEffect(() => {
    document.getElementById(`${id}-${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, index]);
  const option = (row: CreateRow, at: number) => (
    <button
      key={`${at}-${row.id}`}
      type="button"
      id={`${id}-${at}`}
      role="option"
      aria-selected={index === at}
      data-create-id={row.id}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setActive(at)}
      onClick={() => start(row.id)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${index === at ? 'bg-n-100 text-n-900' : 'text-n-700 hover:bg-n-50'}`}
    >
      <Icon name={row.icon} size={16} color="var(--n-500)" />
      {row.label}
    </button>
  );
  return (
    <Dialog open title="New" width={640} onClose={close}>
      <div data-testid="create-launcher">
        <Input
          role="combobox"
          ariaLabel="What would you like to create?"
          ariaExpanded
          ariaAutocomplete="list"
          ariaControls={`${id}-list`}
          ariaActivedescendant={selected ? `${id}-${index}` : undefined}
          autoFocus
          placeholder="Find something to create…"
          value={query}
          width="100%"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (listed.length > 0)
                setActive(
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + listed.length) % listed.length,
                );
            } else if (event.key === 'Enter' && selected) {
              event.preventDefault();
              start(selected.id);
            }
          }}
        />
        <div className="mt-3 grid min-h-64 grid-cols-[1fr_1fr] gap-4">
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="Create"
            className="max-h-[52vh] overflow-auto pr-2"
          >
            {recent.length > 0 && (
              <div role="group" aria-label="Recent">
                <p className="mb-1 mt-2 text-metadata text-(--text-meta)">Recent</p>
                {recent.map(option)}
              </div>
            )}
            {groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label}>
                <p className="mb-1 mt-3 text-metadata text-(--text-meta)">{group.label}</p>
                {group.rows.map((row) => option(row, recent.length + rows.indexOf(row)))}
              </div>
            ))}
            {listed.length === 0 && (
              <p className="py-4 text-sm text-(--text-meta)">Nothing matches.</p>
            )}
          </div>
          <div data-testid="create-details" className="border-l border-n-100 pl-4 pt-3">
            {selected && (
              <>
                <Icon name={selected.icon} size={24} color="var(--n-500)" />
                <h3 className="mb-2 mt-3 text-section-title font-semibold">{selected.label}</h3>
                <p className="text-ui text-n-600">{selected.tagline}</p>
                <p data-testid="create-lands" className="my-4 text-ui text-(--text-meta)">
                  {selected.lands(ctx)}
                </p>
                <Keycaps command={`create.${selected.id}`} />
                <div className="mt-5">
                  <Button testId="create-run" onClick={() => start(selected.id)}>
                    Create {selected.label.toLowerCase()}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function CreateFlowHost({ flow }: { flow: CreateFlow }) {
  const end = useLauncherStore((s) => s.endFlow);
  const openPath = useOpenPath();
  useEffect(() => {
    if (useLauncherStore.getState().flow !== flow) return;
    const immediate = ['sub-page', 'agent', 'skill', 'template', 'capture'].includes(flow.id);
    if (!immediate) return;
    // Consume before awaiting: StrictMode must never create twice.
    end();
    void (async () => {
      try {
        const current = () => useVaultStore.getState().vaultPath === flow.vault;
        if (!current()) return;
        if (flow.id === 'sub-page' && flow.page !== null) {
          const path = await addSubPage(flow.page, 'Untitled');
          if (path !== null && current()) openPath(path);
        } else if (flow.id === 'agent' || flow.id === 'skill' || flow.id === 'template') {
          const path = await createLibraryItem(flow.id);
          if (path !== null && current())
            useNavStore.getState().navigate(libraryItemPlace(flow.id, path));
        } else if (flow.id === 'capture') {
          const path = await captureNote();
          if (current()) {
            useUiStore.getState().setInboxSelectedPath(path);
            useNavStore.getState().navigate({ kind: 'inbox' });
          }
        }
      } catch {
        useUiStore.getState().toast("Couldn't create that item");
      }
    })();
  }, [flow, end, openPath]);
  switch (flow.id) {
    case 'page':
      return <NewDocDialog onClose={end} />;
    case 'sheet':
      return <NewDocDialog sheet onClose={end} />;
    case 'sheet-file':
      return <ImportSheetDialog onClose={end} />;
    case 'whiteboard':
      return <NewBoardDialog onClose={end} />;
    case 'record':
      return <NewRecordDialog onClose={end} />;
    case 'database':
      return <NewTypeDialog onClose={end} />;
    case 'database-csv':
      return <CsvImportDialog onClose={end} />;
    case 'collection':
      return <CollectionDialog state={{ mode: 'new' }} onClose={end} />;
    case 'prototype':
      return <NewPrototypeDialog onClose={end} />;
    default:
      return null;
  }
}
