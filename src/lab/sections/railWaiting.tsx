import { useMemo, useRef } from 'react';
import { railWaiting } from '@/agent/elements/railWaiting';
import {
  STALE,
  cancelMockInteraction,
  confirmMockInteraction,
  registerMockInteraction,
  resetMockInteractions,
} from '@/agent/mockInteractions';
import { WAITING_WORDS, WaitingCard } from '@/agent/rail/WaitingCard';
import { applyEvent } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';
import type { WaitingCard as Waiting } from '@/agent/useAgentChat';
import type { MessageScrollerCommands } from '@/components/ai/MessageScroller';
import { Rail } from '@/components/ai/Rail';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The rail's Waiting card (M92.4) in its five states: the card a thread
 * holds as its turn waits on the person (`chat.interaction`), raised by the
 * mock's book (`mockInteractions.ts`, Rust's book's twin) and drawn over the
 * reply whose call asks (`railWaiting`), at the rail's width; with none, the
 * card's own check of the book (`list_interactions`). The lab runs no turn,
 * so each preset's seed hands the stage the card the thread would hold.
 *
 * Synthetic, in the shapes the live stream folds to: made-up ids and the
 * demo vault's pages.
 */

const SESSION = '00000000-0000-4000-8000-000000092420';
const AGENT = 'toolu_lab_wait_agent';
const ASKING = 'toolu_lab_wait_append';
const APPEND = 'mcp__cerebro__append_to_note';
const INPUT = JSON.stringify({ path: 'notes/inbox.md', text: 'Escalate the scanner risk.' });

/** What the thread holds as its turn waits: its messages, and its card. */
let staged: { messages: ChatMessage[]; held: Waiting | null } = { messages: [], held: null };

/** Who asks for the page write: the turn itself, a researcher it started,
 *  or a subagent whose task nothing recorded. */
type Asker = 'turn' | 'researcher' | 'unnamed';

/** The reply as the live stream left it when its call was held. */
function reply(asker: Asker): ChatMessage {
  const events: AgentStreamEvent[] = [];
  if (asker !== 'turn') {
    events.push({
      kind: 'ToolStart',
      tool_name: 'Agent',
      tool_id: AGENT,
      input:
        asker === 'researcher'
          ? JSON.stringify({
              description: 'Read the open risks',
              subagent_type: 'cerebro-researcher',
              prompt: 'Read the open risks and note the one to escalate.',
            })
          : '{}',
    });
  }
  events.push(
    {
      kind: 'ToolStart',
      tool_name: APPEND,
      tool_id: ASKING,
      input: INPUT,
      ...(asker === 'turn' ? {} : { parent: AGENT }),
    },
    { kind: 'ToolDeferred', tool_id: ASKING, tool_name: APPEND },
  );
  let message: ChatMessage = {
    id: 'lab-wait-a1',
    role: 'assistant',
    text: '',
    tools: [],
    streaming: false,
  };
  for (const event of events) message = applyEvent(message, event, 'live', SESSION);
  return message;
}

/** Seed the book and the thread: a card waiting for `asker`'s call, one
 *  answered too late (`stale`), or none. */
function seed(asker: Asker | null, { stale = false }: { stale?: boolean } = {}) {
  return () => {
    resetMockInteractions();
    if (asker === null) {
      staged = { messages: [], held: null };
      return;
    }
    const id = registerMockInteraction(LAB_VAULT, SESSION, ASKING, APPEND, INPUT, () => undefined);
    const card = confirmMockInteraction(id);
    // Answered elsewhere: the book no longer holds it.
    if (stale) cancelMockInteraction(id);
    const message = reply(asker);
    staged = {
      messages: [
        { id: 'lab-wait-u1', role: 'user', text: 'Note the risk to escalate.', tools: [] },
        message,
      ],
      held:
        card === null
          ? null
          : { card, messageId: message.id, answering: false, stale: stale ? STALE : null },
    };
  };
}

/** The rail, open on the thread, its card the one the thread holds. */
function Stage() {
  const scroller = useRef<MessageScrollerCommands | null>(null);
  const waiting = useMemo(() => railWaiting(staged.held, staged.messages), []);
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <WaitingCard
          waiting={waiting}
          vault={LAB_VAULT}
          thread="lab-wait"
          folded={false}
          jump={(go) => go()}
          scroller={scroller}
        />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-waiting"]';
const LINE = '[data-testid="rail-waiting-card"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-waiting',
  title: 'Waiting on you',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A researcher the turn started asks to append to a page; the card names it.',
      seed: seed('researcher'),
      expect: {
        present: [`${CARD}[data-state="ready"]`, LINE],
        absent: [UNAVAILABLE],
        text: 'Asked by the cerebro-researcher subagent: Read the open risks',
      },
    },
    empty: {
      note: 'Nothing waits, and the book says so: the card is not drawn at all.',
      seed: seed(null),
      expect: { present: [], absent: [CARD, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'A subagent asks, but nothing recorded what it was or what it was asked.',
      seed: seed('unnamed'),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`, LINE],
        absent: [UNAVAILABLE],
        text: WAITING_WORDS.notRecorded,
      },
    },
    partial: {
      note: 'The turn’s own call was answered elsewhere: the card stays, saying it no longer waits.',
      seed: seed('turn', { stale: true }),
      expect: {
        present: [`${CARD}[data-state="partial"]`, LINE],
        absent: [UNAVAILABLE],
        text: WAITING_WORDS.stale,
      },
    },
    unavailable: {
      note: 'Nothing waits in the thread, and the book cannot be read: never hidden.',
      seed: seed(null),
      failNext: ['list_interactions'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [LINE],
        text: WAITING_WORDS.unavailable,
      },
    },
  },
};
