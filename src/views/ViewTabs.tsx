import { useEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import type { ViewDefinition, ViewType } from '@/engine/types';
import { layoutLabel } from '@/engine/views';
import { VIEW_KINDS, viewKind } from '@/views/viewKinds';

/**
 * A List's view tabs (M11).
 *
 * This replaces the segmented layout pills that used to sit in the toolbar.
 * They were the same six buttons on every surface, and pressing one REPLACED
 * the view you had configured — so "look at this as a board" cost you the
 * table's columns, and there was no way to keep both.
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
  onConfigure,
  trailing,
}: ViewTabsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [layoutFor, setLayoutFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const menuItems = (view: ViewDefinition): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { icon: 'pencil', label: 'Rename', onSelect: () => setRenaming(view.id) },
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
        onSelect: () => onDelete(view.id),
      });
    }
    return items;
  };

  return (
    <div className="flex min-w-0 flex-none items-end border-b border-[var(--n-200)] px-5">
      <div
        role="tablist"
        aria-label="Views"
        data-testid="view-tabs"
        // Scrolls rather than wraps: a tab row that reflows onto a second line
        // moves every other tab under the cursor as the window narrows. The
        // trailing icons sit OUTSIDE this strip so they cannot scroll away.
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {views.map((view) => {
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
            <div key={view.id} className="relative flex-none">
              <button
                type="button"
                role="tab"
                aria-selected={active}
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
                  'inline-flex max-w-[220px] items-center gap-1.5 whitespace-nowrap border-0 border-b-2 bg-transparent px-2.5 pb-2 pt-1.5 text-[13px]',
                  active
                    ? 'border-[var(--cortex-500)] font-semibold text-[var(--n-900)]'
                    : 'border-transparent font-normal text-[var(--n-500)] hover:text-[var(--n-800)]',
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
            </div>
          );
        })}

        <div className="relative flex-none">
          <button
            type="button"
            data-testid="new-view"
            aria-label="New view"
            onClick={() => setCreating(true)}
            className="mb-1 ml-1 inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
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
        className="h-[26px] w-32 rounded-md border border-[var(--cortex-500)] px-1.5 text-[13px] text-[var(--n-900)] shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
      />
    </span>
  );
}

/** Anchored popover listing the six layouts. */
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
          className="z-50 w-[188px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1 shadow-[var(--shadow-lg)]"
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
                'flex w-full items-center gap-2 rounded-[7px] border-0 px-2 py-1.5 text-left text-[12.5px]',
                k.value === current
                  ? 'bg-[var(--cortex-50)] text-[var(--cortex-700)]'
                  : 'bg-transparent text-[var(--n-700)] hover:bg-[var(--n-50)]',
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
          className="z-50 w-[268px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-2.5 shadow-[var(--shadow-lg)]"
        >
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
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
          <div className="mt-2 grid grid-cols-3 gap-1">
            {VIEW_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                aria-pressed={k.value === type}
                data-testid={`new-view-${k.value}`}
                onClick={() => setType(k.value)}
                className={[
                  'flex flex-col items-center gap-1 rounded-[8px] border px-1 py-2 text-[11px]',
                  k.value === type
                    ? 'border-[var(--cortex-500)] bg-[var(--cortex-50)] text-[var(--cortex-700)]'
                    : 'border-[var(--n-200)] bg-transparent text-[var(--n-600)] hover:bg-[var(--n-50)]',
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
              className="rounded-md border border-[var(--n-200)] bg-transparent px-2.5 py-1 text-[12px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="create-view"
              onClick={() => onCreate(effective, type)}
              className="rounded-md border-0 bg-[var(--cortex-500)] px-2.5 py-1 text-[12px] font-medium text-[var(--n-0)] hover:bg-[var(--cortex-600)]"
            >
              Create
            </button>
          </div>
        </div>
      </FixedBelowAnchor>
    </>
  );
}

/** "Board", then "Board 2" — a suggested name that is not already a tab. */
function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
