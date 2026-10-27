import { RunConfiguration } from '@/status/RunConfiguration';
import { __seedRunConfigurations } from '@/lib/mockIpc';
import type { RunConfigurationManifestV1 } from '@/lib/runConfiguration';
import { LAB_VAULT, type LabSection } from '../presets';

// Synthetic only. Never installed as real run history.
const identity = { sha256: 'a'.repeat(64), metadata_label: 'Read' };
const unknown = { state: 'unknown', reason: 'no_native_identity_receipt' } as const;
export function configurationFixture(): RunConfigurationManifestV1 {
  return {
    format: 1,
    run_id: 'run-scout-1',
    vault_id: 'demo',
    store_uuid: 'synthetic-store',
    dispatched_at: '2026-10-24T12:00:00Z',
    effective_grant: {
      actor_id: { ...identity, metadata_label: null },
      read_scope: { mode: 'prefixes', selectors: [{ ...identity, metadata_label: null }] },
      write_scope: { mode: 'none' },
      tools: { mode: 'restricted', selectors: [identity] },
      chain: [],
      run_kind: 'attended',
      ask_first: true,
    },
    permission_mode: 'default',
    cli_tools: [identity],
    allowed_tools: [identity],
    denied_tools: [],
    asked_tools: [],
    requested_model: { ...identity, metadata_label: null },
    requested_effort: 'high',
    observed_model_at_dispatch: { state: 'unknown', reason: 'not_observed_before_dispatch' },
    observed_cli_version: { state: 'recorded', value: { major: 2, minor: 1, patch: 250 } },
    artifacts: [{ artifact: 'shared/policy/tools.v1.json', sha256: 'b'.repeat(64) }],
    standing_agent: unknown,
    skills: unknown,
    defined_subagents: [],
    effective_system_prompt_sha256: null,
    connectors: [],
    inherits_user_mcp: false,
    user_settings: { state: 'unknown', reason: 'inherited_user_configuration' },
    settings_hardening: true,
    seated: true,
    message_transport: 'stdin',
    coverage: [],
  };
}
const failure = '[data-testid="section-unavailable"]';
const recorded =
  (manifest = configurationFixture()) =>
  () =>
    __seedRunConfigurations({ 'run-scout-1': { state: 'recorded', manifest } });
export const section: LabSection = {
  id: 'run-configuration',
  title: 'Captured run configuration',
  surface: 'Agent page › Runs › Run configuration',
  render: () => (
    <RunConfiguration vault={LAB_VAULT} runId="run-scout-1" foreign={false} defaultOpen />
  ),
  states: {
    ready: {
      note: 'Synthetic captured CLI version and safe selector identities; unobserved facts remain named.',
      seed: recorded(),
      expect: { present: ['dl'], absent: [failure], text: '2.1.250' },
    },
    empty: {
      note: 'A captured run with no loaded connectors or allowed tools.',
      seed: recorded({
        ...configurationFixture(),
        cli_tools: [],
        allowed_tools: [],
        connectors: [],
      }),
      expect: { present: ['dl'], absent: [failure], text: 'None' },
    },
    'not-recorded': {
      note: 'A run from before immutable configuration capture.',
      expect: {
        present: ['[data-testid="run-configuration"]'],
        absent: [failure, 'dl'],
        text: 'Configuration was not recorded for this run.',
      },
    },
    partial: {
      note: 'A version the native producer could not recognize; no current-version fallback.',
      seed: recorded({
        ...configurationFixture(),
        observed_cli_version: { state: 'unknown', reason: 'unrecognized_cli_version' },
      }),
      expect: { present: ['dl'], absent: [failure], text: 'version was not recognized' },
    },
    unavailable: {
      note: 'A failed configuration read offers Retry instead of a legacy or empty claim.',
      failNext: ['fleet_run_configuration'],
      expect: { present: [failure], absent: ['dl'], text: 'Configuration unavailable.' },
    },
  },
};
