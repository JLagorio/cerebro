import { useMemo } from 'react';
import { RAIL_CHANGES_WORDS, railChanges } from '@/agent/elements/conversationChanges';
import { ChangesCard } from '@/agent/rail/ChangesCard';
import type { ChatMessage, PrLink } from '@/agent/types';
import { useChangesHeal } from '@/agent/useChangesHeal';
import { Rail } from '@/components/ai/Rail';
import type { RunChangeset } from '@/engine/changeset';
import type { FleetRun } from '@/lib/ipc';
import { seedGitHistory } from '@/lib/mockGit';
import { __seedFleet } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import type { LabSection } from '../presets';

/**
 * The rail's Changes card (M92.5) in its five states: what a conversation's
 * replies hold of their runs' changesets, folded across its turns
 * (`railChanges`), with the heal (`useChangesHeal`, M92.12) reading the runs
 * of its session that no reply holds back from the mock's fleet and its
 * repository (`conversation_changes`), drawn at the rail's width. The lab
 * runs no turn, so each preset's seed hands the stage the conversation, and
 * stages the runs and commits the heal reads.
 *
 * Synthetic: made-up run ids, sessions and commits, and the demo vault's
 * pages.
 */

/** The conversation the stage opens on, and its session. Each preset's seed
 *  sets it before the stage mounts. */
let staged: { messages: ChatMessage[]; session: string } = { messages: [], session: '' };

const session = (n: number) => `00000000-0000-4000-8000-00000009215${n}`;
const NO_LINKS: readonly PrLink[] = [];

const SCHEDULE = 'delivery/how-we-schedule.md';
const CALL = 'delivery/vendor-call.md';
/** A file git counts no lines for, as it counts none for a binary file. */
const QUOTE = 'delivery/vendor-quote.pdf';
/** The schedule page before and after the run that added a line to it. */
const BEFORE = '# How we schedule\n\nWe ship on Thursdays, after the freeze.\n';
const AFTER = `${BEFORE}\n- call the vendor\n`;

/** A run only the heal reads back, and the commit its record names. */
const HEALED_RUN = '0000000000000000000000000092151a';
const HEALED_COMMIT = '9215a9215a9215a9215a9215a9215a9215a9215a';
const BASE_COMMIT = '9215b9215b9215b9215b9215b9215b9215b9215b';

/** A turn: the person's ask and the reply that holds `changesets`; none, as
 *  for a reply rebuilt from the session file, which never holds one. */
function turn(n: number, changesets?: RunChangeset[]): ChatMessage[] {
  return [
    { id: `lab-changes-u${n}`, role: 'user', text: 'Note the vendor call.', tools: [] },
    {
      id: `lab-changes-a${n}`,
      role: 'assistant',
      text: 'Noted.',
      tools: [],
      ...(changesets === undefined ? {} : { changesets }),
    },
  ];
}

/** A run's commit as Rust's Changeset reports it: a page added and the
 *  schedule given a line, each counted. */
const COMMITTED: RunChangeset = {
  state: 'committed',
  run_id: 'run-lab-changes-1',
  commit: '9215c9215c9215c9215c9215c9215c9215c9215c',
  files: [
    { path: CALL, previous_path: null, kind: 'added', additions: 6, deletions: 0, also_by: [] },
    {
      path: SCHEDULE,
      previous_path: null,
      kind: 'modified',
      additions: 2,
      deletions: 0,
      also_by: [],
    },
  ],
  additions: 8,
  deletions: 0,
  binary: 0,
  shell_unrecorded: false,
};

/** An ended run of `id`'s session, as fleet.rs serves its row. */
function sessionRun(id: string): FleetRun {
  return {
    run_id: HEALED_RUN,
    actor: 'process:assistant',
    vault_id: 'demo',
    mode: 'attended',
    lane: 'agent',
    started_at: '2026-07-28T11:20:00Z',
    ended_at: '2026-07-28T11:21:00Z',
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 9_210,
    output_tokens: 412,
    proposals_submitted: null,
    applied: null,
    rejected: null,
    parent_run_id: null,
    cause: null,
    cli_session_id: id,
  };
}

/** Stage the conversation, its session, and what the heal reads: the
 *  session's run in the fleet, and the commit its record names, which gave
 *  the schedule a line and added a quote the mock repository kept no copy
 *  of, so git's count of it reads back as none. */
