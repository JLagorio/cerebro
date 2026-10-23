import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useArrival, useGhostOnUnmount } from '@/components/ui/motion';
import { chipOf, type ChipStatus } from '@/engine/ai/threadStatus';
import { placeKey } from '@/engine/place';
import { useThreadStatuses, type TurnFlags } from '@/agent/threadStatusStore';
import type { Conversation } from '@/agent/types';
import type { ConversationState } from '@/agent/useConversations';
import { useVaultStore } from '@/stores/vaultStore';

/** The list's words for a thread's status (M92.7): its two chips, short
 * enough for the row's place line, and the one line under the heading when
 * a status could not be read. */
export const THREAD_STATUS_WORDS = {
  working: 'Working',
  needs_you: 'Needs you',
  unavailable: 'Status unavailable',
} as const;

/**
 * Pick, rename, or delete a conversation (M9.5).
 *
 * The panel used to have one thread and a reset button that erased it. The
 * transcript of "help me clear the Inbox" is worth keeping around at least
 * as long as the Inbox is not clear.
 *
 * M17.5 groups the list by PLACE. Threads had here come first, under a heading
 * naming the place; everything else follows in the order it always had, each
 * row labelled with where it happened. Grouping rather than filtering, on
 * purpose: a list that hid the rest would make "which thread was that in?"
 * unanswerable from the one place you are sure to look.
 *
 * M92.7 marks a thread whose turn is working or waiting on the person, in
 * the list only (Q7): `useThreadStatuses` reads them while the list shows,
 * the open thread's from `turn`, its chat's own flags, when the panel hands
 * them over. A status nobody can tell draws nothing; one that could not be
 * read says so once, under the heading.
 */
export function ConversationSwitcher({
  state,
  navigation = false,
  turn,
}: {
  state: ConversationState;
  navigation?: boolean;
  turn?: TurnFlags;
}) {
  const [open, setOpen] = useState(false);
  const vault = useVaultStore((s) => s.vaultPath);
  const { statuses, unavailable } = useThreadStatuses(
    state.conversations,
    state.activeId,
    turn,
    vault,
    navigation || open,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // M15: deleting was one hover-revealed click, 4px from the rename pencil,
  // against the only copy of a transcript (localStorage — deliberately not the
  // vault). The row asks first now; there is nothing to undo it with.
  const [confirming, setConfirming] = useState<string | null>(null);

  const commit = (id: string) => {
    state.rename(id, draft);
    setRenaming(null);
  };

  // `ordered` has already sorted; partitioning preserves that order within
  // each group, so "here" is the same list it always was, lifted to the top.
  //
  // An UNANCHORED thread counts as here. A thread is stamped at its first turn,
  // so an unanchored one is a blank one — it is about to be about wherever you
  // are, and filing it under "elsewhere" would put the thread you are typing
  // into below the ones you are not.
  const sections = useMemo(() => {
    const key = placeKey(state.here);
    const here = state.conversations.filter((c) => c.place == null || placeKey(c.place) === key);
    const rest = state.conversations.filter((c) => !here.includes(c));
    return [
      { id: 'here', label: state.hereLabel, rows: here },
      // Unlabelled: with nothing above it this is just "the conversations",
      // and a heading over the only group is a heading about nothing.
      { id: 'rest', label: here.length > 0 ? 'Elsewhere' : null, rows: rest },
    ].filter((s) => s.rows.length > 0);
  }, [state.conversations, state.here, state.hereLabel]);

  // A function returning JSX rather than a component: it closes over the four
  // pieces of row-editing state above, and lifting it out would mean threading
  // all of them back in through props.
  const row = (c: Conversation) => (
    <div
      key={c.id}
      data-testid="conversation-row"
      data-thread-status={statuses.get(c.id) ?? 'unknown'}
      className={[
        'cb-conversation-row motion-hover group flex items-center gap-1 rounded-md px-2 py-1',
        c.id === state.activeId ? 'bg-cortex-50' : 'hover:bg-n-50',
      ].join(' ')}
    >
      {confirming === c.id ? (
        <>
          <span className="min-w-0 flex-1 truncate text-xs text-n-600">Delete “{c.title}”?</span>
          <button
            type="button"
            data-testid="confirm-delete"
            aria-label={`Confirm delete ${c.title}`}
            onClick={() => {
              setConfirming(null);
              state.remove(c.id);
            }}
            className="flex-none rounded-xs border-0 bg-transparent px-1 py-0.5 text-xs font-medium text-danger-600 hover:bg-danger-50"
          >
            Delete
          </button>
          <button
            type="button"
            aria-label="Keep conversation"
            onClick={() => setConfirming(null)}
            className="flex-none rounded-xs border-0 bg-transparent px-1 py-0.5 text-xs text-n-500 hover:bg-n-100"
          >
            Keep
          </button>
        </>
      ) : renaming === c.id ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(c.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(c.id);
            if (e.key === 'Escape') setRenaming(null);
          }}
          aria-label={`Rename ${c.title}`}
          className="min-w-0 flex-1 rounded-xs border border-cortex-400 bg-n-0 px-1 py-0.5 text-xs outline-none"
        />
      ) : (
        <>
          <button
            type="button"
            aria-current={c.id === state.activeId ? true : undefined}
            onClick={() => {
              state.select(c.id);
              setOpen(false);
            }}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-left text-sm text-n-800"
          >
            <span className="block truncate">
              {c.title}
              {c.messages.length > 0 && (
                <span className="ml-1.5 text-2xs text-n-400">
                  {c.messages.filter((m) => m.role === 'user').length}
                </span>
              )}
            </span>
            {/* Where it happened, on the row itself. The heading above says it
                too for the "here" group, but a thread found by scrolling has
                nothing else to say what it was about (M17.5). */}
            <PlaceLine chip={chipOf(statuses.get(c.id) ?? 'unknown')} place={c.placeLabel} />
          </button>
          <span className="hidden gap-0.5 group-hover:inline-flex group-focus-within:inline-flex">
            <button
              type="button"
              aria-label={`Rename ${c.title}`}
              onClick={() => {
                setDraft(c.title);
                setRenaming(c.id);
              }}
              className="rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
            >
              <Icon name="pencil" size={11} />
            </button>
            <button
              type="button"
              aria-label={`Delete ${c.title}`}
              onClick={() => setConfirming(c.id)}
              className="rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-danger-700"
            >
              <Icon name="trash-2" size={11} />
            </button>
          </span>
        </>
      )}
    </div>
  );

  return (
    <div
      className={navigation ? 'cb-conversation-nav' : 'relative inline-flex min-w-0'}
      role={navigation ? 'navigation' : undefined}
      aria-label={navigation ? 'Conversations' : undefined}
    >
      {!navigation && (
        <button
          type="button"
          data-testid="conversation-switcher"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="cb-conversation-switcher motion-hover inline-flex min-w-0 items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-600 hover:bg-n-50 hover:text-n-900"
        >
          <span className="max-w-[150px] truncate">{state.active?.title ?? 'Assistant'}</span>
          <Icon name="chevron-down" size={11} className="cb-conversation-chevron" />
        </button>
      )}
      {(navigation || open) && (
        <>
          {!navigation && (
            <button
              type="button"
              aria-label="Close conversations"
              onClick={() => setOpen(false)}
              onWheel={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
            />
          )}
          <SwitcherList navigation={navigation}>
            {navigation && <div className="cb-conversation-nav-heading">Conversations</div>}
            {/* Once for the list, never a quiet one (CV-05): a thread whose
                status could not be read draws no chip, so this says why. */}
            {unavailable && (
              <p data-testid="section-unavailable" className="m-0 px-2 pb-2 text-2xs text-n-500">
                {THREAD_STATUS_WORDS.unavailable}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                state.start();
                setOpen(false);
              }}
              className="cb-conversation-new motion-hover mb-1 flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-left text-sm text-n-700 hover:bg-n-50"
            >
              <Icon name="plus" size={12} color="var(--n-500)" />
              New conversation
            </button>
            <div
              className={
                navigation
                  ? 'cb-conversation-nav-list'
                  : 'max-h-[280px] overflow-y-auto border-t border-n-100 pt-1'
              }
            >
              {sections.map((section) => (
                <div key={section.id}>
                  {section.label !== null && (
                    <div
                      data-testid="conversation-group"
                      className="cb-conversation-group truncate px-2 pb-0.5 pt-1 text-2xs font-medium uppercase tracking-wide text-n-400"
                    >
                      {section.label}
                    </div>
                  )}
                  {section.rows.map(row)}
                </div>
              ))}
            </div>
          </SwitcherList>
        </>
      )}
    </div>
  );
}

