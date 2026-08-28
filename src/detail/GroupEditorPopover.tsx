import React, { useMemo, useRef, useState } from 'react';
import type { TypeLayoutDraft } from '@/app/typeActions';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { draftRoster, overlayVisibility } from '@/detail/LayoutCanvas';
import { VISIBILITIES } from '@/detail/PropertyMenu';
import { moveField, removeGroup, renameGroup } from '@/engine/layoutEdit';
import { resolveLayout } from '@/engine/layout';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import type { FieldDef, TypeDef } from '@/engine/types';

/**
 * The editor behind a canvas shell (M45.3, spec §3.3): click a container and
 * this popover stages everything about its fields — visibility (the eye and
 * the ⋯'s three-state vocabulary), placement (Move to heading / Move to
 * page), the group's name, and the section's existence. Every edit walks
 * through the draft's one `update` door; nothing here touches the vault.
 *
 * The rows list EVERY field of the container, hidden included — the canvas
 * folds what the page folds, and the editor is where hidden things stay
 * visible (the Task 4 review ruling). That asymmetry is the point: the
 * canvas previews, the editor governs.
 */
export function GroupEditorPopover({
  container,
  typeDef,
  draft,
  update,
  anchorRef,
  onClose,
}: {
  /** 'heading' | 'rest' | a group id — the shell that opened this. */
  container: string;
  typeDef: TypeDef;
  draft: TypeLayoutDraft;
  /** The draft's one door (LayoutEditorDialog's `update`). */
  update: (patch: Partial<TypeLayoutDraft>) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const group = draft.layout.groups.find((g) => g.id === container);
  const isGroup = group !== undefined;
  const title = isGroup ? group.name : container === 'heading' ? 'Heading' : 'Properties';

  // The DRAFT roster with the DRAFT's visibility overlaid — the same lens the
  // canvas renders through, minus its fold: the editor never folds a row.
  const overlaid = overlayVisibility(draftRoster(typeDef.fields, draft.added), draft.visibility);
  const resolved = resolveLayout(draft.layout, overlaid);
  const fields =
    container === 'heading'
      ? resolved.heading
      : container === 'rest'
        ? resolved.rest
        : (resolved.groups.find((g) => g.id === container)?.fields ?? []);

  const q = query.trim().toLowerCase();
  const shown =
    q === ''
      ? fields
      : fields.filter(
          (f) => humanize(f.name).toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
        );

  // One ⋯ menu at a time, anchored to the row button that opened it. The map
  // is read lazily so the anchor resolves AFTER the row has (re)rendered.
  const menuButtons = useRef(new Map<string, HTMLButtonElement>());
  const menuAnchorRef = useMemo(
    () => ({
      get current() {
        return menuFor === null ? null : (menuButtons.current.get(menuFor) ?? null);
      },
    }),
    [menuFor],
  );
  const menuDef = menuFor === null ? null : (overlaid.find((f) => f.name === menuFor) ?? null);

  const stageVisibility = (name: string, value: FieldDef['visibility'] | null) =>
    // null for the default (PropertyMenu's idiom): Apply DELETES the doc's
    // visibility key, so a Type doc never carries the absence of an opinion.
    update({ visibility: { ...draft.visibility, [name]: value ?? null } });

  const moveTo = (name: string, to: 'heading' | 'rest') =>
    update({
      layout: moveField(draft.layout, name, {
        container: to,
        // Append: past the last heading slot. Rest ignores the index — it
        // orders by roster declaration, not by config.
        index: draft.layout.heading.length,
      }),
    });

  const deleteSection = () => {
    update({ layout: removeGroup(draft.layout, container) });
    // The container left the draft, so its editor has nothing to stand on.
    onClose();
  };

  const eyeRow = (f: FieldDef) => {
    const label = humanize(f.name);
    const hidden = (f.visibility ?? 'show') === 'hide';
    return (
      <div
        key={f.name}
        data-testid="group-editor-row"
        data-property={f.name}
        className="flex items-center gap-1.5 rounded-sm px-1 py-[2px] hover:bg-n-25"
      >
        <Icon name={kindMeta(f.kind).icon} size={13} color="var(--n-400)" />
        <span className="min-w-0 flex-1 truncate text-sm text-n-800">{label}</span>
        <IconButton
          size="sm"
          icon={hidden ? 'eye-off' : 'eye'}
          label={hidden ? `Show ${label}` : `Hide ${label}`}
          // The eye cycles show ↔ hide (locked Decision); hide_when_empty is
          // reachable only through the ⋯'s full vocabulary, and shows there.
          onClick={() => stageVisibility(f.name, hidden ? null : 'hide')}
        />
        <IconButton
          size="sm"
          icon="more-horizontal"
          label={`${label} options`}
          ref={(el) => {
            if (el === null) menuButtons.current.delete(f.name);
            else menuButtons.current.set(f.name, el);
          }}
          onClick={() => setMenuFor(f.name)}
        />
      </div>
    );
  };

  return (
    <Popover
      anchorRef={anchorRef}
      onClose={onClose}
      role="dialog"
      ariaLabel={`Edit ${title}`}
      trapFocus
    >
      {/* autoFocus off (PropertyMenu's drill-in idiom): the Popover's trap
          already hands focus to the first control once placed. */}
      <MenuSurface width={264} autoFocus={false}>
        <div data-testid="group-editor" className="flex min-w-0 flex-col">
          {isGroup ? (
            <div className="px-1 pb-1 pt-0.5">
              <SectionNameInput
                name={group.name}
                onCommit={(next) => update({ layout: renameGroup(draft.layout, container, next) })}
              />
            </div>
          ) : (
            // Heading and rest are structural, not named — static titles.
            <div className="px-2 pb-1 pt-0.5 text-sm font-semibold text-n-900">{title}</div>
          )}
          <div className="px-1 pb-1">
            <Input
              size="sm"
              ariaLabel="Search properties"
              placeholder="Search properties…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              width="100%"
            />
          </div>
          {shown.map(eyeRow)}
          {fields.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-n-400">No properties yet</div>
          )}
          {fields.length > 0 && shown.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-n-400">
              No property matches “{query.trim()}”.
            </div>
          )}
          {isGroup && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="trash-2"
                label="Delete section"
                danger
                testId="group-editor-delete-section"
                onSelect={() => {
                  // A populated group asks first — its fields fall to rest,
                  // and the fall should not be a surprise. An empty one has
                  // nothing to re-home, so the click IS the delete.
                  if (group.fields.length > 0) setConfirmDelete(true);
                  else deleteSection();
                }}
              />
            </>
          )}
        </div>
      </MenuSurface>
      {menuFor !== null && menuDef !== null && (
        <Popover
          anchorRef={menuAnchorRef}
          onClose={() => setMenuFor(null)}
          role="menu"
          ariaLabel={`${humanize(menuFor)} options`}
          trapFocus
        >
          <MenuSurface width={216}>
            {VISIBILITIES.map((v) => (
              <MenuItem
                key={v.value}
                icon={v.icon}
                label={v.label}
                checked={(menuDef.visibility ?? 'show') === v.value}
                testId={`group-editor-visibility-${v.value}`}
                onSelect={() => {
                  stageVisibility(menuFor, v.value === 'show' ? null : v.value);
                  setMenuFor(null);
                }}
              />
            ))}
            <MenuSeparator />
            {container !== 'heading' && (
              <MenuItem
                icon="arrow-up-to-line"
                label="Move to heading"
                testId="group-editor-move-heading"
                onSelect={() => {
                  moveTo(menuFor, 'heading');
                  setMenuFor(null);
                }}
              />
            )}
            {/* Rest rows get no "Move to page" — they are already there.
                Notion's wording ("Move to page") per the §3.4 screenshot. */}
            {container !== 'rest' && (
              <MenuItem
                icon="arrow-down-to-line"
                label="Move to page"
                testId="group-editor-move-page"
                onSelect={() => {
                  moveTo(menuFor, 'rest');
                  setMenuFor(null);
                }}
              />
            )}
          </MenuSurface>
        </Popover>
      )}
      {confirmDelete && isGroup && (
        // Inside the popover's panel on purpose (PropertyMenu's confirm
        // rationale): the dismiss listener reads a press on the dialog as a
        // press inside the menu, and the layer stack still hands the dialog
        // its own Escape.
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={`Delete ${title}?`}
          width={420}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(false) }}
          primaryAction={{
            label: 'Delete section',
            onClick: () => {
              setConfirmDelete(false);
              deleteSection();
            },
          }}
        >
          <p className="m-0 text-sm leading-relaxed text-n-600">
            {group.fields.length === 1
              ? 'Its property moves'
              : `Its ${group.fields.length} properties move`}{' '}
            to the page body — nothing is deleted from the type.
          </p>
        </Dialog>
      )}
    </Popover>
  );
}

/** The group's rename box — RenameTab's draft idiom: local draft, commit on
 * blur (Enter blurs). No inner Escape handler: the window-capture dismiss
 * closes the popover FIRST, and unmounting never fires blur, so Escape
 * abandons by construction (PropertyMenu's rename rationale, verbatim).
 * `renameGroup` no-ops the empty and unchanged commits, so the common
 * nothing-changed blur never dirties the draft. */
function SectionNameInput({ name, onCommit }: { name: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(name);
  return (
    <Input
      size="sm"
      ariaLabel="Section name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      width="100%"
    />
  );
}
