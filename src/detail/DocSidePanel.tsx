import { useCallback, useLayoutEffect, useState, type ReactNode, type Ref } from 'react';
import { PANEL_LABELS } from '@/components/PageToolbar';
import { useDrawerFocus } from '@/components/ui/DrawerScrim';
import { useArrival } from '@/components/ui/motion';
import { Icon } from '@/components/ui/Icon';
import { DocProperties } from '@/detail/DocProperties';
import { InspectorSection } from '@/detail/InspectorSection';
import { LastChange } from '@/detail/LastChange';
import { AccessSummary, PageAccess } from '@/detail/PageAccess';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { formatDate, localDateOf } from '@/engine/dates';
import { backlinksFor, outgoingFor, type DocLink } from '@/engine/links';
import type { Concept } from '@/engine/okf';
import type { Entry, Schema } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';
import { typeStyle } from '@/engine/typeCatalog';
import { ConceptDetails } from '@/knowledge/ConceptDetails';
import { CommentsPanel } from '@/detail/CommentsPanel';
import type { PageCommentsController } from '@/detail/usePageComments';
import { PageHistory } from '@/history/PageHistory';
import { PageKnowledge } from '@/knowledge/PageKnowledge';
import type { PagePanel } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import './inspector.css';

/** One linked page: its type's icon, its title, and — when the link rides a
 *  property rather than the text — that property's name, quietly, at the
 *  right. */
function LinkRow({ link, more = false }: { link: DocLink; more?: boolean }) {
  const open = useOpenPath();
  const schema = useSchema();
  const style = typeStyle(link.entry.type, schema);
  return (
    <button
      type="button"
      data-testid="doc-link-row"
      // One a "Show more" added, which arrives under the rest (inspector.css).
      data-more={more || undefined}
      onClick={() => open(link.entry.path)}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent px-2 text-left text-ui motion-hover hover:bg-n-50"
    >
      <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
      <span className="min-w-0 flex-1 truncate text-n-800">{link.entry.title}</span>
      {link.via !== 'body' && (
        <span data-testid="doc-link-via" className="flex-none text-metadata text-n-400">
          {link.via}
        </span>
      )}
    </button>
  );
}

/** How many links a list shows before it folds the rest behind one row. */
const LINK_ROWS_SHOWN = 6;

/** Rows that bleed their hover past the section's text edge, aligned with it.
 *  A long list shows its first rows and folds the rest behind one quiet row. */
