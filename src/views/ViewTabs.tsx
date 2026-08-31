import React, { useEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Grip } from '@/components/ui/Grip';
import { Icon } from '@/components/ui/Icon';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { useSortableList } from '@/hooks/useSortableList';
import type { ViewDefinition, ViewType } from '@/engine/types';
import { layoutLabel } from '@/engine/views';
import { VIEW_KINDS, viewKind } from '@/views/viewKinds';

/**
 * A List's view tabs (M11).
 *
 * This replaces the segmented layout pills that used to sit in the toolbar.
 * They were the same buttons on every surface, and pressing one REPLACED the
 * view you had configured — so "look at this as a board" cost you the table's
 * columns, and there was no way to keep both.
 *
 * A tab is a saved way of looking: it owns its layout, filters, sort, grouping
 * and columns. Which layout a tab uses is therefore chosen once, when the tab is
 * created, and changed from the tab's own menu — not from a control that sits
 * permanently in the toolbar inviting you to overwrite your configuration.
 */

export interface ViewTabsProps {
  views: ViewDefinition[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string, type: ViewType) => void;
  onRename: (id: string, name: string) => void;
  onChangeLayout: (id: string, type: ViewType) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** Move a tab to a new position (M16.26). Omitted leaves the strip fixed. */
  onReorder?: (id: string, toIndex: number) => void;
  /** Set or clear a tab's own icon (M16.26). Omitted hides the menu item. */
  onChangeIcon?: (id: string, icon: string | null) => void;
  /** Opens the full settings panel for a view. Absent on surfaces that have
   * no settings aside (M12.3: the type screen) — the menu item is omitted. */
  onConfigure?: (id: string) => void;
  /** M12.8: the view-control icon cluster, pinned to the row's right edge
   * outside the scrollable tab strip (Notion's toolbar-in-the-tab-row). */
  trailing?: React.ReactNode;
}

