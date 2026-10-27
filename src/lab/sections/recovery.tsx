import { RecoverySettings } from '@/history/RecoverySettings';
import { RecoveryVersions } from '@/history/RecoveryVersions';
import { mockRecovery, type RecoveryRow } from '@/lib/mockRecovery';
import { sha256Hex } from '@/lib/sha256';
import { LAB_VAULT, type LabSection } from '../presets';

const PATH = 'records/risks/risk-rollback-unrehearsed.md';
const UNAVAILABLE = '[data-testid="section-unavailable"]';
const CHECKBOX = 'input[type="checkbox"]';
function row(id: string, state: RecoveryRow['state'] = 'committed'): RecoveryRow {
  const raw = '# Recovery example\n\nEarlier page bytes.\n';
  return {
    id,
    vault: LAB_VAULT,
    path: PATH,
    raw,
    beforeHash: sha256Hex(raw),
    afterHash: sha256Hex('# Recovery example\n\nLater page bytes.\n'),
    capturedAt: Math.floor(Date.now() / 1000),
    bytes: new TextEncoder().encode(raw).length,
    state,
    attribution: 'outside, unattributed',
  };
}
const seedReady = () => mockRecovery.seed([row('retained')], [LAB_VAULT]);
const seedPartial = () =>
  mockRecovery.seed(
    [row('retained'), row('waiting', 'pending'), row('uncertain', 'ambiguous')],
    [LAB_VAULT],
  );

export const sections: LabSection[] = [
  {
    id: 'recovery-settings',
    title: 'Recovery settings',
    surface: 'Settings · Vault',
    render: () => <RecoverySettings vault={LAB_VAULT} />,
    states: {
      ready: {
        note: 'Opted in, with one retained copy. Counts measure all vaults.',
        seed: seedReady,
        expect: { present: [CHECKBOX], absent: [UNAVAILABLE], text: 'Across all vaults: 1 copies' },
      },
      empty: {
        note: 'Opted in, and the successful read found no retained copies.',
        seed: () => mockRecovery.seed([], [LAB_VAULT]),
        expect: { present: [CHECKBOX], absent: [UNAVAILABLE], text: 'Across all vaults: 0 copies' },
      },
      'not-recorded': {
        note: 'Opt-in is off and no copies remain. This does not reconstruct earlier save history.',
        seed: () => mockRecovery.seed([]),
        expect: { present: [CHECKBOX], absent: [UNAVAILABLE], text: 'Across all vaults: 0 copies' },
      },
      partial: {
        note: 'A copy is retained, one is pending, and one has an uncertain save outcome.',
        seed: seedPartial,
        expect: { present: [CHECKBOX], absent: [UNAVAILABLE], text: '1 pending; 1 ambiguous.' },
      },
      unavailable: {
        note: 'The settings read failed; neither Off nor zero usage is assumed.',
        failNext: ['recovery_status'],
        expect: {
          present: [UNAVAILABLE],
          absent: [CHECKBOX],
          text: 'Recovery settings could not be read.',
        },
      },
    },
  },
  {
    id: 'recovery-versions',
    title: 'Recovery copies',
    surface: 'A page · History panel',
    render: () => <RecoveryVersions path={PATH} />,
    states: {
      ready: {
        note: 'One retained copy is available for explicit preview, export or restore.',
        seed: seedReady,
        expect: { present: ['article'], absent: [UNAVAILABLE], text: 'Retained' },
      },
      empty: {
        note: 'A successful read found no retained copies for this page.',
        seed: () => mockRecovery.seed([], [LAB_VAULT]),
        expect: {
          present: ['section'],
          absent: ['article', UNAVAILABLE],
          text: 'No retained recovery copies for this page.',
        },
      },
      'not-recorded': {
        note: 'The displaced bytes have no proven writer attribution; no human or agent is invented.',
        seed: seedReady,
        expect: { present: ['article'], absent: [UNAVAILABLE], text: 'outside, unattributed' },
      },
      partial: {
        note: 'Retained, pending and ambiguous copies remain distinct. A pending copy is not a completed save.',
        seed: seedPartial,
        expect: { present: ['article'], absent: [UNAVAILABLE], text: 'Save outcome uncertain' },
      },
      unavailable: {
        note: 'The copy-list read failed; it must not claim there are no copies.',
        failNext: ['list_recovery'],
        expect: {
          present: [UNAVAILABLE],
          absent: ['article'],
          text: 'Recovery copies could not be read.',
        },
      },
    },
  },
];
