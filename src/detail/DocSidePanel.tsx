import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { DocProperties } from '@/detail/DocProperties';
import { OutlineTab } from '@/editor/DocOutline';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import { backlinksFor, outgoingFor, type DocLink } from '@/engine/links';
import type { Entry, Schema } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';
import { useUiStore, type DocPanelTab } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const TABS: { id: DocPanelTab; label: string }[] = [
  { id: 'outline', label: 'Outline' },
  { id: 'info', label: 'Info' },
  { id: 'links', label: 'Links' },
];

function LinkRow({ link }: { link: DocLink }) {
  const open = useOpenPath();
  return (
    <button
      type="button"
      data-testid="doc-link-row"
      onClick={() => open(link.entry.path)}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left hover:bg-[var(--n-50)]"
    >
      <Icon
        name={link.entry.type === 'Person' ? 'circle-user' : 'file-text'}
        size={13}
        color="var(--n-500)"
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--n-800)]">
        {link.entry.title}
      </span>
      {link.via !== 'body' && (
        <span className="flex-none rounded-[5px] bg-[var(--n-50)] px-1 py-px text-[10.5px] text-[var(--n-500)]">
          {link.via}
        </span>
      )}
    </button>
  );
}

function LinksTab({ entry }: { entry: Entry }) {
  const entries = useVaultStore((s) => s.entries);
  const outgoing = outgoingFor(entry, entries);
  const backlinks = backlinksFor(entry, entries);

  if (outgoing.length === 0 && backlinks.length === 0) {
    return (
      <div data-testid="doc-links" className="px-2 py-6">
        <EmptyState
          icon="link"
          title="No connections yet"
          description="Type [[ in the page to link another page. Links to this page show up here too."
        />
      </div>
    );
  }

  const section = (label: string, links: DocLink[]) =>
    links.length === 0 ? null : (
      <>
        <h3 className="mb-1 mt-3 px-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)] first:mt-1">
          {label}
        </h3>
        <div className="flex flex-col gap-px">
          {links.map((l) => (
            <LinkRow key={`${l.entry.path}:${l.via}`} link={l} />
          ))}
        </div>
      </>
    );

  return (
    <div data-testid="doc-links" className="pb-2">
      {section('Links on this page', outgoing)}
      {section(`Backlinks (${backlinks.length})`, backlinks)}
    </div>
  );
}

/**
 * Right-hand doc side panel (M2.x docs polish — Plane's pane pattern): one
 * panel, three tabs. Outline replaces the old floating TOC; Info hosts the
 * properties editor; Links shows resolved connections and backlinks.
 */
export function DocSidePanel({
  entry,
  schema,
  editor,
  scrollRef,
}: {
  entry: Entry;
  schema: Schema;
  editor: CerebroEditor | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tab = useUiStore((s) => s.docPanelTab);
  const setTab = useUiStore((s) => s.setDocPanelTab);

  return (
    <aside
      data-testid="doc-side-panel"
      aria-label="Document panel"
      className="flex w-[272px] flex-none flex-col border-l border-[var(--n-200)] bg-[var(--n-0)]"
    >
      <div className="flex flex-none items-center gap-1 border-b border-[var(--n-100)] px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`doc-panel-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={[
              'rounded-md border-0 px-2.5 py-1 text-[12px]',
              tab === t.id
                ? 'bg-[var(--n-100)] font-medium text-[var(--n-900)]'
                : 'bg-transparent text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {tab === 'outline' &&
          (editor !== null ? (
            <OutlineTab editor={editor} scrollRef={scrollRef} />
          ) : (
            <div data-testid="outline-loading" />
          ))}
        {tab === 'info' && <DocProperties entry={entry} schema={schema} />}
        {tab === 'links' && <LinksTab entry={entry} />}
      </div>
    </aside>
  );
}
