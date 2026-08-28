import React, { useEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { useSortableList } from '@/hooks/useSortableList';
import type { TabContent, TabDef } from '@/engine/types';
import { nextViewId, slugifyViewId } from '@/engine/views';
import { uniqueName } from '@/views/ViewTabs';

/**
 * The record page's tab strip (M44.5) — a focused subset of `ViewTabs`
 * (`src/views/ViewTabs.tsx`): same tablist semantics, same popover mechanics,
 * fewer features (no layout picker, no icon picker, no settings aside).
 *
 * Controlled on purpose: the strip renders `tabs` and reports intent — a
 * press through `onSelect`, every structural edit as the whole next tab set
 * through `onChange` — while the HOST owns persistence (`setTypeTabs` writes
 * the Type doc) and the selection (the open tab rides `{ kind: 'doc', tab }`
 * so the back button returns to it).
 */

/** What a new tab can render — a tile catalog, `VIEW_KINDS`' little sibling. */
const TAB_KINDS: { value: TabContent; label: string; icon: string }[] = [
  { value: 'sections', label: 'Sections', icon: 'text' },
  { value: 'properties', label: 'Properties', icon: 'list' },
  { value: 'overview', label: 'Overview', icon: 'layout-grid' },
];

const kindIcon = (content: TabContent): string =>
  TAB_KINDS.find((k) => k.value === content)?.icon ?? 'text';

/** A tab id from the user's name. `nextViewId`'s slug rules fit exactly —
 * lowercase kebab, `-2`/`-3` on collision — except its empty-slug fallback
 * says "view"; a record tab says "tab". */
const mintTabId = (name: string, taken: string[]): string =>
  nextViewId(slugifyViewId(name) === '' ? 'tab' : name, taken);

/** `moveView`'s pure splice (src/engine/views.ts), over TabDef. */
function moveTab(tabs: TabDef[], id: string, to: number): TabDef[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1 || from === to || to < 0 || to >= tabs.length) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export interface RecordTabsProps {
  tabs: TabDef[];
  activeId: string;
  onSelect: (id: string) => void;
  /** The whole next tab set — the host persists it (setTypeTabs). */
  onChange: (next: TabDef[]) => void;
}

export function RecordTabs({ tabs, activeId, onSelect, onChange }: RecordTabsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // A tab points at per-record section content, and removing the pointer is
  // one click from an ordinary tab click — the app has no undo, so ask.
  const [deleting, setDeleting] = useState<TabDef | null>(null);

  // Horizontal, because the tabs are — arrow keys on the grip follow the axis.
  const sortable = useSortableList({
    ids: tabs.map((t) => t.id),
    axis: 'x',
    labelFor: (id) => tabs.find((t) => t.id === id)?.name ?? id,
    onReorder: (id, to) => onChange(moveTab(tabs, id, to)),
  });

  // Roving tabindex, the same shape as ViewTabs (M16.34): the strip is ONE
  // tab stop and arrows move within it. Falls back to the first tab so the
  // strip stays reachable if `activeId` matches no tab.
  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  const focusIndex = activeIndex >= 0 ? activeIndex : 0;
  const stripRef = useRef<HTMLDivElement>(null);

  const onTabsKeyDown = (e: React.KeyboardEvent) => {
    // Only the tabs themselves rove. The reorder grip takes Left/Right to
    // MOVE a tab, the rename input takes them to move a caret, and the add
    // popover mounts through a portal whose events still bubble here — none
    // of them are asking to switch tabs.
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return;
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key) || tabs.length === 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : focusIndex + (e.key === 'ArrowRight' ? 1 : -1);
    const i = ((next % tabs.length) + tabs.length) % tabs.length;
    const target = tabs[i];
    if (target.id !== activeId) onSelect(target.id);
    // Selection follows focus, so the newly active tab is the tab stop — and
    // the tab that was pressed is about to stop being one.
    const nodes = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    // Matched on the id rather than indexed, because a tab being renamed is
    // an input rather than a button and would shift every index after it.
    nodes.find((t) => t.dataset.testid === `record-tab-${target.id}`)?.focus();
  };

  const duplicate = (tab: TabDef, index: number) => {
    const name = uniqueName(
      tab.name,
      tabs.map((t) => t.name),
    );
    const copy: TabDef = {
      ...tab,
      id: mintTabId(
        name,
        tabs.map((t) => t.id),
      ),
      name,
    };
    const next = [...tabs];
    next.splice(index + 1, 0, copy);
    onChange(next);
  };

  const commitDelete = (tab: TabDef) => {
    setDeleting(null);
    const next = tabs.filter((t) => t.id !== tab.id);
    if (next.length === 0) return; // the menu never offers this, but belt and braces
    if (tab.id === activeId) {
      // The open tab is dying — hand the selection to a neighbour BEFORE the
      // set shrinks, so the page never renders a tab that no longer exists.
      const index = tabs.findIndex((t) => t.id === tab.id);
      const survivor = tabs[index - 1] ?? tabs[index + 1];
      onSelect(survivor.id);
    }
    onChange(next);
  };

  const menuItems = (tab: TabDef, index: number): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { icon: 'pencil', label: 'Rename', onSelect: () => setRenaming(tab.id) },
      // Edge positions omit their move rather than offering a dead item —
      // the ContextMenu primitive has no disabled state, deliberately.
      ...(index > 0
        ? [
            {
              icon: 'arrow-left',
              label: 'Move left',
              onSelect: () => onChange(moveTab(tabs, tab.id, index - 1)),
            },
          ]
        : []),
      ...(index < tabs.length - 1
        ? [
            {
              icon: 'arrow-right',
              label: 'Move right',
              onSelect: () => onChange(moveTab(tabs, tab.id, index + 1)),
            },
          ]
        : []),
      { icon: 'copy', label: 'Duplicate', onSelect: () => duplicate(tab, index) },
    ];
    // The last tab is the only way to look at the record; removing it would
    // leave the page with no surface at all.
    if (tabs.length > 1) {
      items.push({
        icon: 'trash-2',
        label: 'Delete tab',
        danger: true,
        onSelect: () => setDeleting(tab),
      });
    }
    return items;
  };

  return (
    <div className="flex min-w-0 flex-none items-end border-b border-n-200 px-6">
      {deleting !== null && (
        <Dialog
          open
          onClose={() => setDeleting(null)}
          title={`Delete "${deleting.name}"?`}
          width={420}
          primaryAction={{
            label: 'Delete tab',
            onClick: () => commitDelete(deleting),
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setDeleting(null) }}
        >
          <p className="m-0 text-sm text-n-600">
            This removes the tab from every record of this type. Its saved sections stay in each
            record&rsquo;s frontmatter.
          </p>
        </Dialog>
      )}
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Record tabs"
        data-testid="record-tabs"
        onKeyDown={onTabsKeyDown}
        // Scrolls rather than wraps: a tab row that reflows onto a second line
        // moves every other tab under the cursor as the window narrows.
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* `display: contents` so the tabs stay direct flex children of the
            strip while the sortable measures ONLY them — the "+ Tab" button
            below must not count as a drop slot. */}
        <div
          ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
          style={{ display: 'contents' }}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeId;
            const icon = tab.icon ?? kindIcon(tab.content);
            if (renaming === tab.id) {
              return (
                <RenameTab
                  key={tab.id}
                  name={tab.name}
                  icon={icon}
                  onCommit={(name) => {
                    setRenaming(null);
                    if (name !== '' && name !== tab.name)
                      onChange(tabs.map((t) => (t.id === tab.id ? { ...t, name } : t)));
                  }}
                />
              );
            }
            return (
              <div
                key={tab.id}
                className={[
                  'group relative flex-none',
                  sortable.dragging === tab.id ? 'opacity-40' : '',
                ].join(' ')}
                style={sortable.dropIndicator(index)}
              >
                {/* The grip sits in the tab's own left padding, which is dead
                    space — an appended handle would shove every tab sideways
                    the moment the pointer arrived. */}
                <Tooltip label="Drag to reorder">
                  <span
                    {...sortable.gripProps(tab.id, index)}
                    // Opacity, not `hidden`: a hidden grip is out of the tab
                    // order, and Left/Right reordering needs it reachable.
                    className="absolute inset-y-1 left-0 z-10 flex w-2.5 cursor-grab items-center justify-center rounded-xs text-n-400 opacity-0 hover:text-n-600 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Icon name="grip-vertical" size={11} />
                  </span>
                </Tooltip>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={index === focusIndex ? 0 : -1}
                  data-testid={`record-tab-${tab.id}`}
                  onClick={(e) => {
                    if (!active) {
                      onSelect(tab.id);
                      return;
                    }
                    // Anchor the menu to the tab that was pressed, taken from
                    // the event — the tab IS the event target.
                    const box = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.left, y: box.bottom, id: tab.id });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, id: tab.id });
                  }}
                  className={[
                    'inline-flex max-w-[220px] items-center gap-1.5 whitespace-nowrap border-0 border-b-2 bg-transparent px-2.5 pb-2 pt-1.5 text-sm',
                    active
                      ? 'border-cortex-500 font-semibold text-n-900'
                      : 'border-transparent font-normal text-n-500 hover:text-n-800',
                  ].join(' ')}
                  style={{ borderBottomStyle: 'solid' }}
                >
                  <Icon name={icon} size={13} />
                  <span className="min-w-0 truncate">{tab.name}</span>
                  {/* The caret appears on the tab you are standing on: the
                      only one whose menu opens without leaving where you are. */}
                  {active && <Icon name="chevron-down" size={11} color="var(--n-400)" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="relative flex-none">
          <button
            type="button"
            data-testid="new-record-tab"
            aria-label="New tab"
            onClick={() => setCreating(true)}
            className="mb-1 ml-1 inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
          >
            <Icon name="plus" size={13} />
            Tab
          </button>
          {creating && (
            <NewTabForm
              takenNames={tabs.map((t) => t.name)}
              onCancel={() => setCreating(false)}
              onCreate={(name, content) => {
                setCreating(false);
                onChange([
                  ...tabs,
                  {
                    id: mintTabId(
                      name,
                      tabs.map((t) => t.id),
                    ),
                    name,
                    icon: null,
                    content,
                  },
                ]);
              }}
            />
          )}
        </div>
      </div>

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(
            tabs.find((t) => t.id === menu.id) ?? tabs[0],
            Math.max(
              tabs.findIndex((t) => t.id === menu.id),
              0,
            ),
          )}
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
        aria-label="Tab name"
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

