import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { deleteNote, readNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import type { Entry } from '@/engine/types';
import { DETAIL_WIDTH_DEFAULT, DETAIL_WIDTH_MAX, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The record panel's header actions (M16.11).
 *
 * The header was a type icon, a key, a collection crumb and a close button —
 * everything else Notion's peek header offers had no equivalent anywhere in
 * the app, so a record you were reading could not be duplicated, deleted,
 * linked to, or stepped past without going back to the list.
 *
 * Notion's peek header, verbatim: close · open in full page · peek mode (Side
 * peek / Center peek / Full page) · previous/next · Share · page info ·
 * favourite · overflow.
 *
 * Three are deliberately absent.
 *
 * - **Open in full page** would break M12.1's locked rule: a record opens in
 *   this panel and a doc opens full-page in Docs, and the two surfaces never
 *   blend. There is no full page to open.
 * - **Peek mode** is a choice between three ways of floating over the
 *   content. This panel is a COLUMN (M11) — it shrinks the canvas rather than
 *   covering it — so the equivalent question is how wide, and the answer is
 *   the widen toggle plus the drag handle that was already there.
 * - **Share** has no subsystem: the vault is on disk and there is nobody to
 *   share with. `Copy link` is the part that does mean something here, and it
 *   copies the wikilink the rest of the app understands.
 */
export function DetailHeaderActions({ entry }: { entry: Entry }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const createItem = useVaultStore((s) => s.createItem);
  const entries = useVaultStore((s) => s.entries);
  const toast = useUiStore((s) => s.toast);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const openDetail = useUiStore((s) => s.openDetail);
  const stepDetail = useUiStore((s) => s.stepDetail);
  const siblings = useUiStore((s) => s.detailSiblings);
  const width = useUiStore((s) => s.detailWidth);
  const setWidth = useUiStore((s) => s.setDetailWidth);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);

  const at = siblings.indexOf(entry.path);
  const hasPrev = at > 0;
  const hasNext = at !== -1 && at < siblings.length - 1;
  const wide = width >= DETAIL_WIDTH_MAX;

  const copy = (text: string, what: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${what} copied`);
      } catch {
        // Clipboard access is a permission, not a certainty — a silent
        // failure here reads as "the button does nothing".
        toast(`Couldn't copy ${what.toLowerCase()}`);
      }
    })();
  };

  const duplicate = () => {
    void (async () => {
      if (vaultPath === null) return;
      const title = `${entry.title} copy`;
      try {
        const body = await readNote(vaultPath, entry.path);
        // `key` is not copied: it identifies the record (LNC-4), and two
        // records answering to one key is worse than a copy with none.
        const { key: _key, ...props } = entry.properties;
        const frontmatter: Record<string, unknown> = { ...props };
        if (entry.type !== null) frontmatter.type = entry.type;
        // Relationships arrive bracket-stripped from the scanner; disk wants
        // them back as wikilinks.
        for (const [name, targets] of Object.entries(entry.relationships)) {
          frontmatter[name] = targets.map((t) => `[[${t}]]`);
        }
        const created = await createItem({
          folder: entry.path.slice(0, Math.max(entry.path.lastIndexOf('/'), 0)),
          slug: slugify(title) || 'copy',
          frontmatter,
          body,
        });
        openDetail(created);
        toast(`Duplicated as "${title}"`);
      } catch {
        toast("Couldn't duplicate this record");
      }
    })();
  };

  const remove = () => {
    setConfirmDelete(false);
    void (async () => {
      if (vaultPath === null) return;
      // Step to a neighbour BEFORE the record goes, so deleting from a list
      // leaves you in the list rather than on nothing.
      //
      // `at` is -1 when the open record is not in this view's list at all — it
      // was opened from a backlink, a dossier or search while some other list
      // filled `detailSiblings`. There is no neighbour to land on, so the panel
      // closes. Without the guard `siblings[-1 + 1]` is `siblings[0]`, and the
      // delete would teleport the user to an unrelated record.
      const next = at === -1 ? null : (siblings[at + 1] ?? siblings[at - 1] ?? null);
      try {
        await deleteNote(vaultPath, entry.path);
      } catch {
        toast("Couldn't delete this record");
        return;
      }
      if (next === null) closeDetail();
      else openDetail(next);
      try {
        await rescan();
      } catch {
        toast("Couldn't refresh vault");
      }
    })();
  };

  const links = entries.filter((e) => e.outgoingLinks.includes(entry.path)).length;

  return (
    <>
      {siblings.length > 1 && (
        <span className="flex items-center">
          <IconButton
            icon="chevron-up"
            label={hasPrev ? 'Previous record' : 'No previous record'}
            size="sm"
            disabled={!hasPrev}
            onClick={() => stepDetail(-1)}
          />
          <IconButton
            icon="chevron-down"
            label={hasNext ? 'Next record' : 'No next record'}
            size="sm"
            disabled={!hasNext}
            onClick={() => stepDetail(1)}
          />
          {at !== -1 && (
            <Tooltip label="Position in this view">
              <span className="px-1 text-[11px] tabular-nums text-[var(--n-400)]">
                {at + 1}/{siblings.length}
              </span>
            </Tooltip>
          )}
        </span>
      )}
      <IconButton
        icon={wide ? 'chevrons-right' : 'chevrons-left'}
        label={wide ? 'Narrow the panel' : 'Widen the panel'}
        size="sm"
        onClick={() => setWidth(wide ? DETAIL_WIDTH_DEFAULT : DETAIL_WIDTH_MAX)}
      />
      <span className="relative inline-flex">
        <IconButton
          ref={menuRef}
          icon="ellipsis"
          label="Record actions"
          size="sm"
          onClick={() => setMenuOpen((v) => !v)}
        />
        {menuOpen && (
          <Popover
            anchorRef={menuRef}
            onClose={() => setMenuOpen(false)}
            role="menu"
            ariaLabel="Record actions"
            trapFocus
          >
            <MenuSurface width={216}>
              <MenuItem
                icon="link"
                label="Copy link"
                testId="record-copy-link"
                onSelect={() => {
                  setMenuOpen(false);
                  copy(`[[${entry.title}]]`, 'Link');
                }}
              />
              <MenuItem
                icon="file-text"
                label="Copy path"
                testId="record-copy-path"
                onSelect={() => {
                  setMenuOpen(false);
                  copy(entry.path, 'Path');
                }}
              />
              <MenuItem
                icon="copy"
                label="Duplicate"
                testId="record-duplicate"
                onSelect={() => {
                  setMenuOpen(false);
                  duplicate();
                }}
              />
              <MenuSeparator />
              <MenuItem
                icon="trash-2"
                label="Delete"
                danger
                testId="record-delete"
                onSelect={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              />
            </MenuSurface>
          </Popover>
        )}
      </span>
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
          <p className="m-0 text-[13px] leading-relaxed text-[var(--n-600)]">
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
