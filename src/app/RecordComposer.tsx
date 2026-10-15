import { keysText } from '@/components/ui/Keycaps';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { HeadingProperties } from '@/detail/HeadingProperties';
import { createTarget } from '@/engine/createRecord';
import {
  composerFields,
  draftEntry,
  draftFrontmatter,
  initialValues,
  pickSimilar,
  recordSlug,
} from '@/engine/recordDraft';
import { isReservedTypeName, typeStyle } from '@/engine/typeCatalog';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { useContentSearch } from './useContentSearch';

/** A local draft: its fields share the record editors, but no page exists
 * until Create. Closing discards the draft and every choice made here. */
export function RecordComposer({
  defaultTitle = '',
  onClose,
}: {
  defaultTitle?: string;
  onClose: () => void;
}) {
  const entries = useVaultStore((state) => state.entries);
  const vault = useVaultStore((state) => state.vaultPath);
  const createItem = useVaultStore((state) => state.createItem);
  const schema = useSchema();
  const types = [...schema.types.keys()]
    .filter((type) => !isReservedTypeName(type))
    .sort((a, b) => a.localeCompare(b));
  const [type, setType] = useState(types[0] ?? '');
  const [title, setTitle] = useState(defaultTitle);
  const [values, setValues] = useState(() => initialValues(type, schema));
  const valuesRef = useRef(values);
  const [more, setMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fix (M1): same-tick Enter/click must share a guard before React rerenders.
  const pending = useRef(false);
  const mounted = useRef(true);
  const openedVault = useRef(vault);
  const titleBox = useRef<HTMLLabelElement>(null);
  const refocus = useRef(false);
  const content = useContentSearch(vault, title, type !== '');
  const similar = content.status === 'ready' ? pickSimilar(content.result, type, entries) : [];
  const fields = composerFields(type, schema);
  const entry = draftEntry(type, values, title);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (openedVault.current !== vault) onClose();
  }, [vault, onClose]);
  useEffect(() => {
    if (!submitting && refocus.current) {
      refocus.current = false;
      titleBox.current?.querySelector('input')?.focus();
    }
  }, [submitting]);

  const patch = (change: Record<string, unknown>) => {
    valuesRef.current = { ...valuesRef.current, ...change };
    setValues(valuesRef.current);
    setError(null);
  };
  const changeType = (next: string) => {
    setType(next);
    valuesRef.current = initialValues(next, schema);
    setValues(valuesRef.current);
    setError(null);
  };
  const open = (path: string) => {
    onClose();
    useUiStore.getState().closeDetail();
    useNavStore.getState().navigate({ kind: 'doc', path });
  };
  const create = async () => {
    if (pending.current || openedVault.current !== useVaultStore.getState().vaultPath) return;
    const name = title.trim().replace(/\s+/g, ' ');
    if (name === '') {
      setError('Give it a title');
      return;
    }
    if (type === '' || !types.includes(type)) return;
    const target = createTarget(type, { entries, schema });
    const draft = draftFrontmatter(target.frontmatter, valuesRef.current, type, schema);
    if (draft.problems.length > 0) {
      setError(draft.problems.join('. '));
      return;
    }
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const path = await createItem({
        folder: target.folder,
        slug: recordSlug(name, `record-${Date.now().toString(36)}`),
        frontmatter: draft.frontmatter,
        body: `# ${name}\n`,
      });
      if (!mounted.current || openedVault.current !== useVaultStore.getState().vaultPath) return;
      if (more) {
        setTitle('');
        refocus.current = true;
        useUiStore.getState().toast(`Created “${name}”`);
      } else open(path);
    } catch {
      if (mounted.current && openedVault.current === useVaultStore.getState().vaultPath)
        useUiStore.getState().toast(`Couldn't create “${name}”`);
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

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
        footerNote={keysText('mod+enter')}
        onClose={onClose}
        primaryAction={{
          label: 'Create record',
          onClick: () => void create(),
          disabled: type === '' || submitting,
        }}
        secondaryAction={{ label: 'Cancel', onClick: onClose }}
      >
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
                setTitle(event.target.value);
                setError(null);
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
          <label className="flex flex-col gap-1 text-xs text-n-600">
            Database
            <Select
              testId="composer-database"
              value={type}
              disabled={submitting}
              options={types.map((name) => ({ value: name, label: name }))}
              width="100%"
              onChange={(event) => changeType(event.target.value)}
            />
            {types.length === 0 && (
              <span className="text-2xs text-n-500">
                No databases yet — create one from the Databases section of the sidebar first.
              </span>
            )}
          </label>
          <fieldset disabled={submitting} className="m-0 min-w-0 border-0 p-0">
            <HeadingProperties
              key={type}
              entry={entry}
              fields={fields}
              schema={schema}
              showEmpty
              onPatch={patch}
            />
          </fieldset>
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
                  <Icon name={typeStyle(record.type, schema).icon} size={14} color="var(--n-400)" />
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
            <p data-testid="composer-error" role="alert" className="m-0 text-xs text-danger-600">
              {error}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-n-600">
            <input
              type="checkbox"
              data-testid="composer-create-more"
              checked={more}
              disabled={submitting}
              onChange={(event) => setMore(event.target.checked)}
            />
            Create more
          </label>
        </div>
      </Dialog>
    </div>
  );
}
