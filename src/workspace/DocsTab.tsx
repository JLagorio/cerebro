import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { groupDocsByRoot } from '@/engine/roots';
import { useRootsStore } from '@/stores/rootsStore';
import { plainExcerpt } from './plainText';

/**
 * Every markdown file across every mounted root, in one place.
 *
 * This is the "stop poking through the repo to find the README" surface. It is
 * deliberately NOT wired into the `ViewType` union — the viewer earns that
 * promotion only after real use proves it, which is how you avoid shipping a
 * view kind that renders nothing.
 */
export function DocsTab() {
  const roots = useRootsStore((s) => s.roots);
  const docs = useRootsStore((s) => s.docs);
  const loadDocs = useRootsStore((s) => s.loadDocs);
  const openFile = useRootsStore((s) => s.openFile);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs, roots]);

  const groups = groupDocsByRoot(
    docs,
    roots.map((r) => r.id),
  );
  const labelFor = (id: string): string => roots.find((r) => r.id === id)?.label ?? id;

  return (
    <div data-testid="docs-tab" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {groups.length === 0 && (
        <p data-testid="docs-empty" className="m-0 text-sm text-n-500">
          No markdown found in the mounted folders.
        </p>
      )}
      {groups.map((group) => (
        <section key={group.root} data-testid="docs-group" className="mb-6">
          <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            {labelFor(group.root)}
          </h2>
          <ul className="m-0 flex max-w-[760px] flex-col gap-1 p-0">
            {group.docs.map((doc) => (
              <li key={`${doc.root}/${doc.path}`} className="list-none">
                <button
                  type="button"
                  data-testid="doc-card"
                  data-path={doc.path}
                  data-root={doc.root}
                  onClick={() => openFile(doc.root, doc.path)}
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon
                      name={doc.isReadme ? 'book-open' : 'file-text'}
                      size={14}
                      color="var(--n-500)"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-n-800">{doc.title}</span>
                    <span className="hidden flex-none text-2xs text-[var(--text-meta)] [font-family:var(--font-mono)] @[520px]/canvas:inline">
                      {doc.path}
                    </span>
                  </span>
                  {/* The snippet arrives as raw markdown. Printed verbatim a
                      summary reads "A ledger. ## Install ```bash …" — syntax
                      competing with the sentence it is summarising. */}
                  {plainExcerpt(doc.snippet) !== '' && (
                    <span
                      data-testid="doc-excerpt"
                      className="line-clamp-2 pl-[22px] text-2xs text-n-500"
                    >
                      {plainExcerpt(doc.snippet)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
