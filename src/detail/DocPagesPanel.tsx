import { useDrawerFocus } from '@/components/ui/DrawerScrim';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import type { DocPages } from '@/engine/docPages';
import { useNavStore } from '@/stores/navStore';
import { DOC_PAGES_MIN_WIDTH, DOC_PAGES_WIDTH, useUiStore } from '@/stores/uiStore';

/**
 * Left-hand Pages panel on multi-page docs — the mirror of the right-hand
 * Outline/Info/Links panel. Lists every page of the doc (main page first),
 * collapsible; collapsed docs show a floating list icon instead
 * (see DocPagesFloatingButton).
 *
 * M52: it gives a little (216 → 180) and then the page folds it to its button
 * rather than let it crush the reading column (shellLayout `pageAsides`).
 * Opened from the button while folded, it floats as a drawer, and `onHide`
 * closes the drawer instead of writing the stored open flag.
 */
export function DocPagesPanel({
  pages,
  activePath,
  onAddPage,
  onHide,
}: {
  pages: DocPages;
  activePath: string;
  onAddPage: () => void;
  /** Set when drawn as a drawer over a folded panel. */
  onHide?: () => void;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const setOpen = useUiStore((s) => s.setDocPagesOpen);
  const drawer = onHide !== undefined;
  const drawerRef = useDrawerFocus<HTMLElement>(drawer);

  return (
    <aside
      ref={drawerRef}
      data-testid="doc-pages-panel"
      aria-label="Doc pages"
      data-overlay={drawer || undefined}
      tabIndex={drawer ? -1 : undefined}
      className={[
        'flex flex-col border-r border-n-200 bg-n-0',
        drawer ? 'absolute inset-y-0 left-0 z-30 shadow-[var(--shadow-lg)] outline-none' : '',
      ].join(' ')}
      style={
        drawer
          ? { width: DOC_PAGES_WIDTH, maxWidth: '85%' }
          : { flex: `0 1 ${DOC_PAGES_WIDTH}px`, minWidth: DOC_PAGES_MIN_WIDTH }
      }
    >
      <div className="flex flex-none items-center gap-1 border-b border-n-100 py-1.5 pl-3 pr-2">
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-n-500">Pages</span>
        <span className="flex-1" />
        <IconButton
          icon="panel-left-close"
          label="Hide pages"
          size="sm"
          onClick={() => (onHide !== undefined ? onHide() : setOpen(false))}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <ul className="m-0 p-0">
          {pages.pages.map((page) => {
            const active = page.path === activePath;
            return (
              <li key={page.path} className="list-none">
                <button
                  type="button"
                  data-testid="doc-pages-row"
                  onClick={() => {
                    navigate({ kind: 'doc', path: page.path });
                    onHide?.();
                  }}
                  className={[
                    'flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 px-1.5 py-[5px] text-left text-sm',
                    active
                      ? 'bg-cortex-50 font-medium text-cortex-600'
                      : 'bg-transparent text-n-700 hover:bg-n-50 hover:text-n-900',
                  ].join(' ')}
                >
                  <Icon
                    name="file-text"
                    size={13}
                    color={active ? 'var(--cortex-500)' : 'var(--n-400)'}
                  />
                  <span className="truncate">{page.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={onAddPage}
          className="mt-0.5 flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-left text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
        >
          <Icon name="plus" size={13} />
          Add page
        </button>
      </div>
    </aside>
  );
}

/**
 * Floating reopen affordance while the Pages panel is collapsed — by the user,
 * or folded by the page for want of width (M52), when `onOpen` opens it as a
 * drawer instead of writing a flag that already says open.
 */
export function DocPagesFloatingButton({ onOpen }: { onOpen?: () => void } = {}) {
  const setOpen = useUiStore((s) => s.setDocPagesOpen);
  return (
    <button
      type="button"
      aria-label="Show pages"
      data-testid="doc-pages-floating"
      onClick={() => (onOpen !== undefined ? onOpen() : setOpen(true))}
      className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-n-200 bg-n-0 text-n-500 shadow-[0_2px_8px_rgba(22,26,36,0.08)] hover:border-cortex-500 hover:text-cortex-600"
    >
      <Icon name="list" size={16} />
    </button>
  );
}
