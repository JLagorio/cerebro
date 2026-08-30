import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { DocProperties } from '@/detail/DocProperties';
import { OutlineTab } from '@/editor/DocOutline';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import { backlinksFor, outgoingFor, type DocLink } from '@/engine/links';
import type { Entry, Schema } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';
import { typeStyle } from '@/engine/typeCatalog';
import { KnowledgeCommit } from '@/knowledge/KnowledgeCommit';
import { RelatedKnowledge } from '@/knowledge/RelatedKnowledge';
import { augmentDocPrompt } from '@/lib/prompts';
import { useUiStore, type DocPanelTab } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

const TABS: { id: DocPanelTab; label: string }[] = [
  { id: 'outline', label: 'Outline' },
  { id: 'info', label: 'Info' },
  { id: 'links', label: 'Links' },
  // M8.3 — the PRD case. A tab rather than an inline suggestion: opening it
  // is the ask, so the assistant never speaks first while you are writing.
  { id: 'knowledge', label: 'Knowledge' },
];

function LinkRow({ link }: { link: DocLink }) {
  const open = useOpenPath();
  const schema = useSchema();
  return (
    <button
      type="button"
      data-testid="doc-link-row"
      onClick={() => open(link.entry.path)}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left hover:bg-n-50"
    >
      <Icon
        name={typeStyle(link.entry.type, schema).icon}
        size={13}
        color={typeStyle(link.entry.type, schema).color ?? 'var(--n-500)'}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-n-800">{link.entry.title}</span>
      {link.via !== 'body' && (
        <span className="flex-none rounded-sm bg-n-50 px-1 py-px text-2xs text-n-500">
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
        <h3 className="mb-1 mt-3 px-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500 first:mt-1">
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
      className="flex w-[272px] flex-none flex-col border-l border-n-200 bg-n-0"
    >
      <div className="flex flex-none items-center gap-1 border-b border-n-100 px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`doc-panel-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={[
              'rounded-md border-0 px-2.5 py-1 text-xs',
              tab === t.id
                ? 'bg-n-100 font-medium text-n-900'
                : 'bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800',
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
        {/* No record `tab` passed, on purpose (M45.6): this panel stands
            BESIDE the page rather than on one of its tabs, and it is the last
            surface holding the record's sections and remainder when the page
            can show none — a type whose tabs are all Sections or View has no
            property-bearing tab at all, and DocPage skips the stack on every
            one of them. Threading a scope here would strand those properties
            with nowhere left to read them. */}
        {tab === 'info' && <DocProperties entry={entry} schema={schema} />}
        {tab === 'links' && <LinksTab entry={entry} />}
        {tab === 'knowledge' && (
          <div className="flex flex-col gap-4 pb-2">
            {/* What this note gave the base comes before what the base can
                give the note: every doc is a candidate source, not just the
                ones that happened to arrive through the Inbox. */}
            <KnowledgeCommit entry={entry} variant="panel" />
            <div className="border-t border-n-100 pt-3.5">
              <RelatedKnowledge
                entry={entry}
                variant="panel"
                askPrompt={augmentDocPrompt(entry.path, entry.title)}
                askSubject={entry.path}
                askLabel="What am I missing?"
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
