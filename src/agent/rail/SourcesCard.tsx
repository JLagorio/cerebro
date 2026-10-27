import { memo, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { RailSection } from '@/components/ai/Rail';
import { SOURCES_WORDS, sourceHost, sourceName } from '@/components/ai/Sources';
import { vaultPathOf } from '@/components/ai/StepLine';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { Icon } from '@/components/ui/Icon';
import { motionAllowed } from '@/components/ui/motion';
import { Popover } from '@/components/ui/Popover';
import { StateMessage } from '@/components/ui/StateMessage';
import { Tooltip } from '@/components/ui/Tooltip';
import type { RailSources, RailSourcesMissing } from '@/agent/elements/railSources';
import { openOutside } from '@/agent/rail/ConversationRail';
import { httpUrl, sourceKey, type CitedSource } from '@/engine/ai/sources';
import type { SourceRef } from '@/engine/ai/types';
import { useVaultStore } from '@/stores/vaultStore';
import './sources-card.css';

/**
 * The rail's Sources card (M92.6, Q15): what the conversation drew on
 * (`railSources`), the latest reply's first. Five lines, then "View all",
 * which opens the whole list in a layer over the canvas (`rail-sources-all`,
 * a layer of layers.ts, so Escape closes it and hands focus back to the
 * button that opened it). The Knowledge the next turn carries is not here:
 * it stays by the composer, as context, not a source.
 *
 * A line's own action stays in the canvas (§1): it jumps to the reply that
 * drew on the source, to the Sources line under it, closing the drawer first
 * when the rail is one. Its way out sits at its end: a web page is a link the
 * shell hands to the browser (CV-16); a vault page opens in the app, never
 * through an href, and the conversation floats first, since the canvas hides
 * the page it opens. Every control is a tab stop of its own (WebKit skips a
 * native button without one).
 *
 * A list that may be short says why above it (CV-05). With nothing listed,
 * the card never reads "None" for what it cannot tell: not recorded, with
 * that reason, where a reply lost what it drew on, and unavailable where the
 * transcript could not be read back at all.
 */

/** The card's words. */
export const RAIL_SOURCES_WORDS = {
  title: 'Sources',
  viewAll: (count: number) => `View all (${count})`,
  /** Before a line's name: where its own action goes. */
  jump: 'Jump to the reply that used ',
  open: 'Open ',
  /** After a vault page's name: opening it floats the conversation. */
  leaves: ' (leaves full screen)',
  /** Why the list may be short (CV-05). */
  missing: {
    transcript: "The transcript couldn't be read back, so some sources may be missing.",
    steps: "A subagent's steps weren't kept, so what it used isn't listed.",
    results: "Some web results weren't kept, so they aren't listed.",
  } satisfies Record<RailSourcesMissing, string>,
  notRecorded: 'Sources not recorded',
  unavailable: 'Sources unavailable',
  unavailableDetail: "This conversation's transcript couldn't be read back.",
} as const;

/** The lines the card lists before "View all". */
export const RAIL_SOURCES_SHOWN = 5;

export interface SourcesCardProps {
  /** The conversation's sources (`railSources`). */
  sources: RailSources;
  /** The rail is folded away (M92.1): it opens no layer, and one open
   *  closes. */
  folded: boolean;
  /** The rail's: closes a drawer without handing focus back, then runs
   *  `go`. */
  jump: (go: () => void) => void;
  /** Open a page of the vault: a vault line's way out (CV-16). */
  onOpenPath: (path: string) => void;
  /** Bring a transcript element into view: the host's transcript scroller,
   *  which keeps a streaming turn from pulling the reader back. Left out,
   *  the browser scrolls it into view. */
  reveal?: (element: HTMLElement) => void;
}

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Where a jump to the reply `turn` lands: the Sources line under it, which
 * lists the source, and its fold to focus; the reply itself, where it draws
 * no such line. Null when the transcript does not draw the reply.
 */
function replyIn(
  scope: ParentNode,
  turn: string,
): { at: HTMLElement; focus: HTMLElement | null } | null {
  const reply = [...scope.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (row) => row.dataset.messageId === turn,
  );
  if (reply === undefined) return null;
  const line = reply.querySelector<HTMLElement>('[data-testid="turn-sources"]');
  if (line === null) return { at: reply, focus: null };
  const focus =
    [...line.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
      (control) => control.closest('[hidden]') === null,
    ) ?? null;
  return { at: line, focus };
}

/** Scroll to the reply `turn` and focus it, once. */
function revealReply(
  scope: ParentNode,
  turn: string,
  reveal: ((element: HTMLElement) => void) | undefined,
): void {
  const found = replyIn(scope, turn);
  if (found === null) return;
  if (reveal !== undefined) reveal(found.at);
  // jsdom has no scrollIntoView.
  else
    found.at.scrollIntoView?.({ block: 'center', behavior: motionAllowed() ? 'smooth' : 'auto' });
  found.focus?.focus({ preventScroll: true });
}

/** A vault page as the transcript's Sources line names it: by the title the
 *  vault holds for it, when the reply gave it none. */
function titled(source: SourceRef, titles: ReadonlyMap<string, string>): SourceRef {
  if (source.kind !== 'vault' || source.title !== undefined) return source;
  const title = titles.get(source.path);
  return title === undefined ? source : { ...source, title };
}

/** What a line's actions need, the same for the card and its layer. */
interface LineActions {
  titles: ReadonlyMap<string, string>;
  onJump: (turn: string) => void;
  onOpenPath: (path: string) => void;
}

export const SourcesCard = memo(function SourcesCard({
  sources,
  folded,
  jump,
  onOpenPath,
  reveal,
}: SourcesCardProps) {
  const entries = useVaultStore((s) => s.entries);
  const titles = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.title])),
    [entries],
  );
  const [all, setAll] = useState(false);
  const layerId = useId();
  const own = useRef<HTMLElement | null>(null);
  const viewAll = useRef<HTMLButtonElement | null>(null);
  const { cited, missing, state } = sources;
  const more = cited.length > RAIL_SOURCES_SHOWN;
  // A folded rail is hidden and inert: its layer goes with it, and stays
  // shut when the rail unfolds.
  if (all && (folded || !more)) setAll(false);
  const actions: LineActions = {
    titles,
    onJump: (turn) => {
      // The rail is the panel's aside's third area (M92.1): the transcript a
      // reply is shown in is the aside's own. The layer is portalled, so the
      // card says where it stands.
      const scope: ParentNode = own.current?.closest('aside') ?? document;
      setAll(false);
      jump(() => revealReply(scope, turn, reveal));
    },
    onOpenPath,
  };
  return (
    <RailSection
      ref={own}
      data-testid="rail-sources"
      title={RAIL_SOURCES_WORDS.title}
      icon="book-open"
      count={cited.length > 0 ? String(cited.length) : undefined}
      state={state}
    >
      {state === 'unavailable' ? (
        <StateMessage compact state="unavailable" title={RAIL_SOURCES_WORDS.unavailable}>
          {RAIL_SOURCES_WORDS.unavailableDetail}
        </StateMessage>
      ) : state === 'not-recorded' && missing !== null ? (
        <StateMessage compact state="not-recorded" title={RAIL_SOURCES_WORDS.notRecorded}>
          <MissingLine missing={missing} />
        </StateMessage>
      ) : (
        missing !== null && <MissingLine missing={missing} />
      )}
      {cited.length > 0 && (
        <SourceLines cited={cited.slice(0, RAIL_SOURCES_SHOWN)} actions={actions} />
      )}
      {more && (
        <button
          ref={viewAll}
          type="button"
          tabIndex={0}
          data-testid="rail-sources-view-all"
          className="cb-rail-sources-more"
          aria-haspopup="dialog"
          aria-expanded={all}
          // The layer is portalled, out of this button's subtree.
          aria-controls={all ? layerId : undefined}
          onClick={(event) => {
            // WebKit leaves a pressed button unfocused, and the layer hands
            // focus back to what held it as it opened.
            event.currentTarget.focus();
            setAll(!all);
          }}
        >
          {RAIL_SOURCES_WORDS.viewAll(cited.length)}
        </button>
      )}
      {all && (
        <AllSources
          id={layerId}
          anchor={viewAll}
          cited={cited}
          missing={missing}
          actions={actions}
          onClose={() => setAll(false)}
        />
      )}
    </RailSection>
  );
});

