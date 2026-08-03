import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { copyText, deleteRecord, duplicateRecord } from '@/views/recordActions';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A row's overflow menu (M16.21).
 *
 * Every list row was a bare div: the only thing you could do to a record from
 * a list was open it, and everything else — copy a link to it, duplicate it,
 * delete it — meant opening it first and using the panel's header. Notion's
 * list rows carry this menu, and so does every row surface people arrive
 * from.
 *
 * The operations live in `recordActions` rather than here, because the record
 * panel's header (`DetailHeaderActions`) performs the same three and one of
 * the two copies should eventually be the only one.
 */
export function RecordRowMenu({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const createItem = useVaultStore((s) => s.createItem);
  const entries = useVaultStore((s) => s.entries);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const openDetail = useUiStore((s) => s.openDetail);
  const detailPath = useUiStore((s) => s.detailPath);
  const closeDetail = useUiStore((s) => s.closeDetail);

  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const deps = { vaultPath, createItem, rescan, toast };
  const links = entries.filter((e) => e.outgoingLinks.includes(entry.path)).length;

  const remove = () => {
    setConfirmDelete(false);
    void (async () => {
      const gone = await deleteRecord(entry, deps);
      // The panel would otherwise sit on a file that no longer exists.
      if (gone && detailPath === entry.path) closeDetail();
    })();
  };

  return (
    <>
      <IconButton
        ref={buttonRef}
        icon="ellipsis"
        label={`Actions for ${entry.title}`}
        size="sm"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <Popover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel={`Actions for ${entry.title}`}
          trapFocus
        >
          <MenuSurface width={216}>
            <MenuItem
              icon="panel-right-open"
              label="Open"
              testId="row-open"
              onSelect={() => {
                setOpen(false);
                onOpen();
              }}
            />
            <MenuItem
              icon="link"
              label="Copy link"
              testId="row-copy-link"
              onSelect={() => {
                setOpen(false);
                void copyText(`[[${entry.title}]]`, 'Link', toast);
              }}
            />
            <MenuItem
              icon="file-text"
              label="Copy path"
              testId="row-copy-path"
              onSelect={() => {
                setOpen(false);
                void copyText(entry.path, 'Path', toast);
              }}
            />
            <MenuItem
              icon="copy"
              label="Duplicate"
              testId="row-duplicate"
              onSelect={() => {
                setOpen(false);
                void (async () => {
                  const created = await duplicateRecord(entry, deps);
                  if (created !== null) openDetail(created);
                })();
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon="trash-2"
              label="Delete"
              danger
              testId="row-delete"
              onSelect={() => {
                setOpen(false);
                setConfirmDelete(true);
              }}
            />
          </MenuSurface>
        </Popover>
      )}
      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={`Delete "${entry.title}"?`}
          width={420}
          footerNote="Recoverable from git history, not from the app."
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(false) }}
          primaryAction={{ label: 'Delete', onClick: remove }}
        >
          <p className="m-0 text-[13px] leading-relaxed text-n-600">
            The file leaves the vault.
            {links > 0
              ? ` ${links === 1 ? 'One record links' : `${links} records link`} here, and those links will point at nothing.`
              : ' Nothing links to it.'}
          </p>
        </Dialog>
      )}
    </>
  );
}