function LinkRows({ links }: { links: DocLink[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? links : links.slice(0, LINK_ROWS_SHOWN);
  return (
    <div className="-mx-2 flex flex-col gap-px">
      {shown.map((l, i) => (
        <LinkRow key={`${l.entry.path}:${l.via}`} link={l} more={i >= LINK_ROWS_SHOWN} />
      ))}
      {links.length > LINK_ROWS_SHOWN && (
        <button
          type="button"
          data-testid="doc-links-more"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="flex h-7 w-full items-center gap-2 rounded-sm border-0 bg-transparent px-2 text-left text-ui text-n-400 motion-hover hover:bg-n-50 hover:text-n-700"
        >
          <Icon name={all ? 'chevron-up' : 'chevron-down'} size={14} />
          {all ? 'Show fewer' : `Show ${links.length - LINK_ROWS_SHOWN} more`}
        </button>
      )}
    </div>
  );
}

/**
 * The page's connections: the pages it links to and the pages that link to
 * it, a section each, and a section only when it has a row. With neither,
 * one header says None, and its tooltip how to make one.
 */
function LinkSections({ entry }: { entry: Entry }) {
  const entries = useVaultStore((s) => s.entries);
  const outgoing = outgoingFor(entry, entries);
  const backlinks = backlinksFor(entry, entries);

  return (
    <div data-testid="doc-links">
      {outgoing.length === 0 && backlinks.length === 0 ? (
        <InspectorSection
          id="links"
          label="Links"
          summary={<span title="Type [[ in the page to link another">None</span>}
        />
      ) : (
        <>
          {outgoing.length > 0 && (
            <InspectorSection id="links" label="Links" count={outgoing.length}>
              <LinkRows links={outgoing} />
            </InspectorSection>
          )}
          {backlinks.length > 0 && (
            <InspectorSection id="backlinks" label="Backlinks" count={backlinks.length}>
              <LinkRows links={backlinks} />
            </InspectorSection>
          )}
        </>
      )}
    </div>
  );
}

/**
 * An agent page's Details (M55.12): read-only facts. Its settings are the
 * page's own property rows, which write one grant on Done; the generic
 * property editor would offer free-text edits and remove-X on `scope:`,
 * `tools:` and `schedule:`, the hazard M18 named.
 */
function AgentInfo({ entry }: { entry: Entry }) {
  const { handle, actor } = agentRef(entry);
  return (
    <dl
      data-testid="agent-info"
      title="Its settings are this page’s properties"
      className="cb-inspector-facts"
    >
      <dt>Handle</dt>
      <dd>@{handle}</dd>
      <dt>Writes as</dt>
      <dd>
        <span className="truncate" title={actor}>
          {actor}
        </span>
      </dd>
      <dt>File</dt>
      <dd>
        <span className="truncate" title={entry.path}>
          {entry.path}
        </span>
      </dd>
    </dl>
  );
}

/** A day as the Info section says it, "Jul 23, 2026": the day this
 *  machine's clock said (M61.8). Text that reads as no date shows as it is. */
function dayOf(iso: string): string {
  const day = localDateOf(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? formatDate(day, 'short', day) : iso;
}

/** When the page was made and last changed: two rows of the Info section. */
export function PageDates({ entry }: { entry: Entry }) {
  return (
    <div data-testid="page-dates" className="contents">
      <dt>Created</dt>
      <dd data-testid="page-created">
        <time dateTime={entry.createdAt}>{dayOf(entry.createdAt)}</time>
      </dd>
      <dt>Modified</dt>
      <dd data-testid="page-modified">
        <time dateTime={entry.modifiedAt}>{dayOf(entry.modifiedAt)}</time>
      </dd>
    </div>
  );
}

/**
 * The page's facts, last (M58.1b, M61.8): when it was made and changed, and
 * who changed it — label and value on the property grid, where the old
 * footer said them in sentences. Who changed it needs a vault to ask.
 */
function PageInfo({ entry }: { entry: Entry }) {
  const vaultOpen = useVaultStore((s) => s.vaultPath !== null);
  return (
    <InspectorSection id="info" label="Info" testId="page-info">
      <dl className="cb-inspector-facts">
        <PageDates entry={entry} />
        {vaultOpen && (
          <>
            <dt>Changed by</dt>
            <dd>
              <LastChange entry={entry} />
            </dd>
          </>
        )}
      </dl>
    </InspectorSection>
  );
}

/**
 * The Details panel: folding sections, each under a hairline. A page's sections
 * are its properties (on an agent page, its facts — M55.12), its links and
 * backlinks, what Knowledge holds about it — the record peek's Knowledge,
 * component for component (M52.3) — Access, which agents can change it
 * (M58.6), folded until asked with its count on the header, and Info: when it
 * was made and changed, and who changed it last (M58.1b). An Inbox capture's
 * `organize` section stands in for the properties and comes first, with what
 * Knowledge holds ahead of the links. A concept's details are its provenance,
 * then its links and Info: it has no properties, no Knowledge section and no
 * access rows.
 */
function DetailsPanel({
  entry,
  schema,
  concept,
  organize,
}: {
  entry: Entry;
  schema: Schema;
  concept: Concept | null;
  organize: ReactNode;
}) {
  const info = <PageInfo entry={entry} />;
  if (concept !== null) {
    return (
      <>
        <ConceptDetails concept={concept} />
        <LinkSections entry={entry} />
        {info}
      </>
    );
  }
  const knowledge = (
    <InspectorSection id="knowledge" label="Knowledge">
      <PageKnowledge entry={entry} />
    </InspectorSection>
  );
  const organizing = organize !== undefined && organize !== null && organize !== false;
  const agent = isAgentEntry(entry);
  return (
    <>
      {organizing ? (
        <>
          {organize}
          {knowledge}
          <LinkSections entry={entry} />
        </>
      ) : (
        <>
          <InspectorSection id="properties" label={agent ? 'Agent' : 'Properties'}>
            {agent ? <AgentInfo entry={entry} /> : <DocProperties entry={entry} schema={schema} />}
          </InspectorSection>
          <LinkSections entry={entry} />
          {knowledge}
        </>
      )}
      <InspectorSection
        id="access"
        label="Access"
        defaultOpen={false}
        summary={<AccessSummary entry={entry} />}
      >
        <PageAccess entry={entry} />
      </InspectorSection>
      {info}
    </>
  );
}

/**
 * The page's side panel (M2.x docs polish — Plane's pane pattern), one slot
 * for docs, records, agents, concepts and Inbox captures, showing one panel
 * at a time, each opened by its own button in the toolbar (owner, 2026-10-19
 * — Notion's properties, discussions and updates; `PanelButtons`). It runs
 * the page's full height in the page's frame (components/pageFrame.css),
 * under the toolbar's actions and the Close that leads them.
 *
 * Details is a stack of folding sections, ruled apart, ending with Info
 * (`DetailsPanel`). Comments holds the page's threads (M70.2b). History is
 * `PageHistory` (M64.2b): its versions, each opening the version lens in
 * place of the editor (M58.4, D18), merged with its recorded edits, the runs
 * that wrote it and, on a concept, the ledger's events. The outline is on the
 * page itself (`DocOutline`).
 */
export function DocSidePanel({
  entry,
  schema,
  panel,
  concept = null,
  overlay = false,
  comments = null,
  organize,
  ariaLabel = 'Document panel',
  closing = false,
  ref,
}: {
  entry: Entry;
  schema: Schema;
  /** Which panel it shows: the host holds it (`docPanel`, `inboxPanel`, …). */
  panel: PagePanel;
  /** Set on a concept page: the panel leads with the concept's details. */
  concept?: Concept | null;
  /**
   * Drawn as a drawer over the reading column rather than beside it (M52):
   * the page has no room for both floors, so the panel folded, and the user
   * asked for it anyway. The page decides; the stored open flag is not asked.
   */
  overlay?: boolean;
  /** The page's comments (M70.2b), which the page drives. */
  comments?: PageCommentsController | null;
  /** The Inbox's Organize section: first in Details, in place of the generic
   *  Properties section, which it is the capture's editor for. */
  organize?: ReactNode;
  /** The Details panel's name; Comments and History are named by their titles. */
  ariaLabel?: string;
  /**
   * Closed, and on its way out (`Presence`, components/ui/motion.ts): it
   * plays its exit and takes nothing — no pointer, no focus, no reading.
   */
  closing?: boolean;
  /** The host's hold on it while it leaves. */
  ref?: Ref<HTMLElement>;
}) {
  // A drawer takes focus as it opens — again if it is opened again on its
  // way out, when the same panel simply stays.
  const drawerRef = useDrawerFocus<HTMLElement>(overlay && !closing);
  // It arrives once, as it mounts: a docked panel folding into a drawer, or
  // a pane shown again, replays nothing (pageFrame.css).
  const arrival = useArrival(true);
  const setAside = useCallback(
    (el: HTMLElement | null) => {
      drawerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [drawerRef, ref],
  );
  // Leaving, it lets go of focus first: inert alone moves it nowhere in
  // particular, and a drawer's scrim hands it back to the drawer's opener
  // only when it finds it on nothing (DrawerScrim).
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (
      closing &&
      focused instanceof HTMLElement &&
      drawerRef.current?.contains(focused) === true
    ) {
      focused.blur();
    }
  }, [drawerRef, closing]);
  // A panel changed in place on the same page arrives the way a page does
  // (`data-switched`, inspector.css); the one it opened on came in with the
  // panel itself, and moving to another page with it open replays nothing.
  const [shown, setShown] = useState({ panel, path: entry.path, switched: false });
  if (shown.panel !== panel || shown.path !== entry.path) {
    setShown({ panel, path: entry.path, switched: shown.path === entry.path });
  }
  const switched = shown.switched;
  // Counted once the threads are read, and only when there are any open.
  const openComments = comments?.slot?.kind === 'ready' ? (comments.sections?.openCount ?? 0) : 0;

  return (
    <aside
      ref={setAside}
      data-testid="doc-side-panel"
      data-panel={panel}
      data-state={closing ? 'closed' : 'open'}
      data-switched={switched || undefined}
      {...arrival}
      aria-label={panel === 'details' ? ariaLabel : PANEL_LABELS[panel]}
      data-overlay={overlay || undefined}
      tabIndex={overlay ? -1 : undefined}
      inert={closing || undefined}
      className="cb-inspector"
    >
      {/* Details opens on its sections, each headed; the other two are one
          list each, under a title that says which panel this is. Keyed by
          the panel, so a switch remounts them and they play their arrival. */}
      {panel !== 'details' && (
        <div key={`title:${panel}`} className="cb-inspector-title">
          <h2>{PANEL_LABELS[panel]}</h2>
          {panel === 'comments' && openComments > 0 && (
            <span title={`${openComments} open comments`} className="cb-inspector-title-count">
              {openComments}
            </span>
          )}
        </div>
      )}
      <div key={`body:${panel}`} className="cb-inspector-body">
        {panel === 'details' && (
          <DetailsPanel entry={entry} schema={schema} concept={concept} organize={organize} />
        )}
        {/* Each pane names itself, so inspector.css fits the panel it holds
            to the slot's gutter here and nowhere else it is drawn. */}
        {panel === 'comments' && comments !== null && (
          <div className="cb-inspector-pane" data-pane="comments">
            <CommentsPanel controller={comments} />
          </div>
        )}
        {panel === 'history' && (
          <div className="cb-inspector-pane" data-pane="history">
            <PageHistory path={entry.path} />
          </div>
        )}
      </div>
    </aside>
  );
}
