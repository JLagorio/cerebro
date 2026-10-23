import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { listInteractions, onAgentEvent, onRunStarted, runState } from '@/agent/agentIpc';
import type { AgentEvent, Conversation, LiveTurn } from '@/agent/types';
import {
  listUnavailable,
  statusOf,
  type CardBook,
  type CardRef,
  type RunState,
  type ThreadStatus,
} from '@/engine/ai/threadStatus';

/**
 * What the conversation list knows of each thread's turn (M92.7, §2), in
 * memory only: the cards waiting on the person, as `list_interactions` last
 * answered, and each run a thread left going, as Rust's journal answers for
 * it (`runState`). `statusOf` (engine/ai/threadStatus.ts) ranks them under
 * the open thread's own flags.
 *
 * It learns from one listener, bound once for the app's life: a run's start
 * (`onRunStarted`), its Interaction and its Done, never a token. A start
 * pairs the run's process tag with its attach key, as does the journal
 * answering for that pair, so the card an Interaction announces is filed
 * under the run that asked, which is how a thread left before its run's
 * Init, holding no session, still finds its card; and a Done ends that run's
 * Working whether or not anyone watches it. A tag no pair names names
 * nothing: the next launch numbers its runs again. A start and an
 * Interaction read the book again, since a send refuses the calls its
 * session left waiting, an answer's resume takes its card off, and an
 * Interaction puts one on.
 *
 * Nothing here is saved. After a restart the journal holds none of the runs
 * a thread left going, so they read unknown and draw no chip: nothing infers
 * Working (CV-05).
 */

/** A run a thread left going, by the pair that names it. */
type Turn = Pick<LiveTurn, 'run' | 'attach'>;

/** What a thread's status is read from: its id, its session, and the run
 * its live turn names, by tag and attach key. */
type Fact = [id: string, sessionId: string | null, run: number | null, attach: string | null];

/** The open thread's own flags (`useAgentChat`): its turn is in flight, a
 * turn waiting on a card included, or it waits on a card. */
export interface TurnFlags {
  streaming: boolean;
  waiting: boolean;
}

interface ThreadStatusState {
  /** The vault whose book is read; null until a list asks. */
  vault: string | null;
  /** The cards waiting on the person in `vault`, as the book last answered:
   * unread until its first answer lands, and that answer until the next. */
  book: CardBook;
  /** What the journal answered for each run, by its attach key. */
  runs: Readonly<Record<string, RunState>>;
  /** Listen, once for the app's life, and read the book of `vault` from
   * now on: another vault's book is unread again. */
  watch(vault: string | null): void;
  /** Read the book again. */
  readCards(): void;
  /** Ask the journal about each of `turns` with no answer yet, or whose
   * read failed; one read per run at a time. */
  readRuns(turns: readonly Turn[]): void;
}

/** The most runs, starts and card askers held; past it, the oldest goes. */
export const THREAD_STATUS_HELD = 256;

/** A run never starts again, so a run read done or unknown stays so,
 * whatever a read sent before that answers after it. */
const FINAL: ReadonlySet<RunState> = new Set<RunState>(['done', 'unknown']);

/** The attach key of each run whose start was heard, or whose pair the
 * journal answered for, by its process tag. */
const started = new Map<number, string>();
/** Tags whose Done came before their start was heard. */
const endedFirst = new Map<number, true>();
/** The attach key of the run that asked each card, by the card's id. */
const askedBy = new Map<string, string>();
/** The tag of the run that asked each card while its pair was not known. */
const askedByTag = new Map<string, number>();
/** Runs with a read in flight, by attach key. */
const reading = new Set<string>();
/** Bumped by every book read, so only the latest one lands. */
let cardsRead = 0;
/** Bumped by a reset, so no read sent before it lands after it. */
let generation = 0;
let bound = false;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= THREAD_STATUS_HELD) break;
    map.delete(oldest);
  }
}