/**
 * The list of conversations: the canvas sidebar's column, or the header's
 * menu. The menu grows from under its title as Popover's menus do, once as
 * it opens — an arrival, so the conversation unfolding from its button with
 * the menu still open plays nothing again — and closed, a copy of it fades
 * where it was (components/ui/motion.ts) while the real one, and the
 * click-away behind it, go at once.
 */
function SwitcherList({ navigation, children }: { navigation: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const arrival = useArrival(!navigation);
  useGhostOnUnmount(ref, 'cb-popover-leave', { when: !navigation });
  return (
    <div
      ref={ref}
      className={
        navigation
          ? 'cb-conversation-nav-content'
          : 'cb-conversation-menu absolute left-0 top-6 z-50 w-[260px] rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]'
      }
      {...arrival}
    >
      {children}
    </div>
  );
}

/**
 * A row's second line: where the thread happened (M17.5), led by its chip
 * when it has one (M92.7). Inside the row's button, so the button's name
 * says the status, and ahead of the place, which truncates first; the hover
 * actions sit beside the button, never over it.
 */
function PlaceLine({ chip, place }: { chip: ChipStatus | null; place: string | undefined }) {
  if (chip === null) {
    return place === undefined ? null : (
      <span className="block truncate text-2xs text-n-400">{place}</span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-2xs text-n-400">
      <ThreadChip status={chip} />
      {place !== undefined && (
        <>
          {' '}
          <span className="min-w-0 truncate">{place}</span>
        </>
      )}
    </span>
  );
}

/**
 * A thread's chip (M92.7), in a few words. Working turns, and stands still
 * under reduced motion (`.animate-spin`, styles/index.css); Needs you is the
 * dot the minimized assistant wears while a card waits.
 */
function ThreadChip({ status }: { status: ChipStatus }) {
  return (
    <span
      data-testid="thread-status"
      data-status={status}
      className="inline-flex flex-none items-center gap-1 text-n-600"
    >
      {status === 'working' ? (
        <span className="inline-flex animate-spin" aria-hidden="true">
          <Icon name="loader-circle" size={10} color="var(--text-ai)" />
        </span>
      ) : (
        <span className="size-1.5 flex-none rounded-full bg-warn-500" aria-hidden="true" />
      )}
      {THREAD_STATUS_WORDS[status]}
    </span>
  );
}

/** The canvas sidebar uses the panel's existing conversation state through a
 * portal. It never starts a second conversation controller or live turn. */
export function ConversationNavigation({
  state,
  turn,
}: {
  state: ConversationState;
  turn?: TurnFlags;
}) {
  return <ConversationSwitcher state={state} navigation turn={turn} />;
}
