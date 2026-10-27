import { useMemo } from 'react';
import { mockContextBook, type ContextUseRecorded } from '@/agent/agentIpc';
import { RAIL_CONTEXT_WORDS, railContext } from '@/agent/elements/contextCard';
import { ContextCard } from '@/agent/rail/ContextCard';
import { useContextUse } from '@/agent/useContextUse';
import { Rail } from '@/components/ai/Rail';
import type { ContextBreakdown } from '@/engine/ai/contextBreakdown';
import { VAULT_TODAY } from '@/lib/vaultToday';
import type { LabSection } from '../presets';

/**
 * The rail's Context card (M92.14) in its five states: the composer's pull
 * of `agent_context_usage` for a conversation's session (`useContextUse`,
 * M91.5), read into the card (`railContext`) and drawn at the rail's width.
 * Each preset reads a session of its own, so a reading one preset files
 * never answers another's.
 *
 * Synthetic, in the shape Rust's meter keeps Claude Code's answer to the
 * context ask (src-tauri/fixtures/context-breakdown.json): made-up counts,
 * and no path or tool name, which never cross.
 */

/** The conversation's session the stage reads: each preset's seed sets it
 * before the stage mounts. */
let session: string | null = null;

/** Claude Code's own account of a seated run's context, as the meter keeps
 * it: Cerebro's tools mostly behind tool search, a custom agent, a memory
 * file, and the reserve autocompact keeps. */
const BREAKDOWN: ContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 6_797, kind: 'used' },
    { name: 'System tools', tokens: 7_030, kind: 'used' },
    { name: 'MCP tools', tokens: 412, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 438, kind: 'deferred' },
    { name: 'System tools (deferred)', tokens: 2_368, kind: 'deferred' },
    { name: 'Custom agents', tokens: 30, kind: 'used' },
    { name: 'Memory files', tokens: 16, kind: 'used' },
    { name: 'Messages', tokens: 18_962, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { name: 'Free space', tokens: 133_753, kind: 'free' },
  ],
  total: 33_247,
  max: 200_000,
  model: 'claude-sonnet-5',
  autocompact: { enabled: true, threshold: 167_000 },
  mcpServers: [
    { name: 'cerebro', tools: 31, loaded: 2, tokens: 412 },
    { name: 'toy', tools: 1, loaded: 0, tokens: 0 },
  ],
  memoryFiles: 1,
};

/** A reading as Rust files it: its count is the latest request's, which
 * the breakdown's own total stands in for wherever it came. */
function reading(used: number, breakdown?: ContextBreakdown): ContextUseRecorded {
  return {
    state: 'recorded',
    used,
    window: 200_000,
    model: 'claude-sonnet-5',
    at: VAULT_TODAY,
    ...(breakdown === undefined ? {} : { breakdown }),
  };
}

/** Read `id`'s session, with `filed` in the book for it, or nothing filed. */
function seed(id: string | null, filed?: ContextUseRecorded): () => void {
  return () => {
    session = id;
    if (id !== null && filed !== undefined) mockContextBook.record(id, filed);
  };
}

/** The card, in the rail, over the composer's pull of the session. */
function Stage() {
  const pulled = useContextUse(session, { streaming: false });
  const context = useMemo(() => railContext(pulled, { session, streaming: false }), [pulled]);
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <ContextCard context={context} folded={false} />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-context"]';
const ROWS = '[data-testid="rail-context-categories"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-context',
  title: 'Conversation context',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'Claude Code’s breakdown came with the reading: its total, 33,247 of 200,000 tokens, is the figure, and the deferred rows read not loaded.',
      seed: seed('00000000-0000-4000-8000-000000092141', reading(33_300, BREAKDOWN)),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${ROWS} [data-kind="deferred"]`,
          `${ROWS} [data-slot="context-bar"]`,
        ],
        absent: [UNAVAILABLE],
        text: '33,247 of 200,000 tokens',
      },
    },
    empty: {
      note: 'A conversation with no session yet: no turn to read, and nothing is asked.',
      seed: seed(null),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [ROWS, UNAVAILABLE],
        text: RAIL_CONTEXT_WORDS.noTurns,
      },
    },
    'not-recorded': {
      note: 'The session has run, but no reading was filed for it since Cerebro started.',
      seed: seed('00000000-0000-4000-8000-000000092142'),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`],
        absent: [ROWS, UNAVAILABLE],
        text: RAIL_CONTEXT_WORDS.notRecordedDetail,
      },
    },
    partial: {
      note: 'A reading with no breakdown, as a run that took its message in argv files (an answer’s resume, or any run but a seated one, M92.13): the count alone.',
      seed: seed('00000000-0000-4000-8000-000000092143', reading(124_000)),
      expect: {
        present: [`${CARD}[data-state="partial"]`, '[data-testid="rail-context-figure"]'],
        absent: [ROWS, UNAVAILABLE],
        text: RAIL_CONTEXT_WORDS.noBreakdown,
      },
    },
    unavailable: {
      note: 'The read fails: unavailable, never not recorded.',
      seed: seed('00000000-0000-4000-8000-000000092144', reading(33_300, BREAKDOWN)),
      failNext: ['agent_context_usage'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [ROWS, '[data-testid="rail-context-figure"]'],
        text: RAIL_CONTEXT_WORDS.unavailable,
      },
    },
  },
};