const sameCards = (a: readonly CardRef[], b: readonly CardRef[]): boolean =>
  a.length === b.length &&
  a.every((card, at) => card.sessionId === b[at].sessionId && card.run === b[at].run);

export const useThreadStatusStore = create<ThreadStatusState>()((set, get) => ({
  vault: null,
  book: { state: 'unread' },
  runs: {},
  watch: (vault) => {
    listen();
    if (get().vault === vault) return;
    cardsRead += 1;
    set({ vault, book: { state: 'unread' } });
  },
  readCards: () => {
    const { vault } = get();
    if (vault === null) return;
    cardsRead += 1;
    const read = cardsRead;
    const lands = () => read === cardsRead && get().vault === vault;
    listInteractions(vault).then(
      (pending) => {
        if (!lands()) return;
        const cards = pending.map((card): CardRef => {
          const run = askedBy.get(card.id);
          return run === undefined
            ? { sessionId: card.session_id }
            : { sessionId: card.session_id, run };
        });
        set((s) =>
          s.book.state === 'read' && sameCards(s.book.cards, cards)
            ? s
            : { book: { state: 'read', cards } },
        );
      },
      () => {
        if (!lands()) return;
        set((s) => (s.book.state === 'unavailable' ? s : { book: { state: 'unavailable' } }));
      },
    );
  },
  readRuns: (turns) => {
    const sent = generation;
    for (const turn of turns) {
      const answered = get().runs[turn.attach];
      if ((answered !== undefined && answered !== 'unavailable') || reading.has(turn.attach)) {
        continue;
      }
      reading.add(turn.attach);
      const settle = (answer: RunState) => {
        if (sent !== generation) return;
        reading.delete(turn.attach);
        let state = answer;
        // An answer for this tag under this key vouches for the pair: the
        // run's Done ends it from now on, and a Done heard while the pair was
        // not yet known already has; so has a card it asked meanwhile.
        if (answer === 'running' || answer === 'done') {
          if (pair(turn) > 0) get().readCards();
          if (endedFirst.delete(turn.run)) state = 'done';
        }
        file(turn.attach, state);
      };
      runState(turn).then(settle, () => settle('unavailable'));
    }
  },
}));

/** File what is known of the run `attach`: done and unknown stand. */
function file(attach: string, state: RunState): void {
  useThreadStatusStore.setState((s) => {
    const was = s.runs[attach];
    if (was === state || (was !== undefined && FINAL.has(was))) return s;
    const runs: Record<string, RunState> = { ...s.runs };
    delete runs[attach];
    runs[attach] = state;
    const keys = Object.keys(runs);
    for (const key of keys.slice(0, Math.max(0, keys.length - THREAD_STATUS_HELD))) {
      delete runs[key];
    }
    return { runs };
  });
}

/** File the pair that names `turn`, and the run's cards asked before it was
 * known; how many such cards there were. */
function pair(turn: Turn): number {
  remember(started, turn.run, turn.attach);
  let filed = 0;
  for (const [card, tag] of askedByTag) {
    if (tag !== turn.run) continue;
    askedByTag.delete(card);
    remember(askedBy, card, turn.attach);
    filed += 1;
  }
  return filed;
}

/** A run this window started: going, unless its Done came first. */
function begun(turn: Turn): void {
  pair(turn);
  const ended = endedFirst.delete(turn.run);
  file(turn.attach, ended ? 'done' : 'running');
  useThreadStatusStore.getState().readCards();
}

/** One event of any run: only an Interaction and a Done are heard. */
function heard(event: AgentEvent): void {
  if (event.kind === 'Interaction') {
    const attach = started.get(event.run);
    if (attach !== undefined) remember(askedBy, event.interaction.id, attach);
    else remember(askedByTag, event.interaction.id, event.run);
    useThreadStatusStore.getState().readCards();
    return;
  }
  if (event.kind !== 'Done') return;
  const attach = started.get(event.run);
  if (attach === undefined) remember(endedFirst, event.run, true);
  else file(attach, 'done');
}