export function ViewTabs({
  views,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onChangeLayout,
  onDuplicate,
  onDelete,
  onReorder,
  onChangeIcon,
  onConfigure,
  trailing,
}: ViewTabsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [layoutFor, setLayoutFor] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // A ViewDefinition carries the tab's filters, its column set with widths and
  // order, its sort chain, its grouping chain and its chip style. Deleting it
  // was two clicks from an ordinary tab click, directly under "Duplicate", and
  // unrecoverable — the app has no undo.
  const [deleting, setDeleting] = useState<ViewDefinition | null>(null);

  // Horizontal, because the tabs are. The primitive's arrow keys follow the
  // axis, so a keyboard user moves a tab with Left/Right rather than being
  // told to use Up/Down on a row.
  const sortable = useSortableList({
    ids: views.map((v) => v.id),
    axis: 'x',
    disabled: onReorder === undefined,
    labelFor: (id) => views.find((v) => v.id === id)?.name ?? id,
    onReorder: (id, to) => onReorder?.(id, to),
  });

  // Roving tabindex, the same shape as the SegmentedControl primitive: a
  // tablist is ONE tab stop and arrows move within it (M16.34). The strip
  // claimed `role="tablist"` while leaving every tab its own tab stop and
  // ignoring arrow keys — the contract announced, none of it honoured. Falls
  // back to the first tab so the strip stays reachable if `activeId` matches
  // no view.
  const activeIndex = views.findIndex((v) => v.id === activeId);
  const focusIndex = activeIndex >= 0 ? activeIndex : 0;
  const stripRef = useRef<HTMLDivElement>(null);

  const onTabsKeyDown = (e: React.KeyboardEvent) => {
    // Only the tabs themselves rove. The reorder grip beside each tab takes
    // Left/Right to MOVE a tab, the rename input takes them to move a caret,
    // and the pickers below mount through portals whose events still bubble
    // here in the React tree — none of them are asking to switch tabs.
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return;
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key) || views.length === 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? views.length - 1
          : focusIndex + (e.key === 'ArrowRight' ? 1 : -1);
    const i = ((next % views.length) + views.length) % views.length;
    const target = views[i];
    if (target.id !== activeId) onSelect(target.id);
    // Selection follows focus, so the newly active tab is the tab stop — and
    // the tab that was pressed is about to stop being one.
    const tabs = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    // Matched on the id rather than indexed, because a tab being renamed is an
    // input rather than a button and would shift every index after it.
    tabs.find((t) => t.dataset.testid === `view-tab-${target.id}`)?.focus();
  };

  const menuItems = (view: ViewDefinition): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { icon: 'pencil', label: 'Rename', onSelect: () => setRenaming(view.id) },
      ...(onChangeIcon !== undefined
        ? [
            {
              icon: view.icon ?? viewKind(view.presentation.type).icon,
              label: 'Change icon…',
              onSelect: () => setIconFor(view.id),
            },
          ]
        : []),
      {
        icon: viewKind(view.presentation.type).icon,
        label: 'Change layout…',
        onSelect: () => setLayoutFor(view.id),
      },
      ...(onConfigure !== undefined
        ? [{ icon: 'settings-2', label: 'View settings…', onSelect: () => onConfigure(view.id) }]
        : []),
      { icon: 'copy', label: 'Duplicate', onSelect: () => onDuplicate(view.id) },
    ];
    // The last view is the only way to look at the List; removing it would
    // leave a database with no surface. Delete the List instead.
    if (views.length > 1) {
      items.push({
        icon: 'trash-2',
        label: 'Delete view',
        danger: true,
        onSelect: () => setDeleting(view),
      });
    }
    return items;
  };

  return (
    <div className="flex min-w-0 flex-none items-end border-b border-n-200 px-5">
      {deleting !== null && (
        <Dialog
          open
          onClose={() => setDeleting(null)}
          title={`Delete "${deleting.name}"?`}
          width={420}
          primaryAction={{
            label: 'Delete view',
            onClick: () => {
              const id = deleting.id;
              setDeleting(null);
              onDelete(id);
            },
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setDeleting(null) }}
        >
          <p className="m-0 text-sm text-n-600">
            This removes the tab and everything it holds — its{' '}
            {layoutLabel(deleting.presentation.type).toLowerCase()} layout, filters, sort, grouping
            and column arrangement. The records stay where they are.
            {deleting.presentation.type === 'whiteboard' && (
              <>
                {' '}
                {/* The one thing the sentence above got wrong (M29.53): a
                    whiteboard's drawing lives in its own `.mmd` file, and
                    deleting the tab drops the pointer to it without touching
                    the file — MEASURED, the orphan was still on disk with both
                    record nodes in it, and re-creating a view of the same name
                    minted a second file beside it. Keeping the drawing is the
                    right call; saying so is the missing half. */}
                Its drawing stays too, as a file under this list&rsquo;s whiteboards folder.
              </>
            )}
          </p>
        </Dialog>
      )}
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Views"
        data-testid="view-tabs"
        onKeyDown={onTabsKeyDown}
        // Scrolls rather than wraps: a tab row that reflows onto a second line
        // moves every other tab under the cursor as the window narrows. The
        // trailing icons sit OUTSIDE this strip so they cannot scroll away.
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* The tabs get their own box, so the sortable measures ONLY them: its
            slot maths reads `container.children`, and the "+ View" button
            below would otherwise count as a drop slot you could never mean.
            It used to be `display: contents`, which has no box at all — a drag
            freezes this element to its measured size and positions the tabs
            against it, and neither is possible without one (M46.2).
            `flex-none` keeps the group at its natural width so it overflows
            into the strip's scroller exactly as the loose tabs did. */}
        <div
          ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
          data-testid="view-tab-slots"
          className="flex flex-none items-end gap-0.5"
          style={sortable.containerStyle}
        >
          {views.map((view, index) => {
            const active = view.id === activeId;
            const kind = viewKind(view.presentation.type);
            if (renaming === view.id) {
              return (
                <RenameTab
                  key={view.id}
                  name={view.name}
                  icon={view.icon ?? kind.icon}
                  onCommit={(name) => {
                    setRenaming(null);
                    if (name !== '' && name !== view.name) onRename(view.id, name);
                  }}
                />
              );
            }
            return (
              <div
                key={view.id}
                className="group relative flex-none"
                style={sortable.rowStyle(index)}
              >
                {/* The grip sits in the tab's own left padding, which is dead
                  space — an appended handle would shove every tab sideways
                  the moment the pointer arrived, and one overlaying the icon
                  would have to be aligned by hand against a button whose
                  vertical padding is asymmetric.

                  That padding is 10px, which is why this takes the `tab`
                  kind rather than the 18 x 24 row slot (M46.2 Task 6): the
                  row grip transposed for a horizontal list, keeping its
                  glyph, ink, cursor and reveal, giving up only the width the
                  surface has no room for. */}
                {onReorder !== undefined && (
                  <Tooltip label="Drag to reorder">
                    <Grip
                      kind="tab"
                      {...sortable.gripProps(view.id, index)}
                      // Opacity, not `hidden`: a hidden grip is out of the tab
                      // order, and Left/Right reordering is the point of the
                      // primitive underneath it.
                      className="absolute inset-y-1 left-0 z-10 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    />
                  </Tooltip>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={index === focusIndex ? 0 : -1}
                  data-testid={`view-tab-${view.id}`}
                  onClick={(e) => {
                    if (!active) {
                      onSelect(view.id);
                      return;
                    }
                    // Anchor the menu to the tab that was pressed, taken from the
                    // event rather than looked up — the tab IS the event target.
                    const box = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.left, y: box.bottom, id: view.id });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, id: view.id });
                  }}
                  className={[
                    'inline-flex max-w-[220px] items-center gap-1.5 whitespace-nowrap border-0 border-b-2 bg-transparent px-2.5 pb-2 pt-1.5 text-sm',
                    active
                      ? 'border-cortex-500 font-semibold text-n-900'
                      : 'border-transparent font-normal text-n-500 hover:text-n-800',
                  ].join(' ')}
                  style={{ borderBottomStyle: 'solid' }}
                >
                  <Icon name={view.icon ?? kind.icon} size={13} />
                  <span className="min-w-0 truncate">{view.name}</span>
                  {/* The caret appears on the tab you are standing on, because
                  that is the only one whose settings you can act on without
                  first leaving where you are. */}
                  {active && <Icon name="chevron-down" size={11} color="var(--n-400)" />}
                </button>
                {layoutFor === view.id && (
                  <LayoutPicker
                    current={view.presentation.type}
                    onPick={(type) => {
                      setLayoutFor(null);
                      if (type !== view.presentation.type) onChangeLayout(view.id, type);
                    }}
                    onClose={() => setLayoutFor(null)}
                  />
                )}
                {iconFor === view.id && onChangeIcon !== undefined && (
                  <ViewIconPicker
                    current={view.icon}
                    layoutIcon={kind.icon}
                    layoutLabel={kind.label}
                    onPick={(icon) => {
                      setIconFor(null);
                      onChangeIcon(view.id, icon);
                    }}
                    onClose={() => setIconFor(null)}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="relative flex-none">
          <button
            type="button"
            data-testid="new-view"
            aria-label="New view"
            onClick={() => setCreating(true)}
            className="mb-1 ml-1 inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
          >
            <Icon name="plus" size={13} />
            View
          </button>
          {creating && (
            <NewViewForm
              taken={views.map((v) => v.name)}
              onCancel={() => setCreating(false)}
              onCreate={(name, type) => {
                setCreating(false);
                onCreate(name, type);
              }}
            />
          )}
        </div>
      </div>

      {trailing !== undefined && (
        <div className="flex flex-none items-center gap-0.5 pb-1 pl-2">{trailing}</div>
      )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(views.find((v) => v.id === menu.id) ?? views[0])}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function RenameTab({
  name,
  icon,
  onCommit,
}: {
  name: string;
  icon: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <span className="mb-1 inline-flex flex-none items-center gap-1.5 px-1.5">
      <Icon name={icon} size={13} color="var(--n-500)" />
      <input
        autoFocus
        aria-label="View name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCommit('');
          }
        }}
        className="h-[26px] w-32 rounded-md border border-cortex-500 px-1.5 text-sm text-n-900 shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
      />
    </span>
  );
}

/** Anchored popover listing every layout in the catalog (VIEW_KINDS). */
function LayoutPicker({
  current,
  onPick,
  onClose,
}: {
  current: ViewType;
  onPick: (type: ViewType) => void;
  onClose: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Close layout picker"
        onClick={onClose}
        onWheel={onClose}
        className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
      />
      {/* Fixed, not absolute: the tab row scrolls horizontally, and an
          absolutely-positioned popover inside a scroll container is clipped by
          it — the picker rendered as a sliver of its own top edge. */}
      <FixedBelowAnchor>
        <div
          role="listbox"
          aria-label="Layout"
          className="z-50 w-[188px] rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]"
        >
          {VIEW_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="option"
              aria-selected={k.value === current}
              data-testid={`view-switch-${k.value}`}
              onClick={() => onPick(k.value)}
              className={[
                'flex w-full items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm',
                k.value === current
                  ? 'bg-cortex-50 text-cortex-700'
                  : 'bg-transparent text-n-700 hover:bg-n-50',
              ].join(' ')}
            >
              <Icon name={k.icon} size={13} />
              <span className="flex-1">{k.label}</span>
              {k.value === current && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      </FixedBelowAnchor>
    </>
  );
}

/**
 * A tab's own icon (M16.26).
 *
 * `ViewDefinition.icon` has been parsed, serialized and RENDERED since M11 —
 * `ViewTabs` reads `view.icon ?? kind.icon` — but `newView` hardcodes `null`
 * and nothing in the app could write one, so every tab of the same layout wore
 * the same glyph and the key was dead weight in the YAML.
 *
 * Clearing it is a real choice, not an absence: the tab falls back to its
 * LAYOUT's icon, which is what the first tile says.
 */
function ViewIconPicker({
  current,
  layoutIcon,
  layoutLabel: layoutName,
  onPick,
  onClose,
}: {
  current: string | null;
  layoutIcon: string;
  layoutLabel: string;
  onPick: (icon: string | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Close icon picker"
        onClick={onClose}
        onWheel={onClose}
        className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
      />
      {/* Fixed for the same reason the layout picker is: the tab strip is a
          horizontal scroll container and clips its absolute descendants. */}
      <FixedBelowAnchor>
        <div
          data-testid="view-icon-picker"
          className="z-50 w-[300px] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]"
        >
          <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            Tab icon
          </div>
          <IconPicker
            value={current}
            onChange={onPick}
            clear={{
              label: `Use the ${layoutName.toLowerCase()} icon`,
              icon: layoutIcon,
              onClear: () => onPick(null),
            }}
          />
        </div>
      </FixedBelowAnchor>
    </>
  );
}

/**
 * Create a view: name it and pick its layout, in one step.
 *
 * The layout is chosen HERE rather than switched afterwards — that is the whole
 * point of the change. A view's layout is part of what the view is, so the
 * moment you decide to make one is the moment you decide what kind it is.
 */
function NewViewForm({
  taken,
  onCreate,
  onCancel,
}: {
  taken: string[];
  onCreate: (name: string, type: ViewType) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ViewType>('table');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Until you type, the name tracks the layout — "Board", then "Board 2" if
  // there already is one. Nobody wants to name their first board.
  const suggested = uniqueName(layoutLabel(type), taken);
  const effective = touched && name.trim() !== '' ? name.trim() : suggested;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <>
      <button
        type="button"
        aria-label="Close new view"
        onClick={onCancel}
        onWheel={onCancel}
        className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
      />
      {/* Fixed for the same reason the layout picker is: the tab row is a
          horizontal scroll container, and it clips its absolutely-positioned
          descendants. */}
      <FixedBelowAnchor>
        <div
          ref={ref}
          data-testid="new-view-form"
          className="z-50 w-[320px] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]"
        >
          <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            New view
          </div>
          <Input
            autoFocus
            size="sm"
            ariaLabel="View name"
            placeholder={suggested}
            value={name}
            onChange={(e) => {
              setTouched(true);
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreate(effective, type);
            }}
            width="100%"
          />
          {/* 4-up since the catalog passed nine kinds (M29.49): ten tiles in
              three columns stranded a lone tile on a fourth row. 4/4/2 reads
              as a grid. The popover widened to 320px with it, MEASURED rather
              than guessed — at 300px the longest label ("Whiteboard", 61px)
              still fit on one line but ate the tile's whole 4px of padding,
              which is a wrap on any font stack a shade wider than this one. */}
          <div className="mt-2 grid grid-cols-4 gap-1">
            {VIEW_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                aria-pressed={k.value === type}
                data-testid={`new-view-${k.value}`}
                onClick={() => setType(k.value)}
                className={[
                  'flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-2xs',
                  k.value === type
                    ? 'border-cortex-500 bg-cortex-50 text-cortex-700'
                    : 'border-n-200 bg-transparent text-n-600 hover:bg-n-50',
                ].join(' ')}
              >
                <Icon name={k.icon} size={15} />
                {k.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-n-200 bg-transparent px-2.5 py-1 text-xs text-n-700 hover:bg-n-50"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="create-view"
              onClick={() => onCreate(effective, type)}
              className="rounded-md border-0 bg-cortex-500 px-2.5 py-1 text-xs font-medium text-n-0 hover:bg-cortex-600"
            >
              Create
            </button>
          </div>
        </div>
      </FixedBelowAnchor>
    </>
  );
}

/** "Board", then "Board 2" — a suggested name that is not already a tab.
 * Exported for `RecordTabs` (M44.5), which mints tab names the same way. */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
