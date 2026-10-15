import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { canPickFiles, importAttachment, inspectDropped, pickFiles } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useOpenPath } from '@/app/useOpenPath';
import { FileLightbox } from '@/components/FileLightbox';
import { FileThumb } from '@/components/FileThumb';
import { kindFor } from '@/engine/fileKinds';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useOsDropZone } from '@/hooks/useOsDropZone';
import { droppedReason } from '@/engine/osDrop';

/**
 * The Files property (M16.13c).
 *
 * It was a text input placeholdered "Path or URL" — you typed a path to a file
 * the app had never seen, and nothing checked that it existed, would still
 * exist, or was reachable from anywhere but the machine you typed it on.
 * Notion's equivalent uploads; a files-first app cannot upload anywhere, so
 * the honest equivalent is COPY INTO THE VAULT: pick a file, the backend
 * copies it under `attachments/`, and the frontmatter stores the
 * vault-relative path. The vault stays portable, which an absolute
 * `/Users/me/Downloads/…` never was.
 *
 * The typed-path route stays, because it is the only one a browser build has
 * and the only one that can hold a URL. It is a second menu item now rather
 * than the only door.
 *
 */

const isUrl = (v: string) => /^(https?|mailto):/i.test(v);

export function FilesField({
  values,
  label,
  onChange,
  ownerKey = label,
}: {
  values: string[];
  /** Humanized property name, for the accessible names of the controls. */
  label: string;
  /** Page and field identity, even when the next record has identical values. */
  ownerKey?: string;
  onChange: (next: string[]) => void;
}) {
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copying = useRef(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const openPath = useOpenPath();
  const images = values.filter((path) => !isUrl(path) && kindFor(path).kind === 'image');
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  const scope = JSON.stringify([vaultPath, ownerKey, values]);
  const capture = useVaultActionGuard(scope);
  useLayoutEffect(() => {
    const clear = () => {
      copying.current = false;
      setMenu(false);
      setDraft(null);
      setBusy(false);
      setLightbox(null);
    };
    clear();
    return useVaultStore.subscribe((next, previous) => {
      if (next.vaultPath !== previous.vaultPath) clear();
    });
  }, [scope]);
  const osDrop = useOsDropZone('files-field', async (paths) => {
    if (vaultPath === null || copying.current) return;
    const current = capture();
    copying.current = true;
    setBusy(true);
    try {
      const inspected = await inspectDropped(paths);
      const added: string[] = [];
      const skipped: string[] = [];
      for (const file of inspected) {
        if (!current()) return;
        const why = droppedReason(file);
        if (why !== null) {
          skipped.push(`${file.name} (${why})`);
          continue;
        }
        added.push((await importAttachment(vaultPath, file.path)).path);
      }
      if (!current()) return;
      if (added.length > 0)
        onChange([...values, ...added.filter((path) => !values.includes(path))]);
      if (skipped.length > 0) toast(`Skipped ${skipped.join(', ')}`);
    } finally {
      if (current()) {
        copying.current = false;
        setBusy(false);
      }
    }
  });

  const upload = () => {
    setMenu(false);
    if (vaultPath === null || copying.current) return;
    const current = capture();
    copying.current = true;
    void (async () => {
      setBusy(true);
      try {
        const picked = await pickFiles();
        if (!current() || picked.length === 0) return;
        // Sequential so references retain the person's selection order.
        const added: string[] = [];
        for (const source of picked) {
          if (!current()) return;
          added.push((await importAttachment(vaultPath, source)).path);
        }
        if (!current()) return;
        onChange([...values, ...added.filter((a) => !values.includes(a))]);
      } catch (e) {
        // The store-layer invariant: never throw at a call site, say what
        // happened. A failed copy leaves the field exactly as it was.
        if (current())
          toast(`Couldn't add the file — ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (current()) {
          copying.current = false;
          setBusy(false);
        }
      }
    })();
  };

  const commitDraft = () => {
    const typed = draft?.trim() ?? '';
    if (typed !== '' && !values.includes(typed)) onChange([...values, typed]);
    setDraft(null);
  };

  return (
    <span
      {...osDrop.zoneProps}
      className={`flex min-w-0 flex-wrap items-center gap-1 ${osDrop.over ? 'rounded-md outline outline-2 outline-cortex-500' : ''}`}
    >
      {values.map((f) => (
        <span
          key={f}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-n-50 px-1.5 py-px text-xs text-n-700"
        >
          {!isUrl(f) && ['image', 'pdf'].includes(kindFor(f).kind) ? (
            <FileThumb
              rootId="0"
              path={f}
              size={128}
              compact
              className="inline-flex h-4 w-4 shrink-0"
            />
          ) : (
            <Icon name={isUrl(f) ? 'link' : 'paperclip'} size={11} color="var(--n-500)" />
          )}
          {isUrl(f) ? (
            <a
              href={f}
              target="_blank"
              rel="noreferrer"
              className="truncate text-cortex-700 underline decoration-n-300"
            >
              {f}
            </a>
          ) : (
            // title, not a tooltip: the full path is the useful detail and a
            // chip is small enough that the name alone is often ambiguous.
            <button
              type="button"
              className="truncate border-0 bg-transparent p-0 text-inherit"
              data-testid="files-chip"
              title={f}
              aria-label={`Open ${f.split('/').at(-1) ?? f}`}
              onClick={() => (images.includes(f) ? setLightbox(f) : openPath(f))}
            >
              {f.split('/').pop()}
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${f}`}
            onClick={() => onChange(values.filter((x) => x !== f))}
            className="border-0 bg-transparent p-0 text-n-400 hover:text-danger-600"
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      {draft !== null ? (
        <input
          autoFocus
          aria-label={`Add file to ${label}`}
          placeholder="Path or URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setDraft(null);
          }}
          className="h-[22px] w-36 rounded-md border border-cortex-500 px-1.5 text-xs outline-none"
        />
      ) : (
        <button
          ref={addRef}
          type="button"
          aria-label={`Add file to ${label}`}
          // The one control a gesture on the whole CELL means. The chips'
          // `Remove <file>` buttons render before this one, so resolving by
          // DOM order made Enter — and, once a table cell forwarded clicks,
          // the pointer too — delete an attachment.
          data-cell-primary
          disabled={busy}
          onClick={() => setMenu((v) => !v)}
          className="rounded-md border-0 bg-transparent px-1 py-px text-xs text-n-400 hover:bg-n-50 hover:text-n-700 disabled:opacity-50"
        >
          {busy ? 'Adding…' : '+ Add'}
        </button>
      )}
      {menu && (
        <Popover anchorRef={addRef} role="menu" ariaLabel="Add file" onClose={() => setMenu(false)}>
          <MenuSurface width={214}>
            {canPickFiles() ? (
              <MenuItem
                label="Upload a file…"
                icon="upload"
                testId="files-upload"
                disabled={vaultPath === null}
                onSelect={upload}
              />
            ) : (
              // Disabled rather than hidden: the menu should say the same
              // thing everywhere, and "this is a desktop feature" is more
              // useful than an item that silently is not there.
              <Tooltip label="Copying into the vault needs the desktop app">
                <span>
                  <MenuItem label="Upload a file…" icon="upload" disabled onSelect={() => {}} />
                </span>
              </Tooltip>
            )}
            <MenuItem
              label="Link a path or URL…"
              icon="link"
              testId="files-link"
              onSelect={() => {
                setMenu(false);
                setDraft('');
              }}
            />
          </MenuSurface>
        </Popover>
      )}
      {lightbox !== null && images.includes(lightbox) && (
        <FileLightbox
          key={lightbox}
          paths={images}
          initialIndex={images.indexOf(lightbox)}
          onClose={() => setLightbox(null)}
        />
      )}
    </span>
  );
}