/** Why the list may be short, above it. */
function MissingLine({ missing }: { missing: RailSourcesMissing }) {
  return (
    <p
      data-testid="rail-sources-missing"
      data-missing={missing}
      className="cb-rail-sources-missing"
    >
      {RAIL_SOURCES_WORDS.missing[missing]}
    </p>
  );
}

/**
 * The whole list (`rail-sources-all`): a layer anchored to "View all",
 * holding the keyboard while it is open. Escape and a press outside close
 * it, and closing hands focus back to "View all" (Popover). A streaming
 * transcript scrolls under it, so a scroll moves it with its anchor instead
 * of closing it.
 */
function AllSources({
  id,
  anchor,
  cited,
  missing,
  actions,
  onClose,
}: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  cited: readonly CitedSource[];
  missing: RailSourcesMissing | null;
  actions: LineActions;
  onClose: () => void;
}) {
  const headingId = useId();
  return (
    <Popover
      id={id}
      anchorRef={anchor}
      onClose={onClose}
      role="dialog"
      ariaLabelledBy={headingId}
      trapFocus
      closeOnScroll={false}
      className="cb-rail-sources-layer"
    >
      <div data-testid="rail-sources-all" className="cb-rail-sources-all">
        <h2 id={headingId} className="cb-rail-sources-all-heading">
          {RAIL_SOURCES_WORDS.title}{' '}
          <span className="cb-rail-sources-all-count">{cited.length}</span>
        </h2>
        {missing !== null && <MissingLine missing={missing} />}
        <SourceLines cited={cited} actions={actions} />
      </div>
    </Popover>
  );
}

