import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVaultStore } from '@/stores/vaultStore';
import { Icon } from '@/components/ui/Icon';
import { fleetRunConfiguration } from '@/lib/ipc';
import type {
  RunConfigurationRead,
  RunConfigurationManifestV1,
  SelectorIdentity,
  ScopeAxis,
  ToolAxis,
} from '@/lib/runConfiguration';

function Identity({ value }: { value: SelectorIdentity }) {
  return (
    <span className="break-all">
      {value.metadata_label ?? 'label not recorded'}{' '}
      <code className="text-n-500">{value.sha256}</code>
    </span>
  );
}
function Identities({ values }: { values: SelectorIdentity[] }) {
  return values.length === 0 ? (
    <>None</>
  ) : (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {values.map((value, index) => (
        <li key={index}>
          <Identity value={value} />
        </li>
      ))}
    </ul>
  );
}
function Axis({ value }: { value: ScopeAxis | ToolAxis }) {
  if (value.mode === 'none') return <>None</>;
  if (value.mode === 'unrestricted') return <>Unrestricted</>;
  return <Identities values={value.selectors} />;
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(7rem,1fr)_minmax(0,3fr)] gap-x-3 border-b border-n-200 py-1.5 last:border-0">
      <dt className="text-n-500">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}
function unknownWords(reason: string) {
  switch (reason) {
    case 'not_observed_before_dispatch':
      return 'not observed before dispatch';
    case 'not_reported_by_native_probe':
      return 'not reported by the native probe';
    case 'unrecognized_cli_version':
      return 'version was not recognized';
    case 'no_native_identity_receipt':
      return 'identity was not recorded';
    case 'inherited_user_configuration':
      return 'inherited settings were not recorded';
    case 'spec_identity_not_supplied':
      return 'definition identity was not recorded';
    default:
      return 'not recorded';
  }
}
function Definitions({ values }: { values: { id: string; sha256: string }[] }) {
  return values.length === 0 ? (
    <>None</>
  ) : (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {values.map((value, index) => (
        <li key={index} className="break-all">
          {value.id} <code className="text-n-500">{value.sha256}</code>
        </li>
      ))}
    </ul>
  );
}
function Recorded({ manifest: m }: { manifest: RunConfigurationManifestV1 }) {
  const cli = m.observed_cli_version;
  return (
    <>
      <p className="m-0 text-n-500">
        Captured when this run started. Changes to your current settings do not change this record.
      </p>
      <dl className="m-0">
        <Fact label="Claude Code">
          {cli.state === 'recorded'
            ? `${cli.value.major}.${cli.value.minor}.${cli.value.patch}`
            : unknownWords(cli.reason)}
        </Fact>
        <Fact label="Requested model">
          {m.requested_model == null ? 'not recorded' : <Identity value={m.requested_model} />}
        </Fact>
        <Fact label="Observed model at start">
          {m.observed_model_at_dispatch.state === 'recorded'
            ? m.observed_model_at_dispatch.value
            : unknownWords(m.observed_model_at_dispatch.reason)}
        </Fact>
        <Fact label="Requested effort">{m.requested_effort ?? 'not recorded'}</Fact>
        <Fact label="Permissions">{m.permission_mode}</Fact>
        <Fact label="Actor">
          <Identity value={m.effective_grant.actor_id} />
        </Fact>
        <Fact label="Read scope">
          <Axis value={m.effective_grant.read_scope} />
        </Fact>
        <Fact label="Write scope">
          <Axis value={m.effective_grant.write_scope} />
        </Fact>
        <Fact label="Granted tools">
          <Axis value={m.effective_grant.tools} />
        </Fact>
        <Fact label="Ask before writes">{m.effective_grant.ask_first ? 'Yes' : 'No'}</Fact>
        <Fact label="CLI tools">
          <Identities values={m.cli_tools} />
        </Fact>
        <Fact label="Allowed tools">
          <Identities values={m.allowed_tools} />
        </Fact>
        <Fact label="Denied tools">
          <Identities values={m.denied_tools} />
        </Fact>
        <Fact label="Tools requiring a decision">
          <Identities values={m.asked_tools} />
        </Fact>
        <Fact label="Agent definition">
          {m.standing_agent.state === 'recorded' ? (
            <Definitions values={[m.standing_agent.value]} />
          ) : (
            unknownWords(m.standing_agent.reason)
          )}
        </Fact>
        <Fact label="Skills">
          {m.skills.state === 'recorded' ? (
            <Definitions values={m.skills.value} />
          ) : (
            unknownWords(m.skills.reason)
          )}
        </Fact>
        <Fact label="Subagent definitions">
          <Definitions values={m.defined_subagents} />
        </Fact>
        <Fact label="Connectors">
          {m.connectors.length === 0 ? (
            'None'
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {m.connectors.map((value, index) => (
                <li key={index}>
                  <Identity value={value.cli_id} />
                  <span className="block text-n-500">
                    Definition:{' '}
                    {value.spec_identity.state === 'recorded'
                      ? value.spec_identity.value
                      : unknownWords(value.spec_identity.reason)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Fact>
        <Fact label="Inherited MCP servers">{m.inherits_user_mcp ? 'Yes' : 'No'}</Fact>
        <Fact label="User settings">
          {m.user_settings.state === 'unknown' ? unknownWords(m.user_settings.reason) : 'Recorded'}
        </Fact>
        <Fact label="Permission safeguards">
          {m.settings_hardening ? 'Applied' : 'Not applied'}
        </Fact>
        <Fact label="Attended">{m.seated ? 'Yes' : 'No'}</Fact>
        <Fact label="System instruction identity">
          {m.effective_system_prompt_sha256 == null ? (
            'not recorded'
          ) : (
            <code className="break-all">{m.effective_system_prompt_sha256}</code>
          )}
        </Fact>
        <Fact label="Policy identities">
          {m.artifacts.length === 0 ? (
            'None'
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {m.artifacts.map((value, index) => (
                <li key={index} className="break-all">
                  {value.artifact} <code className="text-n-500">{value.sha256}</code>
                </li>
              ))}
            </ul>
          )}
        </Fact>
      </dl>
    </>
  );
}
function Body({
  vault,
  runId,
  foreign,
  opening,
}: {
  vault: string | null;
  runId: string;
  foreign: boolean;
  opening: RefObject<number>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<RunConfigurationRead | null>(null);
  useEffect(() => {
    if (vault === null) return;
    let live = true;
    const generation = opening.current;
    setValue(null);
    void fleetRunConfiguration(vault, runId).then(
      (result) => {
        if (live && opening.current === generation) setValue(result);
      },
      () => {
        if (live && opening.current === generation)
          setValue({ state: 'unavailable', code: 'storage_unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [vault, runId, attempt, opening]);
  if (vault === null)
    return (
      <p data-testid="section-unavailable">
        {foreign
          ? 'Open this run’s vault to inspect its configuration.'
          : 'Configuration unavailable.'}
      </p>
    );
  if (value === null) return <p role="status">Reading configuration…</p>;
  if (value.state === 'unavailable')
    return (
      <div data-testid="section-unavailable">
        <p>Configuration unavailable.</p>
        <button
          type="button"
          className="text-cortex-600 underline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry configuration
        </button>
      </div>
    );
  if (value.state === 'not_recorded') {
    const words = {
      legacy: 'Configuration was not recorded for this run.',
      expired: 'Configuration expired.',
      deleted: 'Configuration deleted.',
      capture_failed: 'Configuration capture failed.',
    };
    return <p>{words[value.reason]}</p>;
  }
  return <Recorded manifest={value.manifest} />;
}
/** The parent keys this by the run, resolved origin and current opening. A closed
 * disclosure unmounts its reader and retires its pending promise. No settings are
 * queried, no current authority is reconstructed, and nothing is copied to disk. */
export function RunConfiguration(props: {
  runId: string;
  vault: string | null;
  foreign: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const contentId = useId();
  const opening = useRef(0);
  // Observe every store transition synchronously: React may batch A → B → A
  // into one render with the same final key. Retire the old read immediately,
  // and require a deliberate reopen instead of automatically reading again.
  useLayoutEffect(
    () =>
      useVaultStore.subscribe((state, previous) => {
        if (
          state.vaultPath !== previous.vaultPath ||
          state.entriesVault !== previous.entriesVault ||
          state.status !== previous.status
        ) {
          opening.current += 1;
          setOpen(false);
        }
      }),
    [],
  );
  return (
    <section
      data-testid="run-configuration"
      className="flex min-w-0 flex-col gap-2 text-2xs text-n-600"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 self-start border-0 bg-transparent p-0 text-left"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} color="var(--n-400)" />
        <span className="font-semibold uppercase tracking-[0.06em] text-n-500">
          Run configuration
        </span>
      </button>
      {open && (
        <div
          id={contentId}
          role="region"
          aria-label="Run configuration facts"
          tabIndex={0}
          className="max-h-96 min-w-0 overflow-auto rounded-md border border-n-200 bg-n-0 p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cortex-500"
        >
          <Body {...props} opening={opening} />
        </div>
      )}
    </section>
  );
}