/**
 * Create a tab: name it and pick what it renders, in one step — the
 * `NewViewForm` shape. Sections is the default because a NEW tab is almost
 * always a place to write; Overview and Properties re-arrange what the page
 * already shows.
 */
function NewTabForm({
  takenNames,
  onCreate,
  onCancel,
}: {
  takenNames: string[];
  onCreate: (name: string, content: TabContent) => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState<TabContent>('sections');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);

  // Until you type, the name is "Tab", then "Tab 2" if there already is one.
  const suggested = uniqueName('Tab', takenNames);
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
        aria-label="Close new tab"
        onClick={onCancel}
        onWheel={onCancel}
        className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
      />
      {/* Fixed, not absolute: the tab strip is a horizontal scroll container
          and clips its absolutely-positioned descendants — an absolute popover
          renders as a sliver of its own top edge. */}
      <FixedBelowAnchor>
        <div
          data-testid="new-record-tab-form"
          className="z-50 w-[260px] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]"
        >
          <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            New tab
          </div>
          <Input
            autoFocus
            size="sm"
            ariaLabel="Tab name"
            placeholder={suggested}
            value={name}
            onChange={(e) => {
              setTouched(true);
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreate(effective, content);
            }}
            width="100%"
          />
          <div className="mt-2 grid grid-cols-3 gap-1">
            {TAB_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                aria-pressed={k.value === content}
                data-testid={`new-tab-kind-${k.value}`}
                onClick={() => setContent(k.value)}
                className={[
                  'flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-2xs',
                  k.value === content
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
              data-testid="create-record-tab"
              onClick={() => onCreate(effective, content)}
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
