import { Fragment, useCallback, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useDragGesture } from '@/hooks/useDragGesture';
import type { EditorGroup } from '@/engine/editorGroups';
import { useRootsStore } from '@/stores/rootsStore';
import { Breadcrumb } from './Breadcrumb';
import { FileViewer } from './FileViewer';
import { GroupContext } from './groupContext';
import { TabBar } from './TabBar';
import { currentTabDrag, endTabDrag, zoneFor, type DropZone } from './tabDrag';

/** A pane narrower than this cannot show a line of code, so drags stop here. */
const MIN_PANE = 220;

/**
 * The panes, side by side (M30.24).
 *
 * Widths are flex-GROW rather than pixels: the row has to keep filling the
 * window when it resizes, and a pixel width recorded at one window size is
 * wrong at every other. A drag moves grow between the two panes it sits
 * between, so the total never changes and the panes that were not touched do
 * not move.
 */
export function EditorGroups() {
  const layout = useRootsStore((s) => s.layout);
  const focusGroup = useRootsStore((s) => s.focusGroup);
  const rowRef = useRef<HTMLDivElement>(null);
  const [grow, setGrow] = useState<Record<string, number>>({});
  /** The drag's claim on Escape, and the teardown an unmount runs (M46.2). */
  const gesture = useDragGesture();

  const growOf = useCallback((id: string): number => grow[id] ?? 1, [grow]);

  /** Drag the divider between the pane at `index` and the one after it. */
  const beginResize = (index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const panes = rowRef.current?.querySelectorAll<HTMLElement>('[data-testid="editor-pane"]');
    const left = panes?.[index];
    const right = panes?.[index + 1];
    const leftId = layout.groups[index]?.id;
    const rightId = layout.groups[index + 1]?.id;
    if (!left || !right || leftId === undefined || rightId === undefined) return;

    // Measured once, at grab time: re-measuring per move would read back the
    // widths this drag has already applied and compound them.
    const startX = e.clientX;
    const leftW = left.getBoundingClientRect().width;
    const rightW = right.getBoundingClientRect().width;
    const total = leftW + rightW;
    const growTotal = growOf(leftId) + growOf(rightId);

    const fromLeft = growOf(leftId);
    const fromRight = growOf(rightId);

    const move = (ev: PointerEvent) => {
      const width = Math.max(MIN_PANE, Math.min(total - MIN_PANE, leftW + (ev.clientX - startX)));
      const nextLeft = (growTotal * width) / total;
      setGrow((g) => ({ ...g, [leftId]: nextLeft, [rightId]: growTotal - nextLeft }));
    };
    let released = false;
    /**
     * Ends the gesture. `released` is false for an Escape and for an unmount
     * that catches the drag still live, and both mean the same thing: the
     * gesture never finished, so the two panes go back to the grow they had
     * when the divider was grabbed (M46.2). This drag paints THROUGH state,
     * with no separate commit — so the restore is a `setGrow` of its own.
     */
    const teardown = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('cb-resizing');
      if (!released) setGrow((g) => ({ ...g, [leftId]: fromLeft, [rightId]: fromRight }));
    };
    const up = () => {
      released = true;
      gesture.end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.classList.add('cb-resizing');
    gesture.begin(teardown);
  };

  const nudge = (index: number) => (e: React.KeyboardEvent) => {
    const leftId = layout.groups[index]?.id;
    const rightId = layout.groups[index + 1]?.id;
    if (leftId === undefined || rightId === undefined) return;
    const step = e.key === 'ArrowLeft' ? -0.1 : e.key === 'ArrowRight' ? 0.1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const growTotal = growOf(leftId) + growOf(rightId);
    const next = Math.max(0.2, Math.min(growTotal - 0.2, growOf(leftId) + step));
    setGrow((g) => ({ ...g, [leftId]: next, [rightId]: growTotal - next }));
  };

  return (
    <div ref={rowRef} data-testid="editor-groups" className="flex min-h-0 min-w-0 flex-1">
      {layout.groups.map((group, index) => (
        <Fragment key={group.id}>
          <Pane
            group={group}
            focused={group.id === layout.activeGroupId}
            grow={growOf(group.id)}
            onFocus={() => focusGroup(group.id)}
          />
          {index < layout.groups.length - 1 && (
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize pane ${index + 1}`}
              tabIndex={0}
              data-testid="pane-splitter"
              onPointerDown={beginResize(index)}
              onKeyDown={nudge(index)}
              className="group relative z-10 -mx-[3px] flex w-[7px] flex-none cursor-col-resize touch-none items-stretch justify-center"
            >
              <span className="w-[1px] bg-n-200 transition-colors group-hover:bg-cortex-400 group-focus:bg-cortex-500" />
            </span>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function Pane({
  group,
  focused,
  grow,
  onFocus,
}: {
  group: EditorGroup;
  focused: boolean;
  grow: number;
  onFocus: () => void;
}) {
  const moveTab = useRootsStore((s) => s.moveTab);
  const splitWithTab = useRootsStore((s) => s.splitWithTab);
  const [zone, setZone] = useState<DropZone | null>(null);

  return (
    <section
      data-testid="editor-pane"
      data-group={group.id}
      data-focused={focused}
      data-drop-zone={zone ?? undefined}
      aria-label={`Editor pane ${focused ? '(focused)' : ''}`.trim()}
      style={{ flex: `${grow} 1 0px` }}
      // Capture, so clicking anywhere inside — a tab, a link, the code — moves
      // focus to this pane. Without it the keyboard's idea of "the pane" and
      // the eye's would drift apart after the first click.
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      className="relative flex min-h-0 min-w-0 flex-col border-r border-n-100 last:border-r-0"
      onDragOver={(e) => {
        if (currentTabDrag() === null) return;
        e.preventDefault();
        setZone(zoneFor(e.clientX, e.currentTarget.getBoundingClientRect()));
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        e.preventDefault();
        const where = zoneFor(e.clientX, e.currentTarget.getBoundingClientRect());
        setZone(null);
        const drag = currentTabDrag();
        if (drag === null) return;
        if (where === 'center') {
          // The middle of a pane means "put it in here", with no opinion about
          // where in the strip — so it lands at the end.
          moveTab(drag.tab, drag.fromGroupId, group.id, group.tabs.length);
        } else {
          splitWithTab(drag.tab, drag.fromGroupId, group.id, where);
        }
        endTabDrag();
      }}
    >
      {/* The shape the drop would produce, drawn where it would land: a half
          for an edge, the whole pane for the middle. A drag that only tints
          the pane leaves you guessing which of the two things it will do. */}
      {zone !== null && (
        <div
          aria-hidden
          data-testid="drop-preview"
          data-zone={zone}
          className={`pointer-events-none absolute inset-y-0 z-20 border-2 border-cortex-500 bg-cortex-500/15 ${
            zone === 'left' ? 'left-0 w-1/2' : zone === 'right' ? 'right-0 w-1/2' : 'inset-x-0'
          }`}
        />
      )}
      {/* Everything inside a pane opens into THAT pane. Without this a link
          followed from the keyboard lands in whichever pane happens to hold
          focus, which is not the one you were reading. */}
      <GroupContext.Provider value={group.id}>
        <TabBar group={group} focused={focused} />
        {group.active === null ? (
          <EmptyState
            icon="file-text"
            title="Nothing open"
            description="Pick a file from the tree."
          />
        ) : (
          <>
            <Breadcrumb tab={group.active} />
            <FileViewer
              key={`${group.active.rootId}/${group.active.path}`}
              rootId={group.active.rootId}
              path={group.active.path}
            />
          </>
        )}
      </GroupContext.Provider>
    </section>
  );
}
