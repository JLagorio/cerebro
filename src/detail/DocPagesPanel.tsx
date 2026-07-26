import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import type { DocPages } from '@/engine/docPages';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * Left-hand Pages panel on multi-page docs — the mirror of the right-hand
 * Outline/Info/Links panel. Lists every page of the doc (main page first),
 * collapsible; collapsed docs show a floating list icon instead
 * (see DocPagesFloatingButton).
 */
export function DocPagesPanel({
  pages,
  activePath,
  onAddPage,
}: {
  pages: DocPages;
  activePath: string;
  onAddPage: () => void;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const setOpen = useUiStore((s) => s.setDocPagesOpen);

  return (
    <aside
      data-testid="doc-pages-panel"
      aria-label="Doc pages"
      className="flex w-[216px] flex-none flex-col border-r border-[var(--n-200)] bg-[var(--n-0)]"
    >
      <div className="flex flex-none items-center gap-1 border-b border-[var(--n-100)] py-1.5 pl-3 pr-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
          Pages
        </span>
        <span className="flex-1" />
        <IconButton
          icon="panel-left-close"
          label="Hide pages"
          size="sm"
          onClick={() => setOpen(false)}
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
                  onClick={() => navigate({ kind: 'doc', path: page.path })}
                  className={[
                    'flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 px-1.5 py-[5px] text-left text-[12.5px]',
                    active
                      ? 'bg-[var(--cortex-50)] font-medium text-[var(--cortex-600)]'
                      : 'bg-transparent text-[var(--n-700)] hover:bg-[var(--n-50)] hover:text-[var(--n-900)]',
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
          className="mt-0.5 flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-left text-[12px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
        >
          <Icon name="plus" size={13} />
          Add page
        </button>
      </div>
    </aside>
  );
}

/** Floating reopen affordance while the Pages panel is collapsed. */
export function DocPagesFloatingButton() {
  const setOpen = useUiStore((s) => s.setDocPagesOpen);
  return (
    <button
      type="button"
      aria-label="Show pages"
      data-testid="doc-pages-floating"
      onClick={() => setOpen(true)}
      className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--n-200)] bg-[var(--n-0)] text-[var(--n-500)] shadow-[0_2px_8px_rgba(22,26,36,0.08)] hover:border-[var(--cortex-500)] hover:text-[var(--cortex-600)]"
    >
      <Icon name="list" size={16} />
    </button>
  );
}
