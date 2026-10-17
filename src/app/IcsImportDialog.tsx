import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { parseIcs } from '@/engine/ics';
import {
  defaultIcsMapping,
  icsTargets,
  NO_DATED_DATABASE,
  planIcsImport,
  type IcsCounts,
  type IcsMapping,
} from '@/engine/icsImport';
import type { ImportInput } from '@/engine/inlets';
import { humanize } from '@/engine/schema';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { importIcs, readIcsFile } from './icsActions';

const COUNT_LABELS: Record<keyof IcsCounts, string> = {
  cancelled: 'Cancelled events skipped',
  missingUid: 'Events without a usable UID skipped',
  duplicate: 'Duplicate events skipped',
  unreadableStart: 'Events with unreadable starts skipped',
  untitled: 'Untitled events',
  allDay: 'All-day events',
  point: 'Point events',
  repeating: 'Repeating events',
  overrides: 'Series overrides',
  peopleLinked: 'People linked',
  peopleUnlinked: 'People without a unique matching page',
  addressesRemoved: 'Address occurrences removed',
  unknownZone: 'Unknown-zone events kept as local times',
  dstEdge: 'Daylight-saving gaps or overlaps kept as local times',
  secondsDropped: 'Events rounded-sm down to the minute',
  invalidEnd: 'Unreadable ends omitted',
};
export function IcsImportDialog(props: {
  input?: ImportInput;
  initialType?: string;
  shouldNavigate?: () => boolean;
  onClose: () => void;
}) {
  const vault = useVaultStore((state) => state.vaultPath);
  return <CalendarDraft key={vault ?? ''} {...props} />;
}
function CalendarDraft({
  input,
  initialType,
  shouldNavigate,
  onClose,
}: {
  input?: ImportInput;
  initialType?: string;
  shouldNavigate?: () => boolean;
  onClose: () => void;
}) {
  const entries = useVaultStore((state) => state.entries);
  const schema = useSchema();
  const targets = useMemo(() => icsTargets(schema), [schema]);
  const [mapping, setMapping] = useState<IcsMapping | null>(() => {
    const type = targets.find((row) => row.name === initialType) ?? targets[0];
    return type ? defaultIcsMapping(type) : null;
  });
  const [file, setFile] = useState(input ?? null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  useEffect(
    () =>
      useVaultStore.subscribe((next, previous) => {
        if (next.vaultPath !== previous.vaultPath) {
          setFile(null);
          setBusy(null);
          setProblem('');
        }
      }),
    [],
  );
  const chooser = useRef<HTMLInputElement>(null);
  const capture = useVaultActionGuard('calendar-import');
  const calendar = useMemo(() => (file ? parseIcs(file.content) : null), [file]);
  const plan = useMemo(
    () => (calendar && mapping ? planIcsImport(calendar, mapping, entries, schema) : null),
    [calendar, mapping, entries, schema],
  );
  const selected = targets.find((row) => row.name === mapping?.type);
  const choose = async (next: File) => {
    if (busy) return;
    const current = capture();
    setBusy('reading');
    setProblem('');
    setFile(null);
    const result = await readIcsFile(next);
    if (!current()) return;
    setBusy(null);
    if (result.ok) setFile({ kind: 'calendar', name: next.name, content: result.content });
    else setProblem(result.reason);
  };
  const submit = async () => {
    if (!calendar || !mapping || !plan?.ops.length || plan.problem || busy) return;
    const current = capture();
    setBusy('importing');
    const result = await importIcs(calendar, mapping, current, shouldNavigate);
    if (!current()) return;
    setBusy(null);
    if (result) onClose();
  };
  const message = targets.length === 0 ? NO_DATED_DATABASE : problem || plan?.problem;
  const skipped = calendar ? Object.entries(calendar.skipped).filter(([, count]) => count > 0) : [];
  return (
    <Dialog
      open
      title="Import calendar file"
      width={720}
      onClose={onClose}
      primaryAction={{
        label:
          busy === 'importing'
            ? 'Importing…'
            : `Import ${plan?.ops.length ?? 0} ${plan?.ops.length === 1 ? 'event' : 'events'}`,
        testId: 'ics-import-submit',
        disabled: !!message || !plan?.ops.length || busy !== null,
        onClick: () => void submit(),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div data-testid="ics-import-dialog" className="space-y-4">
        <p className="text-sm text-n-600">
          Preview a calendar file before importing its events as pages. Re-importing updates only
          pages you have not changed.
        </p>
        <input
          ref={chooser}
          type="file"
          accept=".ics,text/calendar"
          hidden
          data-testid="ics-import-file"
          onChange={(event) => {
            const next = event.target.files?.[0];
            event.target.value = '';
            if (next) void choose(next);
          }}
        />
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => chooser.current?.click()}
          >
            {busy === 'reading' ? 'Reading…' : 'Choose calendar file…'}
          </Button>
          {file && <span className="truncate text-sm text-n-600">{file.name}</span>}
        </div>
        {mapping && selected && (
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs text-n-600">
              <span className="block">Database</span>
              <Select
                ariaLabel="Calendar database"
                width="100%"
                disabled={busy !== null}
                value={mapping.type}
                options={targets.map((row) => ({ value: row.name, label: row.name }))}
                onChange={(event) => {
                  const type = targets.find((row) => row.name === event.target.value);
                  if (type) setMapping(defaultIcsMapping(type));
                }}
              />
            </label>
            <label className="space-y-1 text-xs text-n-600">
              <span className="block">Date property</span>
              <Select
                ariaLabel="Calendar date property"
                width="100%"
                disabled={busy !== null}
                value={mapping.date}
                options={selected.fields
                  .filter((field) => field.kind === 'date' || field.kind === 'daterange')
                  .map((field) => ({ value: field.name, label: humanize(field.name) }))}
                onChange={(event) => setMapping({ ...mapping, date: event.target.value })}
              />
            </label>
            <label className="space-y-1 text-xs text-n-600">
              <span className="block">People</span>
              <Select
                ariaLabel="Calendar people property"
                width="100%"
                disabled={busy !== null}
                value={mapping.person ?? ''}
                options={[
                  { value: '', label: 'Do not link people' },
                  ...selected.fields
                    .filter((field) => field.kind === 'person')
                    .map((field) => ({ value: field.name, label: humanize(field.name) })),
                ]}
                onChange={(event) => setMapping({ ...mapping, person: event.target.value || null })}
              />
            </label>
            <label className="space-y-1 text-xs text-n-600">
              <span className="block">Location</span>
              <Select
                ariaLabel="Calendar location property"
                width="100%"
                disabled={busy !== null}
                value={mapping.location ?? ''}
                options={[
                  { value: '', label: 'Keep in page text' },
                  ...selected.fields
                    .filter((field) => field.kind === 'text')
                    .map((field) => ({ value: field.name, label: humanize(field.name) })),
                ]}
                onChange={(event) =>
                  setMapping({ ...mapping, location: event.target.value || null })
                }
              />
            </label>
          </div>
        )}
        {message && (
          <p role="alert" className="text-sm text-danger-600">
            {message}
          </p>
        )}
        {plan && (
          <>
            <p className="text-sm font-medium text-n-800">
              {plan.ops.length} {plan.ops.length === 1 ? 'event' : 'events'} ready to import
              {plan.ops.length > 20 ? ' · first 20 shown' : ''}
            </p>
            {plan.preview.length > 0 && (
              <ol
                aria-label="Calendar preview"
                className="max-h-60 divide-y divide-n-200 overflow-auto rounded-lg border border-n-200 px-3"
              >
                {plan.preview.map((row, index) => (
                  <li key={index} className="py-2 text-sm">
                    <p className="font-medium text-n-800">{row.title}</p>
                    <p className="text-xs text-n-600">
                      {row.start}
                      {row.end
                        ? ` → ${row.end}`
                        : row.start.length === 10
                          ? ' · all-day'
                          : ' · point'}
                      {row.zone ? ` · ${row.zone}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <ul aria-label="Calendar import report" className="space-y-1 text-xs text-n-600">
              {Object.entries(plan.zones).map(([zone, count]) => (
                <li key={`zone:${zone}`}>
                  {count} · {zone}
                </li>
              ))}
              {(Object.entries(plan.counts) as [keyof IcsCounts, number][])
                .filter(([, count]) => count > 0)
                .map(([key, count]) => (
                  <li key={key}>
                    {COUNT_LABELS[key]}: {count}
                  </li>
                ))}
              {skipped.map(([key, count]) => (
                <li key={key}>
                  {count}{' '}
                  {key === 'malformed'
                    ? 'malformed lines or components skipped'
                    : `${key} components skipped`}
                </li>
              ))}
            </ul>
            <p className="text-xs text-n-500">
              Attendee and organizer addresses are removed. People link only when one page has a
              matching declared email property.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
