import { useDrawerFocus } from '@/components/ui/DrawerScrim';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { DocProperties } from '@/detail/DocProperties';
import { LastChange } from '@/detail/LastChange';
import { PageAccess } from '@/detail/PageAccess';
import { OutlineTab } from '@/editor/DocOutline';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { backlinksFor, outgoingFor, type DocLink } from '@/engine/links';
import type { Concept } from '@/engine/okf';
import type { Entry, Schema } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';
import { typeStyle } from '@/engine/typeCatalog';
import { ConceptDetailsTab } from '@/knowledge/ConceptDetailsTab';
import { CommentsTab } from '@/detail/CommentsTab';
import type { PageCommentsController } from '@/detail/usePageComments';
import { PageHistory } from '@/history/PageHistory';
import { FileNote } from '@/library/chrome';
import { PageKnowledge } from '@/knowledge/PageKnowledge';
import {
  DOC_PANEL_MIN_WIDTH,
  DOC_PANEL_WIDTH,
  useUiStore,
  type ConceptPanelTab,
  type DocPanelTab,
} from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

const TABS: { id: DocPanelTab; label: string }[] = [
  { id: 'outline', label: 'Outline' },
  { id: 'info', label: 'Info' },
  { id: 'links', label: 'Links' },
  // M8.3 — the PRD case. A tab rather than an inline suggestion: opening it
  // is the ask, so the assistant never speaks first while you are writing.
  { id: 'knowledge', label: 'Knowledge' },
  // M70.2b — the page's threads: on its text, and about the whole page.
  { id: 'comments', label: 'Comments' },
  // M58.4 (D18) — the page's versions, as prose, with Restore, merged with
  // its recorded edits (M64.2b).
  { id: 'history', label: 'History' },
];

/** A concept's panel (M50.1): its provenance first. The review itself is the
 *  bar under the title (M51.3). */
const CONCEPT_TABS: { id: ConceptPanelTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'outline', label: 'Outline' },
  { id: 'links', label: 'Links' },
  // A concept takes comments like any page (M70.2b, Q5): the sidecar sits
  // outside the bundle, and a thread can neither write nor verify it.
  { id: 'comments', label: 'Comments' },
  // Its versions read like any page's (M58.4), beside what the ledger
  // recorded about it (M64.2b); Restore is not offered there.
  { id: 'history', label: 'History' },
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
 * An agent page's Info (M55.12): read-only. Its settings are the page's own
 * property rows, which write one grant on Done; the generic property editor
 * would offer free-text edits and remove-X on `scope:`, `tools:` and
 * `schedule:`, the hazard M18 named.
 */
function AgentInfo({ entry }: { entry: Entry }) {
  const { handle, actor } = agentRef(entry);
  return (
    <div data-testid="agent-info" className="flex flex-col gap-2 px-1.5 py-2 text-sm text-n-700">
      <FileNote path={entry.path} />
      <p className="m-0">
        Answers to @{handle}; writes as {actor}
      </p>
      <p className="m-0 text-n-500">Its settings are this page&rsquo;s properties</p>
    </div>
  );
}

/**
 * Right-hand doc side panel (M2.x docs polish — Plane's pane pattern): one
 * panel, its tabs in TABS (CONCEPT_TABS on a concept). Outline replaces the
 * old floating TOC; Info leads with who last changed the page (M58.1b),
 * hosts the properties editor (on an agent page, a read-only note — M55.12)
 * and ends with who else can change it (M58.6); a concept's panel has no
 * Info; Links shows resolved connections and backlinks;
 * Comments holds the page's threads (M70.2b); History is `PageHistory`
 * (M64.2b): its versions, each opening the version lens in place of the
 * editor (M58.4, D18), merged with its recorded edits, the runs that wrote
 * it and, on a concept, the ledger's events.
 */