function listen(): void {
  if (bound) return;
  bound = true;
  onRunStarted(begun);
  onAgentEvent(heard);
}

/** Forget everything heard and read, as a restart does; the listener stays.
 * The lab and the tests start each case here. */
export function resetThreadStatus(): void {
  generation += 1;
  cardsRead += 1;
  started.clear();
  endedFirst.clear();
  askedBy.clear();
  askedByTag.clear();
  reading.clear();
  useThreadStatusStore.setState({ vault: null, book: { state: 'unread' }, runs: {} });
}

/** Each listed thread's status, and whether the list says its statuses are
 * unavailable, under its heading. */
export interface ThreadStatuses {
  statuses: ReadonlyMap<string, ThreadStatus>;
  unavailable: boolean;
}

/**
 * The status of each of `conversations` (M92.7): the open thread's by its
 * own `turn` flags when the panel hands them over, every other thread's by
 * the book and the journal. Listens from the first call on; reads only while
 * the list is `shown`: the book as it opens, again as a thread leaves the
 * open slot or a turn starts or ends, and each run left going that has no
 * answer yet. Statuses change only as the book or a run's answer does, so a
 * streaming reply never reads anything.
 */
export function useThreadStatuses(
  conversations: readonly Conversation[],
  activeId: string,
  turn: TurnFlags | undefined,
  vault: string | null,
  shown: boolean,
): ThreadStatuses {
  const watch = useThreadStatusStore((s) => s.watch);
  const readCards = useThreadStatusStore((s) => s.readCards);
  const readRuns = useThreadStatusStore((s) => s.readRuns);
  const book = useThreadStatusStore((s) => s.book);

  // What a status is read from, as strings: a list rebuilt with the same
  // facts, as every render of a streaming reply rebuilds it, reads as the
  // same list, so it reads nothing again and its statuses stay the same Map.
  const factsKey = JSON.stringify(
    conversations.map((c): Fact => [
      c.id,
      c.sessionId,
      c.live?.run ?? null,
      c.live?.attach ?? null,
    ]),
  );
  const facts = useMemo(() => JSON.parse(factsKey) as Fact[], [factsKey]);
  const turns = useMemo(
    () =>
      facts.flatMap(([, , run, attach]): Turn[] =>
        run === null || attach === null ? [] : [{ run, attach }],
      ),
    [facts],
  );
  const answers = useThreadStatusStore(useShallow((s) => turns.map((t) => s.runs[t.attach])));

  useEffect(() => watch(vault), [watch, vault]);
  // The book again whenever who could hold a card changes: a thread that
  // leaves the open slot, a turn that starts or ends, a session named; and
  // with it any run not yet answered, or whose read failed.
  useEffect(() => {
    if (shown) readCards();
  }, [readCards, shown, vault, factsKey, activeId]);
  useEffect(() => {
    if (shown) readRuns(turns);
  }, [readRuns, shown, turns, activeId]);

  const streaming = turn?.streaming;
  const waiting = turn?.waiting;
  const statuses = useMemo(() => {
    const answered = new Map(turns.map((t, at) => [t.attach, answers[at]] as const));
    const out = new Map<string, ThreadStatus>();
    for (const [id, sessionId, , attach] of facts) {
      const active =
        id === activeId && streaming !== undefined && waiting !== undefined
          ? { active: { streaming, waiting } }
          : {};
      const state = attach === null ? undefined : answered.get(attach);
      out.set(
        id,
        statusOf(
          {
            ...active,
            sessionId,
            liveRun: attach,
            ...(state === undefined ? {} : { runState: state }),
          },
          book,
        ),
      );
    }
    return out;
  }, [facts, activeId, streaming, waiting, turns, answers, book]);
  const unavailable = useMemo(() => listUnavailable(statuses.values(), book), [statuses, book]);
  return { statuses, unavailable };
}
