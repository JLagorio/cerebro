import { mockContextBook, type ContextUseRecorded } from '@/agent/agentIpc';
import { contextUsageOf } from '@/agent/elements/composerContext';
import { useContextUse } from '@/agent/useContextUse';
import { Context } from '@/components/ai/Context';
import { VAULT_TODAY } from '@/lib/vaultToday';
import type { LabSection } from '../presets';

/**
 * The composer's Context reading (M91.12a) in its five states (M91.15):
 * `agent_context_usage` pulled for a conversation's session as the composer
 * pulls it (M91.5), and drawn by the Context element. Each preset reads a
 * session of its own, so a reading one preset files never answers another's.
 */

/** The conversation's session the stage reads: each preset's seed sets it
 * before the stage mounts. */
let session: string | null = null;

/** A reading as Claude Code reported it, filed in the mock's book. */
function reading(used: number, window?: number): ContextUseRecorded {
  return {
    state: 'recorded',
    used,
    ...(window === undefined ? {} : { window }),
    model: 'claude-sonnet-5',
    at: VAULT_TODAY,
  };
}

/** Read `id`'s session, with `filed` in the book for it, or nothing filed. */
function seed(id: string | null, filed?: ContextUseRecorded): () => void {
  return () => {
    session = id;
    if (id !== null && filed !== undefined) mockContextBook.record(id, filed);
  };
}

/** The reading as the composer draws it, between Model and effort and Send. */
function Stage() {
  const usage = contextUsageOf(useContextUse(session, { streaming: false }));
  return <Context usage={usage} testId="context-use" tabIndex={0} />;
}

const CONTEXT = '[data-testid="context-use"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'context-use',
  title: 'Context use',
  surface: 'Assistant › composer',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'Claude Code reported 124,000 tokens of a 200,000-token window.',
      seed: seed('00000000-0000-4000-8000-000000091501', reading(124_000, 200_000)),
      expect: {
        present: [`${CONTEXT}[data-state="recorded"][aria-label="62% of context used"]`],
        absent: [UNAVAILABLE],
        text: '62%',
      },
    },
    empty: {
      note: 'A conversation with no session yet: there is nothing to read, and nothing is asked.',
      seed: seed(null),
      expect: {
        present: [`${CONTEXT}[data-state="not_recorded"][aria-label="Context use not recorded"]`],
        absent: [UNAVAILABLE],
      },
    },
    'not-recorded': {
      note: 'The session has run, but no reading was filed for it since Cerebro started.',
      seed: seed('00000000-0000-4000-8000-000000091502'),
      expect: {
        present: [`${CONTEXT}[data-state="not_recorded"][aria-label="Context use not recorded"]`],
        absent: [UNAVAILABLE],
      },
    },
    partial: {
      note: 'Claude Code reported the tokens but not the window: a count, never a percentage.',
      seed: seed('00000000-0000-4000-8000-000000091503', reading(48_200)),
      expect: {
        present: [`${CONTEXT}[data-state="recorded"][aria-label="48,200 tokens of context used"]`],
        absent: [UNAVAILABLE],
        text: '48.2K',
      },
    },
    unavailable: {
      note: 'The read fails: unavailable, never not recorded.',
      seed: seed('00000000-0000-4000-8000-000000091504', reading(124_000, 200_000)),
      failNext: ['agent_context_usage'],
      expect: {
        present: [
          `${CONTEXT}[data-state="unavailable"][aria-label="Context use unavailable"]`,
          UNAVAILABLE,
        ],
      },
    },
  },
};
