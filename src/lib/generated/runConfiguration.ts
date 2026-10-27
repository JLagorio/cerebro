// Generated from Rust-owned JSON Schema. Do not edit.

// Regenerate with the commands in shared/workspace/README.md.

export type ArtifactIdentity = { artifact: string; sha256: string };

export type CommandReply =
  | { manifest: RunConfigurationManifestV1; state: 'recorded' }
  | { reason: NotRecordedReason; state: 'not_recorded' }
  | { code: ConfigurationUnavailableCode; state: 'unavailable' };

export type ConfigurationUnavailableCode =
  'storage_unavailable' | 'opening_changed' | 'scope_unavailable';

export type ConnectorIdentity = { cli_id: SelectorIdentity; spec_identity: Known_for_String };

export type DefinitionIdentity = { id: string; sha256: string };

export type EffectiveGrant = {
  actor_id: SelectorIdentity;
  ask_first: boolean;
  chain: Array<SelectorIdentity>;
  read_scope: ScopeAxis;
  run_kind: string;
  tools: ToolAxis;
  write_scope: ScopeAxis;
};

export type Known_for_Array_of_DefinitionIdentity =
  | { state: 'recorded'; value: Array<DefinitionIdentity> }
  | { reason: UnknownReason; state: 'unknown' };

export type Known_for_DefinitionIdentity =
  { state: 'recorded'; value: DefinitionIdentity } | { reason: UnknownReason; state: 'unknown' };

export type Known_for_Null =
  { state: 'recorded'; value: null } | { reason: UnknownReason; state: 'unknown' };

export type Known_for_StrictCliVersion =
  { state: 'recorded'; value: StrictCliVersion } | { reason: UnknownReason; state: 'unknown' };

export type Known_for_String =
  { state: 'recorded'; value: string } | { reason: UnknownReason; state: 'unknown' };

export type NotRecordedReason = 'legacy' | 'expired' | 'deleted' | 'capture_failed';

export type RunConfigurationManifestV1 = {
  allowed_tools: Array<SelectorIdentity>;
  artifacts: Array<ArtifactIdentity>;
  asked_tools: Array<SelectorIdentity>;
  cli_tools: Array<SelectorIdentity>;
  connectors: Array<ConnectorIdentity>;
  coverage: Array<string>;
  defined_subagents: Array<DefinitionIdentity>;
  denied_tools: Array<SelectorIdentity>;
  dispatched_at: string;
  effective_grant: EffectiveGrant;
  effective_system_prompt_sha256?: string | null;
  format: number;
  inherits_user_mcp: boolean;
  message_transport: string;
  observed_cli_version: Known_for_StrictCliVersion;
  observed_model_at_dispatch: Known_for_String;
  permission_mode: string;
  requested_effort?: string | null;
  requested_model?: SelectorIdentity | null;
  run_id: string;
  seated: boolean;
  settings_hardening: boolean;
  skills: Known_for_Array_of_DefinitionIdentity;
  standing_agent: Known_for_DefinitionIdentity;
  store_uuid?: string | null;
  user_settings: Known_for_Null;
  vault_id: string;
};

export type ScopeAxis =
  | { mode: 'unrestricted' }
  | { mode: 'none' }
  | { mode: 'prefixes'; selectors: Array<SelectorIdentity> };

export type SelectorIdentity = { metadata_label?: string | null; sha256: string };

export type StrictCliVersion = { major: number; minor: number; patch: number };

export type ToolAxis =
  | { mode: 'unrestricted' }
  | { mode: 'none' }
  | { mode: 'restricted'; selectors: Array<SelectorIdentity> };

export type UnknownReason =
  | 'not_observed_before_dispatch'
  | 'not_reported_by_native_probe'
  | 'unrecognized_cli_version'
  | 'no_native_identity_receipt'
  | 'inherited_user_configuration'
  | 'spec_identity_not_supplied';
