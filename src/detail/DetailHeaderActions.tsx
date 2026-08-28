import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { FavoriteStar } from '@/app/FavoriteStar';
import { IconButton } from '@/components/ui/IconButton';
import { MenuBack, MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { Switch } from '@/components/ui/Switch';
import { Tooltip } from '@/components/ui/Tooltip';
import { deleteNote } from '@/lib/ipc';
import { duplicateRecord } from '@/app/recordActions';
import { setTypeDisplay } from '@/app/typeActions';
import { DISPLAY_DEFAULTS, type Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { DETAIL_WIDTH_DEFAULT, DETAIL_WIDTH_MAX, useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

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
 * Two are deliberately absent. (Open in full page was the third — M38.2 made
 * it real: a record can be a full page now, so the peek is a default rather
 * than a wall.)
 *
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
  const entries = useVaultStore((s) => s.entries);
  const toast = useUiStore((s) => s.toast);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const openDetail = useUiStore((s) => s.openDetail);
  const stepDetail = useUiStore((s) => s.stepDetail);
  const navigate = useNavStore((s) => s.navigate);
  const siblings = useUiStore((s) => s.detailSiblings);
  const width = useUiStore((s) => s.detailWidth);
  const setWidth = useUiStore((s) => s.setDetailWidth);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStep, setMenuStep] = useState<'menu' | 'display'>('menu');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);

  const schema = useSchema();
  const typeDef = entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  const display = typeDef?.display ?? DISPLAY_DEFAULTS;
  const listing = typeDef !== null ? { name: typeDef.name, docPath: null } : null;

  const at = siblings.indexOf(entry.path);
  const hasPrev = at > 0;
  const hasNext = at !== -1 && at < siblings.length - 1;
  const wide = width >= DETAIL_WIDTH_MAX;

  // Closes the whole menu, not just the drilled-in step — a step left behind
  // would reopen the panel on "Customize display" instead of the top level.
  const closeMenu = () => {
    setMenuOpen(false);
    setMenuStep('menu');
  };

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
      // M20.5: the write itself moved to `app/recordActions`, so the bulk bar
      // can duplicate too rather than making you open a record first.
      const created = await duplicateRecord(entry);
      if (created === null) return;
      openDetail(created);
      toast(`Duplicated as "${entry.title} copy"`);
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
              <span className="px-1 text-2xs tabular-nums text-n-400">
                {at + 1}/{siblings.length}
              </span>
            </Tooltip>
          )}
        </span>
      )}
      <FavoriteStar path={entry.path} />
      {/* M38.2 — the peek stopped being a wall. Same page, full canvas: the
          record's properties and body render in the page canvas, and the
          panel closes because the same record twice is one time too many. */}
      <IconButton
        icon="maximize-2"
        label="Open in full page"
        size="sm"
        onClick={() => {
          navigate({ kind: 'doc', path: entry.path });
          closeDetail();
        }}
      />
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
          onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        />
        {menuOpen && (
          <Popover
            anchorRef={menuRef}
            onClose={closeMenu}
            onEscape={menuStep === 'display' ? () => setMenuStep('menu') : undefined}
            role="menu"
            ariaLabel={menuStep === 'display' ? 'Customize display' : 'Record actions'}
            trapFocus
          >
            {menuStep === 'display' && listing !== null ? (
              // autoFocus off: this surface is arrived at by drilling in, not
              // by opening fresh — focus should stay where the user put it,
              // same as PropertyMenu's edit step (PropertyMenu.tsx:104-106).
              <MenuSurface width={260} className="p-2" autoFocus={false}>
                <MenuBack title="Customize display" onBack={() => setMenuStep('menu')} />
                <div className="flex flex-col gap-2 px-1 pt-1">
                  <Switch
                    checked={display.showEmpty}
                    onChange={(on) => void setTypeDisplay(listing, { ...display, showEmpty: on })}
                    label="Show empty properties"
                  />
                  <Switch
                    checked={display.showFile}
                    onChange={(on) => void setTypeDisplay(listing, { ...display, showFile: on })}
                    label="Show file path"
                  />
                  <Switch
                    checked={display.showBody}
                    onChange={(on) => void setTypeDisplay(listing, { ...display, showBody: on })}
                    label="Show description"
                  />
                  <p className="m-0 border-t border-n-100 pt-2 text-2xs leading-[15px] text-n-400">
                    Applies to every {typeDef?.name} record. Hide individual properties from each
                    property&rsquo;s own menu.
                  </p>
                  <button
                    type="button"
                    data-testid="display-reset"
                    onClick={() => void setTypeDisplay(listing, DISPLAY_DEFAULTS)}
                    className="self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
                  >
                    Reset to defaults
                  </button>
                </div>
              </MenuSurface>
            ) : (
              <MenuSurface width={216}>
                <MenuItem
                  icon="link"
                  label="Copy link"
                  testId="record-copy-link"
                  onSelect={() => {
                    closeMenu();
                    copy(`[[${entry.title}]]`, 'Link');
                  }}
                />
                <MenuItem
                  icon="file-text"
                  label="Copy path"
                  testId="record-copy-path"
                  onSelect={() => {
                    closeMenu();
                    copy(entry.path, 'Path');
                  }}
                />
                <MenuItem
                  icon="copy"
                  label="Duplicate"
                  testId="record-duplicate"
                  onSelect={() => {
                    closeMenu();
                    duplicate();
                  }}
                />
                {listing !== null && (
                  <MenuItem
                    icon="sliders-horizontal"
                    label="Customize display"
                    submenu
                    testId="record-customize-display"
                    // Drills in without closing the menu — the Popover stays
                    // mounted and this component's own `menuStep` decides
                    // which MenuSurface it renders, same as PropertyMenu.
                    onSelect={() => setMenuStep('display')}
                  />
                )}
                <MenuSeparator />
                <MenuItem
                  icon="trash-2"
                  label="Delete"
                  danger
                  testId="record-delete"
                  onSelect={() => {
                    closeMenu();
                    setConfirmDelete(true);
                  }}
                />
              </MenuSurface>
            )}
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
          <p className="m-0 text-sm leading-relaxed text-n-600">
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
