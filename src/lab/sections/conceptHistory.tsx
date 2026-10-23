import type { ConceptEvent } from '@/engine/activity';
import { PageHistory } from '@/history/PageHistory';
import { __seedConceptHistory } from '@/lib/mockIpc';
import type { LabSection } from '../presets';

/**
 * A concept page's History (M64.2b) in its five states, on Warehouse
 * cutover: what the ledger recorded about it. The browser keeps no ledger,
 * so each preset seeds the concept's lane.
 */

const PAGE = 'knowledge/playbooks/warehouse-cutover.md';

function event(fields: Partial<ConceptEvent> & { event_id: string }): ConceptEvent {
  return {
    kind: 'created',
    revision: null,
    state: null,
    actor: 'process:knowledge',
    run_id: 'run-ingest-2',
    at: '2026-07-28T09:05:00.000Z',
    ...fields,
  };
}

const CONCEPT = '[data-testid="history-concept"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'concept-history',
  title: "A concept's History",
  surface: 'A concept · History panel',
  render: () => <PageHistory path={PAGE} />,
  states: {
    ready: {
      note: 'Created by the Knowledge agent, verified by you, and a change waiting on you.',
      seed: () =>
        __seedConceptHistory(PAGE, [
          event({ event_id: 'created' }),
          event({
            event_id: 'verified',
            kind: 'verified',
            actor: 'human:me',
            run_id: null,
            at: '2026-07-28T10:00:00.000Z',
          }),
          event({
            event_id: 'queued',
            kind: 'proposal',
            state: 'queued',
            at: '2026-07-28T11:00:00.000Z',
          }),
        ]),
      expect: {
        present: [
          `${CONCEPT}[data-kind="created"]`,
          `${CONCEPT}[data-kind="verified"]`,
          `${CONCEPT}[data-kind="proposal"]`,
        ],
        absent: [UNAVAILABLE],
      },
    },
    empty: {
      note: 'The ledger read, and no belief projects this page.',
      seed: () => __seedConceptHistory(PAGE, []),
      expect: {
        present: ['[data-testid="page-history-no-concept-events"]'],
        absent: [CONCEPT, UNAVAILABLE],
      },
    },
    'not-recorded': {
      note: 'This vault keeps no ledger.',
      seed: () => __seedConceptHistory(PAGE, 'not_recorded'),
      expect: {
        present: ['[data-testid="page-history-no-ledger"]'],
        absent: [CONCEPT, UNAVAILABLE],
      },
    },
    partial: {
      note: 'The index has not replayed two events yet, so their time is not recorded.',
      seed: () =>
        __seedConceptHistory(PAGE, [
          event({ event_id: 'created' }),
          event({ event_id: 'revised', kind: 'revised', revision: 2, actor: null, at: null }),
          event({ event_id: 'verified', kind: 'verified', actor: null, run_id: null, at: null }),
        ]),
      expect: { present: [CONCEPT], absent: [UNAVAILABLE], text: 'Time not recorded' },
    },
    unavailable: {
      note: "The page's read fails, and with it the ledger lane it carries.",
      failNext: ['page_activity'],
      expect: {
        present: [`${UNAVAILABLE}[data-lane="knowledge"]`, `${UNAVAILABLE}[data-lane="writes"]`],
        absent: [CONCEPT],
      },
    },
  },
};
