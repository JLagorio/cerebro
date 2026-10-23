import { useEffect, useId, useRef, useState } from 'react';
import { createPromoted, type PromotionResult } from '@/app/promoteActions';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { planLine, promotionMapping, promotionTargets, type ChecklistLine } from '@/engine/promote';
import { humanize } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

const TARGET_KEY = 'cerebro.promoteTarget';
const savedTarget = () => {
  try {
    return localStorage.getItem(TARGET_KEY);
  } catch {
    return null;
  }
};

export function PromoteDialog({
  lines,
  source,
  onClose,
  onCreated,
}: {
  lines: ChecklistLine[];
  source: Entry | null;
  onClose: () => void;
  onCreated: (results: PromotionResult[]) => PromotionResult[];
}) {
  const entries = useVaultStore((state) => state.entries);
  const vault = useVaultStore((state) => state.vaultPath);
  const schema = useSchema();
  const targets = promotionTargets(schema);
  const [target, setTarget] = useState(() => {
    const saved = savedTarget();
    return targets.find((type) => type.name === saved)?.name ?? targets[0]?.name ?? '';
  });
  const mapping = promotionMapping(target, source, schema);
  const [person, setPerson] = useState<string | null>(() => mapping?.people[0]?.name ?? null);
  const [parent, setParent] = useState<string | null>(() => mapping?.parentDefault ?? null);
  const [results, setResults] = useState<PromotionResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const openedVault = useRef(vault);
  const ids = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (openedVault.current !== vault) onClose();
  }, [vault, onClose]);

  const chooseTarget = (name: string) => {
    setTarget(name);
    const next = promotionMapping(name, source, schema);
    setPerson(next?.people[0]?.name ?? null);
    setParent(next?.parentDefault ?? null);
    try {
      localStorage.setItem(TARGET_KEY, name);
    } catch {
      /* A preference failure cannot block promotion. */
    }
  };
  const promote = async () => {
    if (
      pending.current ||
      mapping === null ||
      openedVault.current !== useVaultStore.getState().vaultPath
    )
      return;
    pending.current = true;
    setBusy(true);
    try {
      const created = await createPromoted(lines, target, source, { person, parent }, schema);
      if (mounted.current && openedVault.current === useVaultStore.getState().vaultPath)
        setResults(onCreated(created));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Promote to records"
      onClose={busy ? undefined : onClose}
      primaryAction={
        results === null
          ? {
              label: `Promote ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
              disabled: busy || mapping === null,
              onClick: () => void promote(),
            }
          : { label: 'Done', onClick: onClose }
      }
      secondaryAction={
        results === null ? { label: 'Cancel', onClick: onClose, disabled: busy } : undefined
      }
    >
      <div data-testid="promote-dialog" className="flex flex-col gap-3">
        {targets.length === 0 ? (
          <p data-testid="promote-none" className="m-0 text-sm text-n-500">
            No database tracks status yet. Add a Status property to one first.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1 text-xs text-n-600">
              <label htmlFor={`${ids}-target`}>Database</label>
              <Select
                id={`${ids}-target`}
                testId="promote-target"
                value={target}
                options={targets.map((type) => ({ value: type.name, label: type.name }))}
                onChange={chooseTarget}
                disabled={busy || results !== null}
                width="100%"
              />
            </div>
            {mapping !== null && mapping.people.length > 1 && (
              <div className="flex flex-col gap-1 text-xs text-n-600">
                <label htmlFor={`${ids}-person`}>People</label>
                <Select
                  id={`${ids}-person`}
                  testId="promote-person"
                  value={person ?? ''}
                  options={mapping.people.map((field) => ({
                    value: field.name,
                    label: humanize(field.name),
                  }))}
                  onChange={setPerson}
                  disabled={busy || results !== null}
                  width="100%"
                />
              </div>
            )}
            {mapping !== null && mapping.parents.length > 1 && (
              <div className="flex flex-col gap-1 text-xs text-n-600">
                <label htmlFor={`${ids}-parent`}>Parent</label>
                <Select
                  id={`${ids}-parent`}
                  testId="promote-parent"
                  value={parent ?? ''}
                  options={[
                    { value: '', label: 'No parent' },
                    ...mapping.parents.map((field) => ({
                      value: field.name,
                      label: humanize(field.name),
                    })),
                  ]}
                  onChange={(field) => setParent(field || null)}
                  disabled={busy || results !== null}
                  width="100%"
                />
              </div>
            )}
          </>
        )}
        <div className="flex flex-col divide-y divide-n-100">
          {lines.map((line) => {
            const result = results?.find((row) => row.line.blockId === line.blockId);
            const preview =
              mapping === null
                ? null
                : planLine(line, target, source, mapping, { person, parent }, entries, schema);
            const notes =
              result?.outcome === 'created'
                ? result.notes
                : result === undefined && preview?.kind === 'create'
                  ? preview.notes
                  : [];
            return (
              <div
                key={line.blockId}
                data-testid="promote-line"
                className="py-2 text-sm text-n-800"
              >
                <span>{line.title || 'Empty line'}</span>
                {result !== undefined && (
                  <div
                    data-testid="promote-result"
                    data-outcome={result.outcome}
                    className="mt-1 text-xs text-n-500"
                  >
                    {result.outcome === 'created' ? (
                      <button
                        type="button"
                        className="border-0 bg-transparent p-0 text-cortex-600 hover:underline"
                        onClick={() => {
                          onClose();
                          useNavStore.getState().navigate({ kind: 'doc', path: result.path });
                        }}
                      >
                        Created — open record
                      </button>
                    ) : (
                      result.reason
                    )}
                  </div>
                )}
                {notes.map((note) => (
                  <p key={note} className="m-0 mt-1 text-xs text-n-500">
                    {note}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
