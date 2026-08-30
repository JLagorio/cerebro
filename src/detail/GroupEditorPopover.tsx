import React, { useMemo, useRef, useState } from 'react';
import { normalizeFieldName, RESERVED, type TypeLayoutDraft } from '@/app/typeActions';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { MenuBack, MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { AddPropertyPanel, type RelationConfig } from '@/detail/AddPropertyPanel';
import { draftRoster, overlayVisibility, stageNewSection } from '@/detail/LayoutCanvas';
import { VISIBILITIES } from '@/detail/PropertyMenu';
import { moveField, removeGroup, renameGroup, setGroupTab } from '@/engine/layoutEdit';
import { resolveLayout } from '@/engine/layout';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { layoutTabScope, tabBearsProperties } from '@/engine/typeCatalog';
import type { FieldDef, FieldKind, TypeDef } from '@/engine/types';
import { useSortableList } from '@/hooks/useSortableList';

/**
 * The editor behind a canvas shell (M45.3, spec §3.3): click a container and
 * this popover stages everything about its fields — visibility (the eye and
 * the ⋯'s three-state vocabulary), placement (Move to heading / Move to
 * page), order (the row grips, within the container), the group's name, and
 * the section's existence. Every edit walks through the draft's one `update`
 * door; nothing here touches the vault.
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
  activeTab,
  update,
  anchorRef,
  onClose,
  onOpenGroup,
}: {
  /** 'heading' | 'rest' | a group id — the shell that opened this. */
  container: string;
  typeDef: TypeDef;
  draft: TypeLayoutDraft;
  /** The tab the canvas is standing on (M45.6), or null for simple
   * structure. The footer's "Add section" stages onto it, so the two doors
   * onto one editor cannot mean different things. */
  activeTab: string | null;
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
  const [step, setStep] = useState<'main' | 'add' | 'create' | 'tab'>('main');
  /** The staging guard's inline refusal — a form refuses in place, never by
   * toast (the store-layer toast contract is for vault writes; nothing here
   * writes). */
  const [stageError, setStageError] = useState<string | null>(null);

  const group = draft.layout.groups.find((g) => g.id === container);
  const isGroup = group !== undefined;
  const title = isGroup ? group.name : container === 'heading' ? 'Heading' : 'Properties';

  // The DRAFT roster with the DRAFT's visibility overlaid — the canvas's own
  // lens minus its fold, because the editor never folds a row. The
  // un-overlaid roster survives for the staging guard, which needs to know
  // what the DOC says apart from what the draft stages over it.
  //
  // TAB-BLIND on purpose, where the canvas resolves for its active tab
  // (M45.6): this resolve answers "which fields does THIS container hold",
  // and a container holds the same fields whichever tab it shows on. Only
  // `showsOnTab` below asks the other question, and it passes a scope.
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

  // Reordering is real only where the CONFIG owns the order and the rows on
  // screen ARE the rows in the data (M45.5 Task 4): `rest` is derived and
  // roster-ordered — moveField ignores its index — and a filtered list's
  // visible slots are not the data's slots (useSortableList's own rule).
  const canReorder = container !== 'rest' && q === '';
  // The container's CONFIG order, which a reorder rewrites. `rest` has none.
  const configFields = container === 'heading' ? draft.layout.heading : (group?.fields ?? []);

  /**
   * A row released at `to` — the index it takes in the resulting order.
   * useSortableList has ALREADY applied the past-source decrement that
   * `handleLayoutDragEnd` has to apply by hand (dnd-kit reports a raw visual
   * gap; this primitive reports a post-removal index), so a second decrement
   * here would carry the row one slot too far.
   *
   * What still has to be converted is the index SPACE: a config may point at
   * a field the roster no longer declares, and resolveLayout drops that row
   * while the config keeps its slot — so the Nth row is not the Nth slot. The
   * landing is named by its NEIGHBOUR instead: the row that will follow it,
   * read back as that neighbour's own config index. Nothing following means
   * the config end.
   *
   * That divergence is NARROW but real: seedDraft resolves the config and
   * maps the defs back to names, so no draft ever STARTS with a dead pointer,
   * and discardNew sweeps the one it could otherwise create. It opens when
   * the Type doc changes under an open dialog — the draft is seeded once, the
   * roster is re-read every render — which is the case the popover suite
   * drives, and the same divergence the canvas handles with
   * `cfg.fields.indexOf`.
   *
   * A landing that resolves to the row's own slot never reaches moveField:
   * useSortableList drops a `to === from` release before calling back. (The
   * editor would return the same reference there anyway, so `update` would
   * stage an unchanged layout rather than a wrong one.)
   */
  const reorderRow = (name: string, to: number) => {
    const follower = shown.map((f) => f.name).filter((n) => n !== name)[to];
    const without = configFields.filter((n) => n !== name);
    // A follower is one of this container's own resolved rows, so its config
    // index is real; `undefined` is the only other case, and it means the end.
    const index = follower === undefined ? without.length : without.indexOf(follower);
    update({ layout: moveField(draft.layout, name, { container, index }) });
  };

  const sortable = useSortableList({
    ids: shown.map((f) => f.name),
    labelFor: humanize,
    disabled: !canReorder,
    onReorder: reorderRow,
  });

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

  /** The tabs a section can be moved ONTO (M45.6). `sections` and `view` tabs
   * ARE their content and render no property stack — a section moved onto one
   * would be invisible — so they are not offered, and the drill-in says so
   * rather than leaving the absence to be inferred. The refusal is not a
   * guarantee, and cannot be: a tab's content kind changes AFTER the
   * assignment, which is why the engine falls a stranded section back onto
   * the default tab instead of trusting this door. */
  const tabTargets = draft.tabs.filter(tabBearsProperties);

  /** Does this section declare no tab at all? That is a HOME — the default
   * tab — and the list marks it as one, so an untabbed section shows exactly
   * one check (on "Untabbed") instead of two (there, and on whichever tab it
   * resolves to). */
  const untabbed = isGroup && group.tab === undefined;

  /** Does this section show on that tab? Asked of `resolveLayout` itself
   * rather than re-derived from `group.tab`: a section whose tab stopped
   * bearing properties falls back onto the default one, and that fallback is
   * the engine's — a second copy here would be free to drift from the first.
   * Untabbed is excluded because "Untabbed" is its own entry above: the
   * question this answers is which tab the section NAMES, not where an
   * unnamed one lands. */
  const showsOnTab = (tabId: string) =>
    isGroup &&
    !untabbed &&
    resolveLayout(draft.layout, overlaid, layoutTabScope(draft.tabs, tabId)).groups.some(
      (g) => g.id === container,
    );

  /** Move the section to a tab, or back to untabbed with `null` (M45.6).
   * Clearing is the ONLY way back: `addGroup` mints a section already
   * wearing the active tab, so without this entry "untabbed" would be a
   * shape the parser reads and no door could ever write. */
  const moveToTab = (target: string | null) => {
    // Picking the home it already has stages nothing. `setGroupTab` no-ops
    // the id it already wears, but not untabbed → the default tab's id: that
    // WRITES a key meaning what absent already meant, dirtying the draft —
    // and asking to discard on close — over a move that moves nothing.
    const home =
      target === null ? untabbed : untabbed && layoutTabScope(draft.tabs, target).isDefault;
    if (!home) update({ layout: setGroupTab(draft.layout, container, target) });
    // Either way this editor goes: it is anchored to a shell on the tab the
    // canvas stands on, and the section may have just left it.
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
   * dead pointer — and any staged eye: an eye on a KEPT addition lands in
   * the write (M45.3), so one left aimed at a discarded name would be a
   * dead delta Apply silently drops. A full sweep leaves the draft exactly
   * as the add found it. */
  const discardNew = (name: string) => {
    const { [name]: _dropped, ...visibility } = draft.visibility;
    update({
      added: draft.added.filter((a) => a.name !== name),
      layout: moveField(draft.layout, name, { container: 'rest', index: 0 }),
      visibility,
    });
    setMenuFor(null);
  };

  // The staging lives with the canvas's + button (M45.5 Task 3): two doors,
  // one editor. `onOpenGroup` is the hand-off addGroup reports its id for —
  // the canvas remounts us keyed by the new container.
  const addSection = () => stageNewSection(draft, update, onOpenGroup, activeTab);

  /** CAN a section be added where we are standing? The canvas hides its +
   * on a `sections` or `view` tab; this footer has to answer the same, and
   * for a sharper reason than symmetry — the HEADING shell renders on every
   * tab, so this editor is reachable from a tab that holds no properties,
   * and an Add section there would mint a group on a tab that cannot show
   * it. The engine strands it onto the default tab (visible, by doctrine),
   * so the press would land a "New group" on a tab the user was not looking
   * at while this popover unmounted under them. Two doors, one answer.
   * Simple structure has no tabs and always can. */
  const activeBearsSections =
    draft.tabs.length === 0 || draft.tabs.some((t) => t.id === activeTab && tabBearsProperties(t));

  const eyeRow = (f: FieldDef, i: number) => {
    const label = humanize(f.name);
    const hidden = (f.visibility ?? 'show') === 'hide';
    const grip = sortable.gripProps(f.name, i);
    return (
      <div
        key={f.name}
        data-testid="group-editor-row"
        data-property={f.name}
        style={sortable.dropIndicator(i)}
        className={[
          'group/row flex items-center gap-1.5 rounded-sm px-1 py-[2px] hover:bg-n-25',
          sortable.dragging === f.name ? 'opacity-40' : '',
        ].join(' ')}
      >
        {/* No grip where a reorder would be a promise the model cannot keep
            (M45.5 Task 4). `rest` is DERIVED: its order is the roster's
            declaration order and moveField ignores the index it is given
            there, so a drag could move the icon and nothing else. The
            affordance is absent because the capability is. (A filtered list
            is the other case — see `canReorder`.) */}
        {canReorder ? (
          <span
            {...grip}
            onKeyDown={(e) => {
              grip.onKeyDown(e);
              // Both arrows belong to the GRIP while it holds focus, whether
              // or not they moved anything. MenuSurface would otherwise take
              // them for roving focus — a span role=button matches none of
              // its FOCUSABLE selectors, so `at` is -1 and it jumps to the
              // top of the menu. preventDefault too, because the hook returns
              // early at the list's ends without calling it, and the arrow
              // would fall through to scrolling the popover.
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            data-testid="group-editor-grip"
            // Opacity, not `hidden`: a hidden grip leaves the tab order, and
            // arrow-key reordering is the primitive's whole point.
            className="flex h-4 w-3 flex-none cursor-grab touch-none items-center justify-center rounded-xs text-n-400 opacity-0 hover:text-n-700 focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <Icon name="grip-vertical" size={12} />
          </span>
        ) : (
          // The cell is the layout; the grip is only its occupant
          // (OptionListEditor's rule). Held empty where no grip renders, so a
          // row does not jump 18px left the moment the search box filters —
          // and so rest's rows line up with every other container's.
          <span className="h-4 w-3 flex-none" />
        )}
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
        {/* The rows get their OWN container: useSortableList measures
            `containerRef.current.children` as the rows, and the empty-state
            lines and the footer menu below are siblings — dropping the ref on
            the outer column would make a MenuItem a droppable slot
            (OptionListEditor's lesson, verbatim). */}
        <div
          ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
          data-testid="group-editor-rows"
          className="flex flex-col"
        >
          {shown.map((f, i) => eyeRow(f, i))}
        </div>
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
        {!isGroup && activeBearsSections && (
          // Rest/heading footers only (the plan's §3.3 call): a group's own
          // editor arranges the group; sections are the page's to grow.
          <MenuItem
            icon="square-plus"
            label="Add section"
            testId="group-editor-add-section"
            onSelect={addSection}
          />
        )}
        {isGroup && draft.tabs.length > 0 && (
          // Groups only, and only when there are tabs to move BETWEEN: the
          // heading is global by decision (it renders above the strip) and
          // rest is the roster's derived remainder — neither is a section, so
          // neither belongs to a tab.
          <MenuItem
            icon="panel-top"
            label="Move to tab…"
            submenu
            testId="group-editor-move-tab"
            onSelect={() => setStep('tab')}
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

  const tabStep = (
    <MenuSurface width={264} autoFocus={false}>
      <div data-testid="group-editor-tab-list" className="flex min-w-0 flex-col">
        <MenuBack title="Move to tab" onBack={() => setStep('main')} />
        {/* FIRST, and its own entry rather than an absence: absent `tab:` is
            a real placement — the default tab — and it is the shape every
            pre-M45.6 vault wears. Without a door that WRITES it, the model
            would be readable and unwritable, because the + mints a section
            already wearing the tab it was pressed on. The label carries
            where that lands, so the list never has to check two rows. */}
        <MenuItem
          icon="minus"
          label="Untabbed (default tab)"
          checked={untabbed}
          testId="group-editor-untabbed"
          onSelect={() => moveToTab(null)}
        />
        <MenuSeparator />
        {tabTargets.map((t) => (
          <MenuItem
            key={t.id}
            icon={t.icon ?? 'panel-top'}
            label={t.name}
            checked={showsOnTab(t.id)}
            testId={`group-editor-tab-${t.id}`}
            onSelect={() => moveToTab(t.id)}
          />
        ))}
        {tabTargets.length < draft.tabs.length && (
          // The reason, in place. A tab missing from a list of tabs is an
          // absence the user has to explain to themselves otherwise.
          <div className="px-2 py-1.5 text-xs text-n-400">
            Tabs that hold their own content — free text or a view — can’t hold sections.
          </div>
        )}
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
      {step === 'main'
        ? mainStep
        : step === 'add'
          ? addStep
          : step === 'tab'
            ? tabStep
            : createStep}
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
 * nothing-changed blur never dirties the draft — but the LOCAL draft has to
 * follow the ruling: an emptied box snaps back to the standing name on blur
 * (M45.3), and a committed name shows the trimmed form the commit stored. */
function SectionNameInput({ name, onCommit }: { name: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(name);
  return (
    <Input
      size="sm"
      ariaLabel="Section name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        onCommit(draft);
        setDraft(trimmed === '' ? name : trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      width="100%"
    />
  );
}
