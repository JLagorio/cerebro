import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import ACTION_POLICY from '../../shared/policy/actions.v1.json';
import type { AccessSelection, createRunActionAccessSession } from './managedActionAccessSession';

export interface ManagedActionAccessProps {
  open: boolean;
  onClose: () => void;
  session: ReturnType<typeof createRunActionAccessSession>;
}
export function ManagedActionAccess({ open, onClose, session }: ManagedActionAccessProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [accountKey, setAccountKey] = useState('');
  const [actionKey, setActionKey] = useState('');
  const [inputScope, setInputScope] = useState('all');
  const [exact, setExact] = useState('');
  const inputId = useId();
  useEffect(() => {
    if (open && session.getSnapshot().phase === 'idle') void session.refresh();
  }, [open, session]);
  const view = state.view;
  const editable = !state.retired && state.phase === 'ready';
  const showChoices = view !== null && (editable || state.phase === 'saving');
  const finished = state.retired || state.phase === 'saved' || state.phase === 'closed';
  const account = view?.accounts.find(
    (item) => key(item.connectionId, item.accountId) === accountKey,
  );
  const definition = view?.definitions.find(
    (item) => key(item.actionId, item.definitionDigest) === actionKey,
  );
  const canAdd =
    editable &&
    account !== undefined &&
    definition !== undefined &&
    (inputScope === 'all' || exact.trim().length > 0) &&
    state.selections.length < ACTION_POLICY.admission.limits.grantsPerRun;
  const add = () => {
    if (!canAdd || account === undefined || definition === undefined) return;
    const choice: AccessSelection = {
      kind: 'new',
      selection: {
        connectionId: account.connectionId,
        accountId: account.accountId,
        accountRevision: account.accountRevision,
        revocationGeneration: account.revocationGeneration,
        actionId: definition.actionId,
        definitionDigest: definition.definitionDigest,
        inputScope:
          inputScope === 'all'
            ? { kind: 'all_valid_inputs' }
            : { kind: 'exact_canonical_input', input: exact },
      },
    };
    if (!state.selections.some((item) => JSON.stringify(item) === JSON.stringify(choice))) {
      session.select([...state.selections, choice]);
    }
    setAccountKey('');
    setActionKey('');
    setInputScope('all');
    setExact('');
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Access for this run"
      width={600}
      primaryAction={{
        label: finished ? 'Close' : state.phase === 'saving' ? 'Saving…' : 'Done',
        disabled: !finished && !editable,
        onClick: finished
          ? onClose
          : () => {
              void session.save();
            },
      }}
      secondaryAction={finished ? undefined : { label: 'Close', onClick: onClose }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <p className="m-0 text-ui text-(--text-meta)">
          Choose the accounts and actions available to this run. External changes still need your
          approval.
        </p>
        {(state.phase === 'loading' || state.phase === 'idle') && (
          <p role="status" className="m-0 text-ui">
            Loading current access…
          </p>
        )}
        {state.phase === 'saving' && (
          <p role="status" className="m-0 text-ui">
            Saving access for the original run…
          </p>
        )}
        {state.failure !== null && (
          <p
            role="alert"
            data-testid={state.phase === 'unavailable' ? 'section-unavailable' : undefined}
            className="m-0 text-ui text-warn-700"
          >
            {state.failure}
          </p>
        )}
        {state.notice !== null && (
          <p role="status" className="m-0 text-ui">
            {state.notice}
          </p>
        )}
        {!state.retired && (state.phase === 'unknown' || state.phase === 'unavailable') && (
          <Button
            className="self-start"
            size="sm"
            onClick={() => {
              void session.refresh();
            }}
          >
            Reload current access
          </Button>
        )}
        {showChoices && (
          <>
            <section aria-label="Selected actions" className="min-w-0">
              <h3 className="m-0 mb-2 text-ui font-medium">Selected actions</h3>
              {state.selections.length === 0 ? (
                <p className="m-0 text-ui text-(--text-meta)">No actions selected.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {state.selections.map((choice, index) => {
                    const detail =
                      choice.kind === 'new'
                        ? choice.selection
                        : view.grants.find((grant) => grant.grantId === choice.grantId);
                    if (detail === undefined) return null;
                    const label =
                      view.accounts.find(
                        (item) =>
                          item.connectionId === detail.connectionId &&
                          item.accountId === detail.accountId,
                      )?.label ?? detail.accountId;
                    return (
                      <li
                        key={choice.kind === 'preserve' ? choice.grantId : `new-${index}`}
                        className="flex min-w-0 flex-wrap items-start gap-2 rounded-md border border-n-200 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="m-0 break-words text-ui font-medium">{detail.actionId}</p>
                          <p className="m-0 break-words text-metadata text-(--text-meta)">
                            {label} ·{' '}
                            {detail.inputScope.kind === 'all_valid_inputs'
                              ? 'All valid inputs'
                              : 'Exact inputs only'}
                            {'available' in detail && !detail.available ? ' · Unavailable' : ''}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          disabled={!editable}
                          onClick={() => {
                            session.select(state.selections.filter((_, item) => item !== index));
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <section
              aria-label="Add access"
              className="flex min-w-0 flex-col gap-3 border-t border-n-200 pt-4"
            >
              <h3 className="m-0 text-ui font-medium">Add an action</h3>
              {view.accounts.length === 0 && (
                <p className="m-0 text-ui text-(--text-meta)">
                  No managed account is ready. Import a credential in Settings to make it available
                  here.
                </p>
              )}
              {view.definitions.length === 0 && (
                <p className="m-0 text-ui text-(--text-meta)">No managed actions are available.</p>
              )}
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  ariaLabel="Account"
                  value={accountKey}
                  onChange={setAccountKey}
                  placeholder="Choose an account"
                  disabled={!editable || view.accounts.length === 0}
                  width="100%"
                  options={view.accounts.map((item) => ({
                    value: key(item.connectionId, item.accountId),
                    label: item.label,
                  }))}
                />
                <Select
                  ariaLabel="Action"
                  value={actionKey}
                  onChange={(next) => {
                    setActionKey(next);
                    setExact('');
                  }}
                  placeholder="Choose an action"
                  disabled={!editable || view.definitions.length === 0}
                  width="100%"
                  options={view.definitions.map((item) => ({
                    value: key(item.actionId, item.definitionDigest),
                    label: item.actionId,
                  }))}
                />
              </div>
              {definition !== undefined && (
                <div className="flex min-w-0 flex-col gap-2">
                  <Select
                    ariaLabel="Allowed inputs"
                    value={inputScope}
                    onChange={setInputScope}
                    disabled={!editable}
                    width="100%"
                    options={[
                      { value: 'all', label: 'All valid inputs' },
                      { value: 'exact', label: 'Only these exact inputs' },
                    ]}
                  />
                  {inputScope === 'exact' && (
                    <div className="flex min-w-0 flex-col gap-1 text-ui">
                      <label htmlFor={inputId}>Exact action inputs</label>
                      <textarea
                        aria-describedby={`${inputId}-help`}
                        id={inputId}
                        rows={4}
                        value={exact}
                        readOnly={!editable}
                        maxLength={ACTION_POLICY.limits.inputBytes}
                        onChange={(event) => {
                          setExact(event.target.value);
                        }}
                        spellCheck={false}
                        placeholder="JSON inputs for this action"
                        className="w-full min-w-0 resize-y rounded-md border border-n-300 bg-n-0 p-2 font-mono text-metadata text-n-900"
                      />
                      <span id={`${inputId}-help`} className="text-metadata text-(--text-meta)">
                        The app checks these inputs when you select Done.
                      </span>
                    </div>
                  )}
                </div>
              )}
              <Button className="self-start" size="sm" disabled={!canAdd} onClick={add}>
                Add action
              </Button>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

function key(first: string, second: string) {
  return JSON.stringify([first, second]);
}
