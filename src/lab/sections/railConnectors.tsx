import { RAIL_CONNECTORS_WORDS } from '@/agent/elements/railConnectors';
import { ConnectorsCard } from '@/agent/rail/ConnectorsCard';
import type { RunReach } from '@/agent/types';
import { Rail } from '@/components/ai/Rail';
import { approvalKey, parseConnectors, type ConnectorStatusRow } from '@/engine/connectors';
import { __seedConnectorStatus, saveConnectors } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The rail's Connectors card (M92.9) in its five states: the vault's
 * connector list as the mock holds it (`read_connectors`), the status the
 * newest runs saw (`connector_status`, seeded), Settings' switch and this
 * machine's approvals, joined with what the conversation's latest run said
 * it reaches (M92.8), drawn at the rail's width. The lab runs no turn, so
 * each preset's seed hands the stage the run's reach itself.
 *
 * Synthetic: example.test URLs, and the Linear preset's own.
 */

const LIST = JSON.stringify({
  servers: {
    gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
    linear: {
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      oauth: { scopes: 'read write' },
      enabled: true,
    },
    jira: { transport: 'http', url: 'https://jira.example.test/mcp', enabled: false },
  },
});

/** What the newest runs saw: Gmail answered; Linear needs a sign-in. */
const STATUS: ConnectorStatusRow[] = [
  {
    connector: 'gmail',
    cli_name: 'gmail',
    refused: null,
    state: 'working',
    signal: 'tool_result',
    seen_at: '2026-07-28T11:00:00.000Z',
    run_id: null,
  },
  {
    connector: 'linear',
    cli_name: 'linear',
    refused: null,
    state: 'needs_sign_in',
    signal: 'init',
    seen_at: '2026-07-28T11:00:00.000Z',
    run_id: null,
  },
];

/** The conversation's latest run: it loaded both connectors this machine
 *  approved, and its instructions named one the vault does not list. */
const REACH: RunReach = {
  connectors: [
    { name: 'gmail', status: 'connected' },
    { name: 'linear', status: 'needs-auth' },
  ],
  missing: [{ name: 'notion', reason: "not in this vault's connector list" }],
  missing_more: 0,
  inherits: false,
  permission_mode: 'acceptEdits',
  cerebro: true,
  families: {},
};

/** What the stage hands the card as the run's reach. Each preset's seed
 *  sets it before the stage mounts. */
let staged: RunReach | null = null;

/**
 * Stage Settings' switch, the vault's list with every entry approved on
 * this machine, the status rows, and the run's reach. Settings' switch and
 * the approvals live in the app's store, outside the mock's reset, so every
 * preset sets both.
 */
function seed({
  enabled = true,
  reach = REACH,
}: { enabled?: boolean; reach?: RunReach | null } = {}) {
  return () => {
    staged = reach;
    void saveConnectors(LAB_VAULT, LIST);
    __seedConnectorStatus(STATUS);
    useUiStore.setState({
      agentConnectors: enabled,
      stdioApprovals: {
        [LAB_VAULT]: parseConnectors(LIST).flatMap((spec) => approvalKey(spec) ?? []),
      },
    });
  };
}

/** The rail, with the card over the open vault. */
function Stage() {
  const vault = useVaultStore((s) => s.vaultPath);
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <ConnectorsCard vault={vault} reach={staged} streaming={false} folded={false} />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-connectors"]';
const LINE = '[data-testid="rail-connector"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-connectors',
  title: 'Conversation connectors',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'The run loaded Gmail, which works, and Linear, which needs a sign-in (Sign in…); Jira is off in the list, and the run’s instructions named Notion, which the vault does not list.',
      seed: seed(),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${LINE}[data-name="gmail"][data-status="working"][data-run="loaded"]`,
          `${LINE}[data-name="linear"] [data-testid="rail-connector-sign-in"]`,
          `${LINE}[data-name="notion"][data-run="missing"]`,
          '[data-testid="rail-connectors-mail"]',
        ],
        absent: [UNAVAILABLE],
        text: RAIL_CONNECTORS_WORDS.mail,
      },
    },
    empty: {
      note: 'Settings switches connectors off: one quiet line that says so, and nothing is read.',
      seed: seed({ enabled: false }),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [LINE, UNAVAILABLE],
        text: RAIL_CONNECTORS_WORDS.off,
      },
    },
    'not-recorded': {
      note: 'No run of the conversation has said what it reaches: the list still reads in Settings’ words, and nothing says what a run loaded.',
      seed: seed({ reach: null }),
      expect: {
        present: [
          `${CARD}[data-state="not-recorded"]`,
          '[data-testid="rail-connectors-not-recorded"]',
          `${LINE}[data-name="gmail"][data-status="working"]`,
        ],
        absent: [UNAVAILABLE, `${LINE}[data-run]`, '[data-testid="rail-connectors-mail"]'],
        text: RAIL_CONNECTORS_WORDS.notRecorded,
      },
    },
    partial: {
      note: 'The status read fails: every connector stays listed, and none claims a state.',
      seed: seed(),
      failNext: ['connector_status'],
      expect: {
        present: [
          `${CARD}[data-state="partial"]`,
          '[data-testid="rail-connectors-partial"]',
          `${LINE}[data-name="gmail"][data-status="unavailable"]`,
        ],
        absent: [UNAVAILABLE, `${LINE}[data-name="gmail"] [data-testid="rail-connector-status"]`],
        text: RAIL_CONNECTORS_WORDS.partial,
      },
    },
    unavailable: {
      note: 'The list read fails: unavailable, never no connectors.',
      seed: seed(),
      failNext: ['read_connectors'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [LINE],
        text: RAIL_CONNECTORS_WORDS.unavailable,
      },
    },
  },
};