function seed(id: string, messages: ChatMessage[], { healed = false } = {}): () => void {
  return () => {
    staged = { messages, session: id };
    if (!healed) return;
    __seedFleet([sessionRun(id)], {});
    seedGitHistory([
      {
        hash: HEALED_COMMIT,
        message: 'Note the vendor call',
        author: 'Cerebro',
        date: 1_785_237_660,
        files: [
          { path: SCHEDULE, status: 'modified' },
          { path: QUOTE, status: 'added' },
        ],
        snapshots: { [SCHEDULE]: AFTER },
        run: { runId: HEALED_RUN, actor: 'process:assistant' },
      },
      {
        hash: BASE_COMMIT,
        message: 'Schedule after the freeze',
        date: 1_785_150_000,
        files: [{ path: SCHEDULE, status: 'modified' }],
        snapshots: { [SCHEDULE]: BEFORE },
      },
    ]);
  };
}

/** The rail, with the card over the conversation and its heal. */
function Stage() {
  const vault = useVaultStore((s) => s.vaultPath);
  const heal = useChangesHeal(vault, staged.session, { visible: true, streaming: false });
  const changes = useMemo(
    () =>
      railChanges({
        messages: staged.messages,
        inFlight: false,
        sessionId: staged.session,
        prLinks: NO_LINKS,
        heal,
      }),
    [heal],
  );
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <ChangesCard
          changes={changes}
          folded={false}
          jump={(go) => go()}
          onOpenPath={() => undefined}
        />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-changes"]';
const ROW = '[data-testid="rail-change"]';
const NOTE = '[data-testid="rail-changes-note"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

/** A turn rebuilt from the session file, which holds no changeset: the heal
 *  reads its run back. */
const REBUILT = turn(1);

export const section: LabSection = {
  id: 'rail-changes',
  title: 'Conversation changes',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A turn that added a page and gave the schedule a line, both counted; the heal finds no other run of the session.',
      seed: seed(session(1), turn(1, [COMMITTED])),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${ROW}[data-path="${CALL}"][data-kind="added"]`,
          `${ROW}[data-path="${SCHEDULE}"][data-kind="modified"]`,
        ],
        absent: [UNAVAILABLE, NOTE],
        text: '+8 −0 across 1 turn',
      },
    },
    empty: {
      note: 'Two turns whose runs said they changed nothing.',
      seed: seed(session(2), [
        ...turn(1, [{ state: 'nothing', run_id: 'run-lab-changes-2', shell_unrecorded: false }]),
        ...turn(2, [{ state: 'nothing', run_id: 'run-lab-changes-3', shell_unrecorded: false }]),
      ]),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [ROW, UNAVAILABLE],
        text: 'None',
      },
    },
    'not-recorded': {
      note: 'A run whose writes nobody recorded: not recorded, never no changes.',
      seed: seed(
        session(3),
        turn(1, [
          {
            state: 'not_recorded',
            run_id: 'run-lab-changes-4',
            reason: "this run's writes were not recorded",
            files: [],
          },
        ]),
      ),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`, `${NOTE}[data-note="not-recorded"]`],
        absent: [ROW, UNAVAILABLE],
        text: RAIL_CHANGES_WORDS.notRecorded(1),
      },
    },
    partial: {
      note: 'A turn rebuilt from the session file: the heal reads its run back from the commit its record names, the schedule’s lines counted and the quote’s not, and who else edited them not recorded.',
      seed: seed(session(4), REBUILT, { healed: true }),
      expect: {
        present: [
          `${CARD}[data-state="partial"]`,
          `${ROW}[data-path="${SCHEDULE}"][data-kind="modified"]`,
          `${ROW}[data-path="${QUOTE}"][data-kind="added"]`,
        ],
        absent: [UNAVAILABLE, NOTE],
        text: RAIL_CHANGES_WORDS.uncounted(1),
      },
    },
    unavailable: {
      note: 'The same turn, and the heal’s read fails: the card is unavailable and its turn not recorded, never none.',
      seed: seed(session(5), REBUILT, { healed: true }),
      failNext: ['conversation_changes'],
      expect: {
        present: [
          `${CARD}[data-state="unavailable"]`,
          UNAVAILABLE,
          `${NOTE}[data-note="not-recorded"]`,
        ],
        absent: [ROW],
        text: RAIL_CHANGES_WORDS.unavailable,
      },
    },
  },
};
