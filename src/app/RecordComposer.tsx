import type { CreationContext } from '@/engine/creationDestination';
import { CreationDestinationField } from './CreationDestinationField';
import { CreationDraftRecovery } from './CreationDraftRecovery';
import { CreationTransferChoice } from './CreationTransferChoice';
import { useCreationSession } from './useCreationSession';
import { keysText } from '@/components/ui/Keycaps';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { createTarget } from '@/engine/createRecord';
import { composerFields, draftEntry, initialValues, pickSimilar } from '@/engine/recordDraft';
import { isReservedTypeName, typeStyle } from '@/engine/typeCatalog';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { useContentSearch } from './useContentSearch';

/** Session-owned capture. Closing releases the dialog, not its draft or write. */
export function RecordComposer({
  defaultTitle = '',
  onClose,
  context: suppliedContext,
}: {
  defaultTitle?: string;
  onClose: () => void;
  context?: CreationContext;
}) {
  const entries = useVaultStore((state) => state.entries);
  const vault = useVaultStore((state) => state.vaultPath);
  const schema = useSchema();
  const types = [...schema.types.keys()]
    .filter((type) => !isReservedTypeName(type))
    .sort((a, b) => a.localeCompare(b));
  const [origin] = useState<CreationContext>(
    () =>
      suppliedContext ?? {
        vault: vault ?? '',
        pane: useNavStore.getState().active,
        destination: { kind: 'record', typeName: types[0] ?? '', host: null, group: null },
      },
  );
  const titleBox = useRef<HTMLLabelElement>(null);
  const databaseId = useId();
  const open = (path: string) => {
    onClose();
    useUiStore.getState().closeDetail();
    useNavStore.getState().navigate({ kind: 'doc', path });
  };
  const session = useCreationSession(
    origin,
    (ctx) => {
      const dest = ctx.destination;
      if (dest.kind !== 'record') return { title: defaultTitle, values: {} };
      const host = entries.find((entry) => entry.path === dest.host?.path);
      const target = createTarget(dest.typeName, {
        entries,
        schema,
        host: host === undefined || dest.host === null ? null : { host, field: dest.host.field },
        groupBy: dest.group?.field,
        groupValue: dest.group?.value,
      });
      const { type: _type, key: _key, ...seeds } = target.frontmatter;
      void _type;
      void _key;
      return { title: defaultTitle, values: { ...initialValues(dest.typeName, schema), ...seeds } };
    },
    (submission) => {
      if (submission.snapshot.createMore) {
        titleBox.current?.querySelector('input')?.focus();
        useUiStore.getState().toast(`Created “${submission.snapshot.title.trim()}”`);
      } else if (submission.path !== null) open(submission.path);
    },
  );
  const { draft, pending: submitting } = session;
  const type =
    session.context.destination.kind === 'record' ? session.context.destination.typeName : '';
  const title = draft.title,
    values = draft.values,
    more = draft.createMore;
  const error =
    session.saved?.revision === draft.revision ? session.saved.formError : draft.formError;
  const content = useContentSearch(vault, title, type !== '');
  const similar = content.status === 'ready' ? pickSimilar(content.result, type, entries) : [];
  const entry = draftEntry(type, values, title);
  const candidates = stripCells(entry, schema, composerFields(type, schema), true);
  const retainedScalars = Object.entries(draft.scalarDrafts ?? {}).filter(([name, edit]) => {
    const field = candidates.find((field) => field.name === name);
    return field === undefined || (edit.kind !== undefined && edit.kind !== field.kind);
  });
  const retainedNames = new Set(retainedScalars.map(([name]) => name));
  const fields = candidates.filter((field) => !retainedNames.has(field.name));
  useEffect(() => {
    if (origin.vault !== vault) onClose();
  }, [vault, onClose, origin]);
  const patch = (change: Record<string, unknown>) =>
    session.update((previous) => ({ values: { ...previous.values, ...change }, formError: null }));
  const changeType = (typeName: string) =>
    session.changeDestination({ kind: 'record', typeName, host: null, group: null });
  const create = session.submit;
  return (
    <div
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          (event.metaKey || event.ctrlKey) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          void create();
        }
      }}
    >
      <Dialog
        open
        title="New record"
        footerNote={`${keysText('mod+enter')} · Drafts last for this session`}
        onClose={onClose}
        primaryAction={{
          label: submitting ? 'Creating…' : 'Create record',
          onClick: () => void create(),
          disabled:
            type === '' ||
            submitting ||
            session.recovering ||
            !session.claimed ||
            session.transfer !== null,
        }}
        secondaryAction={{ label: 'Cancel', onClick: onClose }}
      >
        {session.recovering || !session.claimed ? (
          <CreationDraftRecovery
            pending={submitting}
            occupied={!session.claimed}
            onResume={session.resume}
            onDiscard={session.discard}
          />
        ) : (
          <>
            <CreationDestinationField
              destination={session.context.destination}
              entries={entries}
              schema={schema}
              onChange={session.changeDestination}
            />
            <CreationTransferChoice session={session} />
            <div data-testid="record-composer" className="flex flex-col gap-4">
              <label ref={titleBox} className="flex flex-col gap-1 text-xs text-n-600">
                Title
                <Input
                  testId="composer-title"
                  autoFocus
                  ariaLabel="Title"
                  placeholder="What is it called?"
                  width="100%"
                  value={title}
                  disabled={submitting}
                  onChange={(event) => {
                    session.update({ title: event.target.value, formError: null });
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      void create();
                    }
                  }}
                />
              </label>
              <div className="flex flex-col gap-1 text-xs text-n-600">
                <label htmlFor={databaseId}>Database</label>
                <Select
                  id={databaseId}
                  testId="composer-database"
                  value={type}
                  disabled={submitting}
                  options={types.map((name) => ({ value: name, label: name }))}
                  width="100%"
                  onChange={changeType}
                />
                {types.length === 0 && (
                  <span className="text-2xs text-n-500">
                    No databases yet — create one from the Databases section of the sidebar first.
                  </span>
                )}
              </div>
              <fieldset disabled={submitting} className="m-0 min-w-0 border-0 p-0">
                <HeadingProperties
                  key={type}
                  entry={entry}
                  fields={fields}
                  schema={schema}
                  showEmpty
                  onPatch={patch}
                  scalarDrafts={draft.scalarDrafts}
                  onScalarDraftChange={(field, edit) =>
                    session.update((previous) => {
                      const scalarDrafts = { ...previous.scalarDrafts },
                        fieldErrors = { ...previous.fieldErrors };
                      if (edit === null) {
                        delete scalarDrafts[field];
                        delete fieldErrors[field];
                      } else {
                        scalarDrafts[field] = {
                          ...edit,
                          kind: schema.types.get(type)?.fields.find((def) => def.name === field)
                            ?.kind,
                        };
                        if (edit.error !== null) fieldErrors[field] = edit.error;
                        else delete fieldErrors[field];
                      }
                      return { scalarDrafts, fieldErrors };
                    })
                  }
                />
              </fieldset>
              {retainedScalars.length > 0 && (
                <section aria-label="Retained field edits" className="flex flex-col gap-3">
                  <p className="m-0 text-xs text-n-600">
                    These unfinished fields changed in the database or left the composer. Their
                    exact input is kept. Discard an affected value to continue with the current
                    fields.
                  </p>
                  {retainedScalars.map(([name, edit]) => (
                    <div
                      key={name}
                      className="flex flex-col gap-2 rounded-md border border-n-200 p-3"
                    >
                      <span className="text-xs text-n-600">Retained {name}</span>
                      <code className="whitespace-pre-wrap break-words rounded-md border border-n-300 bg-n-0 p-2 text-sm text-n-900">
                        {edit.text}
                      </code>
                      {edit.error !== null && (
                        <p className="m-0 text-xs text-danger-600">{edit.error}</p>
                      )}
                      <button
                        type="button"
                        disabled={submitting}
                        className="self-start text-xs text-n-700 underline"
                        onClick={() =>
                          session.update((previous) => {
                            const scalarDrafts = { ...previous.scalarDrafts },
                              fieldErrors = { ...previous.fieldErrors },
                              values = { ...previous.values };
                            delete scalarDrafts[name];
                            delete fieldErrors[name];
                            delete values[name];
                            return { scalarDrafts, fieldErrors, values, formError: null };
                          })
                        }
                      >
                        Discard {name} value
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {similar.length > 0 && (
                <section data-testid="similar-records" className="flex flex-col gap-1">
                  <h3 className="m-0 text-xs font-medium text-n-500">Similar records</h3>
                  {similar.map((record) => (
                    <button
                      key={record.path}
                      type="button"
                      data-testid="similar-record"
                      disabled={submitting}
                      onClick={() => open(record.path)}
                      className="flex items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm text-n-700 hover:bg-n-50"
                    >
                      <Icon
                        name={typeStyle(record.type, schema).icon}
                        size={14}
                        color="var(--n-400)"
                      />
                      <span className="truncate">{record.title}</span>
                    </button>
                  ))}
                </section>
              )}
              {content.status === 'unavailable' && (
                <p data-testid="similar-unavailable" className="m-0 text-xs text-n-500">
                  Couldn't check for similar records.
                </p>
              )}
              {error !== null && (
                <p
                  data-testid="composer-error"
                  role="alert"
                  className="m-0 text-xs text-danger-600"
                >
                  {error}
                </p>
              )}
              <label className="flex items-center gap-2 text-sm text-n-600">
                <input
                  type="checkbox"
                  data-testid="composer-create-more"
                  checked={more}
                  disabled={submitting}
                  onChange={(event) => session.update({ createMore: event.target.checked })}
                />
                Create more
              </label>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