function SourceLines({ cited, actions }: { cited: readonly CitedSource[]; actions: LineActions }) {
  return (
    <ul className="cb-rail-sources">
      {cited.map((line) => (
        // Merged by sourceKey, so a source is one line.
        <SourceLine key={sourceKey(line.source)} line={line} actions={actions} />
      ))}
    </ul>
  );
}

/** One source: a jump to the reply that drew on it, then its way out. A web
 *  page names its host after its title, as the transcript's line does. */
function SourceLine({ line, actions }: { line: CitedSource; actions: LineActions }) {
  const source = titled(line.source, actions.titles);
  const name = sourceName(source);
  const host = source.kind === 'url' ? sourceHost(source.url) : null;
  return (
    <li
      data-testid="rail-source"
      data-kind={source.kind}
      data-turn={line.turn}
      className="cb-rail-source"
    >
      <button
        type="button"
        tabIndex={0}
        data-testid="rail-source-jump"
        className="cb-rail-source-jump"
        onClick={() => actions.onJump(line.turn)}
      >
        <TraceLine>
          <TraceIcon>
            <Icon name={source.kind === 'url' ? 'globe' : 'file-text'} size={16} />
          </TraceIcon>
          <TraceTitle>
            <span className="sr-only">{RAIL_SOURCES_WORDS.jump}</span>
            {name}
          </TraceTitle>
          {host !== null && host !== name && <TraceDescription>{host}</TraceDescription>}
        </TraceLine>
      </button>
      <OpenSource source={source} name={name} onOpenPath={actions.onOpenPath} />
    </li>
  );
}

/**
 * A source's way out, or nothing for one no control may open. Only an
 * http(s) address is an href, which the shell hands to the browser; a vault
 * page opens through the caller, after the conversation floats (CV-16).
 */
function OpenSource({
  source,
  name,
  onOpenPath,
}: {
  source: SourceRef;
  name: string;
  onOpenPath: (path: string) => void;
}) {
  if (source.kind === 'url') {
    const url = httpUrl(source.url);
    if (url === null) return null;
    const label = `${RAIL_SOURCES_WORDS.open}${name}${SOURCES_WORDS.newTab}`;
    return (
      <Tooltip label={label}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          tabIndex={0}
          aria-label={label}
          data-testid="rail-source-open"
          className="cb-rail-source-open"
        >
          <Icon name="arrow-up-right" size={14} />
        </a>
      </Tooltip>
    );
  }
  const path = vaultPathOf(source.path);
  if (path === null) return null;
  const label = `${RAIL_SOURCES_WORDS.open}${name}${RAIL_SOURCES_WORDS.leaves}`;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        tabIndex={0}
        aria-label={label}
        data-testid="rail-source-open"
        className="cb-rail-source-open"
        onClick={() => openOutside(() => onOpenPath(path))}
      >
        <Icon name="arrow-up-right" size={14} />
      </button>
    </Tooltip>
  );
}
