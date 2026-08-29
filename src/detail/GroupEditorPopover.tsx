import React, { useMemo, useRef, useState } from 'react';
import { normalizeFieldName, RESERVED, type TypeLayoutDraft } from '@/app/typeActions';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { MenuBack, MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { AddPropertyPanel, type RelationConfig } from '@/detail/AddPropertyPanel';
import { draftRoster, overlayVisibility } from '@/detail/LayoutCanvas';
import { VISIBILITIES } from '@/detail/PropertyMenu';
import { addGroup, moveField, removeGroup, renameGroup } from '@/engine/layoutEdit';
import { resolveLayout } from '@/engine/layout';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import type { FieldDef, FieldKind, TypeDef } from '@/engine/types';

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
  onOpenGroup,
}: {
  /** 'heading' | 'rest' | a group id — the shell that opened this. */
  container: string;
  typeDef: TypeDef;
  draft: TypeLayoutDraft;
  /** The draft's one door (LayoutEditorDialog's `update`). */
  update: (patch: Partial<TypeLayoutDraft>) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Retargets the editor onto another group — Add section's hand-off. */
  onOpenGroup: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [step, setStep] = useState<'main' | 'add' | 'create'>('main');
  /** The staging guard's inline refusal — a form refuses in place, never by
   * toast (the store-layer toast contract is for vault writes; nothing here
   * writes). */
  const [stageError, setStageError] = useState<string | null>(null);

  const group = draft.layout.groups.find((g) => g.id === container);
  const isGroup = group !== undefined;
  const title = isGroup ? group.name : container === 'heading' ? 'Heading' : 'Properties';

  // The DRAFT roster with the DRAFT's visibility overlaid — the same lens the
  // canvas renders through, minus its fold: the editor never folds a row. The
  // un-overlaid roster survives for the staging guard, which needs to know
  // what the DOC says apart from what the draft stages over it.
  const roster = draftRoster(typeDef.fields, draft.added);
  const overlaid = overlayVisibility(roster, draft.visibility);
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

  const stageVisibility = (name: string, value: FieldDef['visibility'] | null) => {
    // null for the default (PropertyMenu's idiom): Apply DELETES the doc's
    // visibility key, so a Type doc never carries the absence of an opinion.
    // But when the doc never HELD an opinion — the RESOLVED def's visibility
    // is absent or show — a staged null would be a phantom edit: deepEqual's
    // exact-key-set rule would dirty the draft over a hide→show round-trip
    // that changed nothing, and Cancel would ask to discard a no-op. The key
    // deletes instead (the discard sweep's idiom); null survives only where
    // Apply has a real clear to write.
    if (value === null && (roster.find((f) => f.name === name)?.visibility ?? 'show') === 'show') {
      const { [name]: _dropped, ...visibility } = draft.visibility;
      update({ visibility });
      return;
    }
    update({ visibility: { ...draft.visibility, [name]: value ?? null } });
  };

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

  // Where a landed field goes: after the container's last CONFIG slot. Rest
  // ignores the index (it orders by roster declaration).
  const appendIndex = isGroup ? group.fields.length : draft.layout.heading.length;

  /** Add-existing: the field is already on the type — placement is the whole
   * edit, so pulling it in IS one moveField. */
  const pullIn = (name: string) => {
    update({ layout: moveField(draft.layout, name, { container, index: appendIndex }) });
    setStep('main');
  };

  /** Create-new: stage the FieldDef-shaped addition AND place it here. */
  const stageNew = (rawName: string, kind: FieldKind, relation?: RelationConfig) => {
    // Normalized at STAGING time so preview and Apply agree on the name
    // (Task 4 review obligation): the canvas previews what Apply will write —
    // one value, computed once, here.
    const name = normalizeFieldName(rawName);
    // applyTypeLayout's own refusals, mirrored BEFORE staging: same reasons,
    // rendered inline where the typo is, instead of a toast at Apply time.
    if (name === '') {
      setStageError('A property needs a name');
      return;
    }
    if (RESERVED.has(name)) {
      setStageError(`“${name}” is a reserved key and can't be a property`);
      return;
    }
    // Normalized compare over existing AND staged names: the panel's own
    // trim+lowercase guard cannot see that "Story  Points" collides with
    // `story_points`, but Apply's normalized compare would.
    if (overlaid.some((f) => normalizeFieldName(f.name) === name)) {
      setStageError(`“${name}” is already a property here`);
      return;
    }
    if (relation?.reciprocalName !== undefined) {
      // The reciprocal declares a field on the TARGET type — a second doc the
      // one-write atomic Apply can never carry. Refusing outright beats
      // silently staging half of what was asked for.
      setStageError(
        'A two-way relation also writes the other type, which Apply cannot stage — add it from a record’s + Add property, or switch off “Add related property”.',
      );
      return;
    }
    const config =
      relation === undefined
        ? undefined
        : // FieldDef members (the typeActions.ts contract on `added`): Apply
          // spreads this under {name, kind} and serializes via fieldToSpec.
          { target: relation.target, ...(relation.limit === 1 ? { limit: 1 as const } : {}) };
    update({
      added: [...draft.added, { name, kind, ...(config === undefined ? {} : { config }) }],
      layout: moveField(draft.layout, name, { container, index: appendIndex }),
    });
    setStageError(null);
    setStep('main');
  };

  /** Discard a staged addition. The sweep is threefold (review obligation):
   * the `added` entry, every layout pointer — Apply must never persist a
   * dead pointer — and any staged eye, which names a field Apply would just
   * drop. A full sweep leaves the draft exactly as the add found it. */
  const discardNew = (name: string) => {
    const { [name]: _dropped, ...visibility } = draft.visibility;
    update({
      added: draft.added.filter((a) => a.name !== name),
      layout: moveField(draft.layout, name, { container: 'rest', index: 0 }),
      visibility,
    });
    setMenuFor(null);
  };

  const addSection = () => {
    const minted = addGroup(
      draft.layout,
      draft.layout.groups.map((g) => g.id),
    );
    update({ layout: minted.layout });
    // Open the fresh group's editor — addGroup reports its id for exactly
    // this hand-off; the canvas remounts us keyed by the new container.
    onOpenGroup(minted.id);
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

  // The fields NOT in this container — other containers' plus rest's — for
  // the Add-existing drill-in: on the type already, so pulling one in is
  // purely a placement edit.
  const candidates = overlaid.filter((f) => !fields.some((c) => c.name === f.name));

  const mainStep = (
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
        <MenuSeparator />
        <MenuItem
          icon="plus"
          label="Add a property"
          submenu
          testId="group-editor-add"
          onSelect={() => setStep('add')}
        />
        {!isGroup && (
          // Rest/heading footers only (the plan's §3.3 call): a group's own
          // editor arranges the group; sections are the page's to grow.
          <MenuItem
            icon="square-plus"
            label="Add section"
            testId="group-editor-add-section"
            onSelect={addSection}
          />
        )}
        {isGroup && (
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
        )}
      </div>
    </MenuSurface>
  );

  const addStep = (
    <MenuSurface width={264} autoFocus={false}>
      <div data-testid="group-editor-add-list" className="flex min-w-0 flex-col">
        <MenuBack title="Add a property" onBack={() => setStep('main')} />
        {candidates.map((f) => (
          <MenuItem
            key={f.name}
            icon={kindMeta(f.kind).icon}
            label={humanize(f.name)}
            testId={`group-editor-pull-${f.name}`}
            onSelect={() => pullIn(f.name)}
          />
        ))}
        {candidates.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-n-400">
            Every property is already in this section.
          </div>
        )}
        <MenuSeparator />
        <MenuItem
          icon="plus"
          label="Create new"
          submenu
          testId="group-editor-create-new"
          onSelect={() => {
            setStageError(null);
            setStep('create');
          }}
        />
      </div>
    </MenuSurface>
  );

  const createStep = (
    // The panel's INLINE variant on purpose (the view-settings precedent): a
    // page inside a popover that already exists — an anchored second surface
    // here would point at the first one's trigger. Its own dismiss layer
    // stacks above ours, so Escape steps back one surface at a time.
    <MenuSurface width={300} className="p-2" autoFocus={false}>
      <MenuBack
        title="New property"
        onBack={() => {
          setStageError(null);
          setStep('add');
        }}
      />
      <AddPropertyPanel
        existingNames={overlaid.map((f) => f.name)}
        ownerType={typeDef.name}
        onAdd={stageNew}
        onCancel={() => {
          setStageError(null);
          setStep('add');
        }}
      />
      {stageError !== null && (
        <p role="alert" className="m-0 px-1.5 pt-1 text-2xs leading-[1.35] text-danger-600">
          {stageError}
        </p>
      )}
    </MenuSurface>
  );

  return (
    <Popover
      anchorRef={anchorRef}
      onClose={onClose}
      role="dialog"
      ariaLabel={`Edit ${title}`}
      trapFocus
    >
      {/* autoFocus off on every surface (PropertyMenu's drill-in idiom): the
          Popover's trap already hands focus to the first control once placed,
          and a drill-in must not steal focus mid-flow. */}
      {step === 'main' ? mainStep : step === 'add' ? addStep : createStep}
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
            {draft.added.some((a) => a.name === menuFor) && (
              // Added-only: a STAGED field can simply un-happen before Apply
              // — a declared one goes through Delete property's confirm on
              // the record panel, where the blast radius is named.
              <>
                <MenuSeparator />
                <MenuItem
                  icon="trash-2"
                  label="Discard new property"
                  danger
                  testId="group-editor-discard-new"
                  onSelect={() => discardNew(menuFor)}
                />
              </>
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