export function DocSidePanel({
  entry,
  schema,
  editor,
  scrollRef,
  concept = null,
  overlay = false,
  comments = null,
}: {
  entry: Entry;
  schema: Schema;
  editor: CerebroEditor | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Set on a concept page: the panel leads with the concept's details. */
  concept?: Concept | null;
  /**
   * Drawn as a drawer over the reading column rather than beside it (M52):
   * the page has no room for both floors, so the panel folded, and the user
   * asked for it anyway. The page decides; the stored open flag is not asked.
   */
  overlay?: boolean;
  /** The page's comments (M70.2b), which DocPage drives. */
  comments?: PageCommentsController | null;
}) {
  const docTab = useUiStore((s) => s.docPanelTab);
  const setDocTab = useUiStore((s) => s.setDocPanelTab);
  const conceptTab = useUiStore((s) => s.conceptPanelTab);
  const setConceptTab = useUiStore((s) => s.setConceptPanelTab);
  const tabs: { id: DocPanelTab | ConceptPanelTab; label: string }[] =
    concept !== null ? CONCEPT_TABS : TABS;
  const tab: DocPanelTab | ConceptPanelTab = concept !== null ? conceptTab : docTab;
  const drawerRef = useDrawerFocus<HTMLElement>(overlay);
  const setTab = (next: DocPanelTab | ConceptPanelTab) => {
    if (concept !== null) setConceptTab(next as ConceptPanelTab);
    else setDocTab(next as DocPanelTab);
  };

  return (
    <aside
      ref={drawerRef}
      data-testid="doc-side-panel"
      aria-label="Document panel"
      data-overlay={overlay || undefined}
      tabIndex={overlay ? -1 : undefined}
      // A preference, not a wall (M52): it gives from its width down to its
      // floor once the reading column beside it has reached its own. Past
      // that the page folds it, and a drawer is how it comes back.
      className={[
        'flex flex-col border-l border-n-200 bg-n-0',
        overlay ? 'absolute inset-y-0 right-0 z-20 shadow-[var(--shadow-lg)] outline-none' : '',
      ].join(' ')}
      style={
        overlay
          ? { width: DOC_PANEL_WIDTH, maxWidth: '85%' }
          : { flex: `0 1 ${DOC_PANEL_WIDTH}px`, minWidth: DOC_PANEL_MIN_WIDTH }
      }
    >
      {/* Wraps rather than clips: at the panel's floor the tabs can be wider
          than the panel. */}
      <div className="flex flex-none flex-wrap items-center gap-1 border-b border-n-100 px-2 py-1.5">
        {tabs.map((t) => (
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
            {/* A quiet count of open threads, only once it is known and
                above zero (CV-05: loading and unavailable are not 0). It
                stays in the panel and never reaches the nav. */}
            {t.id === 'comments' &&
              comments?.slot?.kind === 'ready' &&
              (comments.sections?.openCount ?? 0) > 0 && (
                <span
                  data-testid="doc-panel-comment-count"
                  className="ml-1 font-mono text-2xs text-[var(--text-meta)]"
                >
                  {comments.sections?.openCount}
                </span>
              )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {tab === 'details' && concept !== null && <ConceptDetailsTab concept={concept} />}
        {tab === 'outline' &&
          (editor !== null ? (
            <OutlineTab editor={editor} scrollRef={scrollRef} />
          ) : (
            <div data-testid="outline-loading" />
          ))}
        {tab === 'info' && (
          <>
            <LastChange entry={entry} />
            {isAgentEntry(entry) ? (
              <AgentInfo entry={entry} />
            ) : (
              <DocProperties entry={entry} schema={schema} />
            )}
            <PageAccess entry={entry} />
          </>
        )}
        {tab === 'links' && <LinksTab entry={entry} />}
        {tab === 'comments' && comments !== null && <CommentsTab controller={comments} />}
        {tab === 'history' && <PageHistory path={entry.path} />}
        {/* The record peek's Knowledge, component for component (M52.3).
            What this note gave Knowledge comes before what Knowledge can give
            the note: every doc is a candidate source, not just the ones that
            happened to arrive through the Inbox. */}
        {tab === 'knowledge' && (
          <div className="pb-2 pt-1.5">
            <PageKnowledge entry={entry} />
          </div>
        )}
      </div>
    </aside>
  );
}
