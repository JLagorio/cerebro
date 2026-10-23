import { useMemo } from 'react';
import { mockJournal } from '@/agent/agentIpc';
import { ConversationNavigation, THREAD_STATUS_WORDS } from '@/agent/ConversationSwitcher';
import {
  confirmMockInteraction,
  registerMockInteraction,
  resetMockInteractions,
} from '@/agent/mockInteractions';
import { resetThreadStatus } from '@/agent/threadStatusStore';
import type { Conversation, LiveTurn } from '@/agent/types';
import type { ConversationState } from '@/agent/useConversations';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The conversation list's status chips (M92.7) in their five states: the
 * canvas sidebar's list over the mock's journal (`agent_events_since`, which
 * `runState` reads for each run a thread left going) and its book
 * (`list_interactions`). Working where a thread's run goes on, Needs you
 * where a card waits for it; nothing where nobody can tell, as after a
 * restart; one line under the heading where a read failed.
 *
 * Synthetic: made-up sessions, and run numbers far past any the lab starts.
 * Each preset forgets what the list heard before it, as a restart does.
 */

const OPEN: Conversation = thread('lab-open', 'What changed this week?', {
  sessionId: '00000000-0000-4000-8000-000000092701',
});
const IDLE: Conversation = thread('lab-idle', 'Summarize the roadmap', {
  sessionId: '00000000-0000-4000-8000-000000092702',
});
const ASKING_SESSION = '00000000-0000-4000-8000-000000092703';
const ASKING: Conversation = thread('lab-asking', 'Draft the release note', {
  sessionId: ASKING_SESSION,
});

/** The threads the stage lists, the first one open. */
let staged: Conversation[] = [OPEN];

function thread(id: string, title: string, over: Partial<Conversation>): Conversation {
  return {
    id,
    title,
    usesDefaultTitle: false,
    sessionId: null,
    messages: [],
    createdAt: '2026-10-23T09:00:00Z',
    archived: false,
    place: null,
    placeLabel: 'Home',
    ...over,
  };
}

/** A thread whose run the mock journal holds, still going. */
function working(run: number): Conversation {
  const live: LiveTurn = { run, attach: mockJournal.open(run), assistantId: 'lab-reply' };
  return thread('lab-working', 'Triage the inbox', {
    sessionId: '00000000-0000-4000-8000-000000092704',
    live,
  });
}

/** A thread saved before a restart, its run under the last launch's key,
 * which this launch's journal never held. */
const BEFORE: Conversation = thread('lab-before', 'Clean up the tags', {
  sessionId: '00000000-0000-4000-8000-000000092705',
  live: { run: 4, attach: 'mock-before-restart-4', assistantId: 'lab-reply' },
});

/** Stage `threads` (each a thread, or a function making one as the seed
 * runs), with a card waiting for the asking thread's call when `asked`. */
function seed(threads: (Conversation | (() => Conversation))[], { asked = false } = {}) {
  return () => {
    resetThreadStatus();
    resetMockInteractions();
    staged = [OPEN, ...threads.map((t) => (typeof t === 'function' ? t() : t))];
    if (!asked) return;
    const input = JSON.stringify({ path: 'notes/release.md', content: 'Ship it.' });
    confirmMockInteraction(
      registerMockInteraction(
        LAB_VAULT,
        ASKING_SESSION,
        'toolu_lab_status_append',
        'mcp__cerebro__append_to_note',
        input,
        () => undefined,
      ),
    );
  };
}

function stateOf(conversations: Conversation[]): ConversationState {
  const none = () => undefined;
  return {
    conversations,
    activeId: OPEN.id,
    active: OPEN,
    here: { kind: 'home' },
    hereLabel: 'Home',
    startedElsewhere: null,
    anchorNow: none,
    start: none,
    select: none,
    rename: none,
    remove: none,
    setRunOptions: none,
    branchFrom: () => null,
    transcript: { state: 'idle' },
    blocked: null,
    ready: true,
  };
}

/** The list, as the canvas sidebar shows it. */
function Stage() {
  const state = useMemo(() => stateOf(staged), []);
  return (
    <div className="w-60">
      <ConversationNavigation state={state} />
    </div>
  );
}

const ROW = '[data-testid="conversation-row"]';
const CHIP = '[data-testid="thread-status"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'conversation-status',
  title: 'Conversation status',
  surface: 'Assistant › canvas › Conversations',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A thread left a run going, and a card waits for another: Working and Needs you.',
      seed: seed([() => working(920_701), ASKING], { asked: true }),
      expect: {
        present: [
          `${CHIP}[data-status="working"]`,
          `${CHIP}[data-status="needs_you"]`,
          `${ROW}[data-thread-status="idle"]`,
        ],
        absent: [UNAVAILABLE],
        text: THREAD_STATUS_WORDS.needs_you,
      },
    },
    empty: {
      note: 'Nothing runs and nothing waits, and the book says so: no chips at all.',
      seed: seed([IDLE]),
      expect: {
        present: [`${ROW}[data-thread-status="idle"]`],
        absent: [CHIP, UNAVAILABLE, `${ROW}[data-thread-status="unknown"]`],
      },
    },
    'not-recorded': {
      note: 'A thread left a run going before a restart; the journal no longer holds it, so nothing infers Working.',
      seed: seed([BEFORE, IDLE]),
      expect: {
        present: [`${ROW}[data-thread-status="unknown"]`, `${ROW}[data-thread-status="idle"]`],
        absent: [CHIP, UNAVAILABLE],
      },
    },
    partial: {
      note: 'One thread’s run is still going; another’s, left before a restart, nobody can tell.',
      seed: seed([() => working(920_702), BEFORE]),
      expect: {
        present: [`${CHIP}[data-status="working"]`, `${ROW}[data-thread-status="unknown"]`],
        absent: [UNAVAILABLE],
      },
    },
    unavailable: {
      note: 'The journal cannot be read: no chip, and the list says so once, never quietly.',
      seed: seed([() => working(920_703), IDLE]),
      failNext: ['agent_events_since'],
      expect: {
        present: [UNAVAILABLE, `${ROW}[data-thread-status="unavailable"]`],
        absent: [CHIP],
        text: THREAD_STATUS_WORDS.unavailable,
      },
    },
  },
};
