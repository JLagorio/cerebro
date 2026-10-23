import { useId, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import {
  describeRepeat,
  parseRepeat,
  repeatPresets,
  REPEAT_DAYS,
  serializeRepeat,
  type RepeatFrequency,
  type RepeatRule,
} from '@/engine/recurrence';
import type { DateValue } from '@/engine/dates';

const CUSTOM = 'custom';
const NONE = 'none';
const UNKNOWN = 'unknown';
const frequencies = [
  { value: 'DAILY', label: 'days' },
  { value: 'WEEKLY', label: 'weeks' },
  { value: 'MONTHLY', label: 'months' },
  { value: 'YEARLY', label: 'years' },
];
const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A draft until Done: replacing an unknown rule is an explicit preset or
 * Custom choice; merely opening this editor never normalizes stored text. */
export function RepeatEditor({
  value,
  anchor,
  dateField,
  onChange,
  onClose,
}: {
  value: unknown;
  anchor: DateValue | null;
  dateField: string;
  onChange: (value: string | null) => void;
  onClose: () => void;
}) {
  const parsed = parseRepeat(value);
  const original = parsed?.kind === 'rule' ? parsed.rule : null;
  const presets = anchor === null ? [] : repeatPresets(anchor);
  const base =
    original ??
    (parseRepeat(presets[1]?.value ?? 'FREQ=WEEKLY') as { kind: 'rule'; rule: RepeatRule }).rule;
  const [choice, setChoice] = useState(() =>
    parsed === null
      ? NONE
      : parsed.kind === 'unknown'
        ? UNKNOWN
        : (presets.find((p) => p.value === serializeRepeat({ ...parsed.rule, exceptions: [] }))
            ?.value ?? CUSTOM),
  );
  const [freq, setFreq] = useState<RepeatFrequency>(base.freq);
  const [interval, setInterval] = useState(String(base.interval));
  const [weekdays, setWeekdays] = useState(base.byDay.filter((d) => d.length === 2));
  const ordinal = base.byDay.find((d) => d.length > 2);
  const [monthMode, setMonthMode] = useState(ordinal ? 'weekday' : 'day');
  const [monthDay, setMonthDay] = useState(
    String(base.byMonthDay[0] ?? Number(anchor?.start.slice(8) ?? 1)),
  );
  const [nth, setNth] = useState(ordinal?.slice(0, -2) ?? '1');
  const [nthDay, setNthDay] = useState(ordinal?.slice(-2) ?? 'MO');
  const [month, setMonth] = useState(
    String(base.byMonth[0] ?? Number(anchor?.start.slice(5, 7) ?? 1)),
  );
  const [customTouched, setCustomTouched] = useState(false);
  // The custom section's own onChange hears its inputs. A Select is a button
  // and sends no change event, so each one marks the draft touched itself —
  // otherwise Done would save the rule the picked unit or ending replaced.
  const touch = (apply: (value: string) => void) => (value: string) => {
    setCustomTouched(true);
    apply(value);
  };
  const patternId = useId();
  const monthId = useId();
  const endsId = useId();
  const [ends, setEnds] = useState(
    base.count !== null ? 'count' : base.until !== null ? 'until' : 'never',
  );
  const [count, setCount] = useState(String(base.count ?? 10));
  const [until, setUntil] = useState(
    base.until === null
      ? (anchor?.start ?? '')
      : `${base.until.slice(0, 4)}-${base.until.slice(4, 6)}-${base.until.slice(6, 8)}`,
  );
  const custom = [
    `FREQ=${freq}`,
    `INTERVAL=${interval}`,
    ...(freq === 'WEEKLY' && weekdays.length ? [`BYDAY=${weekdays.join(',')}`] : []),
    ...(freq === 'MONTHLY' || freq === 'YEARLY'
      ? [monthMode === 'day' ? `BYMONTHDAY=${monthDay}` : `BYDAY=${nth}${nthDay}`]
      : []),
    ...(freq === 'YEARLY' ? [`BYMONTH=${month}`] : []),
    ...(ends === 'count'
      ? [`COUNT=${count}`]
      : ends === 'until'
        ? [`UNTIL=${until.replaceAll('-', '')}`]
        : []),
    ...(base.weekStart === 'SU' ? ['WKST=SU'] : []),
  ].join(';');
  const next = parseRepeat(
    choice === CUSTOM
      ? customTouched
        ? custom
        : serializeRepeat(base)
      : choice === NONE || choice === UNKNOWN
        ? null
        : choice,
  );
  const rule =
    next?.kind === 'rule'
      ? {
          ...next.rule,
          exceptions: parsed?.kind === 'rule' ? parsed.rule.exceptions : (parsed?.exceptions ?? []),
        }
      : null;
  const save = () => {
    if (choice === NONE) {
      onChange(null);
      onClose();
    } else if (rule !== null && anchor !== null) {
      onChange(serializeRepeat(rule, anchor));
      onClose();
    }
  };
  return (
    <Dialog
      open
      title="Repeat"
      width={480}
      onClose={onClose}
      primaryAction={
        anchor === null
          ? {
              label: 'Clear',
              onClick: () => {
                onChange(null);
                onClose();
              },
            }
          : { label: 'Done', onClick: save, disabled: choice !== NONE && rule === null }
      }
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div data-testid="repeat-editor" className="flex flex-col gap-3">
        {parsed?.kind === 'unknown' && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm text-n-600">
              Repeat rule not understood — Cerebro shows this record once, on its date.
            </p>
            <pre
              data-testid="repeat-raw"
              className="m-0 whitespace-pre-wrap break-words rounded-md bg-n-50 p-2 text-xs text-n-700"
            >
              {parsed.raw}
            </pre>
          </div>
        )}
        {anchor === null ? (
          <p className="m-0 text-sm text-n-500">
            Repeats start from {dateField}: give it a date first.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor={patternId} className="text-xs text-n-600">
                Pattern
              </label>
              <Select
                id={patternId}
                value={choice}
                onChange={setChoice}
                width="100%"
                testId="repeat-pattern"
                options={[
                  { value: NONE, label: 'Does not repeat' },
                  ...presets,
                  ...(choice === UNKNOWN
                    ? [{ value: UNKNOWN, label: 'Repeat rule not understood' }]
                    : []),
                  { value: CUSTOM, label: 'Custom…' },
                ]}
              />
            </div>
            {choice === CUSTOM && (
              <div
                className="flex flex-col gap-3"
                data-testid="repeat-custom"
                onChange={() => setCustomTouched(true)}
              >
                <div className="flex items-end gap-2">
                  <label className="flex w-24 flex-col gap-1 text-xs text-n-600">
                    Every
                    <input
                      className="h-8 min-w-0 rounded-md border border-n-300 bg-n-0 px-2 text-sm text-n-800"
                      aria-label="Repeat interval"
                      type="number"
                      min={1}
                      max={999}
                      value={interval}
                      onChange={(e) => setInterval(e.target.value)}
                    />
                  </label>
                  <Select
                    ariaLabel="Repeat unit"
                    value={freq}
                    options={frequencies}
                    onChange={touch((value) => setFreq(value as RepeatFrequency))}
                    width={140}
                  />
                </div>
                {freq === 'WEEKLY' && (
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Weekdays">
                    {REPEAT_DAYS.map((day, i) => (
                      <button
                        type="button"
                        key={day}
                        className={`cb-btn cb-btn-sm ${weekdays.includes(day) ? 'cb-btn-primary' : 'cb-btn-secondary'}`}
                        aria-pressed={weekdays.includes(day)}
                        onClick={() => {
                          setCustomTouched(true);
                          setWeekdays((current) =>
                            REPEAT_DAYS.filter((d) =>
                              d === day ? !current.includes(day) : current.includes(d),
                            ),
                          );
                        }}
                      >
                        {dayNames[i]}
                      </button>
                    ))}
                  </div>
                )}
                {(freq === 'MONTHLY' || freq === 'YEARLY') && (
                  <>
                    {freq === 'YEARLY' && (
                      <div className="flex flex-col gap-1">
                        <label htmlFor={monthId} className="text-xs text-n-600">
                          Month
                        </label>
                        <Select
                          id={monthId}
                          ariaLabel="Repeat month"
                          value={month}
                          options={Array.from({ length: 12 }, (_, i) => ({
                            value: String(i + 1),
                            label: new Intl.DateTimeFormat('en', {
                              month: 'long',
                              timeZone: 'UTC',
                            }).format(new Date(Date.UTC(2000, i, 1))),
                          }))}
                          onChange={touch(setMonth)}
                        />
                      </div>
                    )}
                    <Select
                      ariaLabel="Monthly pattern"
                      value={monthMode}
                      options={[
                        { value: 'day', label: 'Day of month' },
                        { value: 'weekday', label: 'Nth weekday' },
                      ]}
                      onChange={touch(setMonthMode)}
                    />
                    {monthMode === 'day' ? (
                      <label className="flex flex-col gap-1 text-xs text-n-600">
                        Day (−1 is the last day)
                        <input
                          className="h-8 min-w-0 rounded-md border border-n-300 bg-n-0 px-2 text-sm text-n-800"
                          aria-label="Day of month"
                          type="number"
                          min={-31}
                          max={31}
                          value={monthDay}
                          onChange={(e) => setMonthDay(e.target.value)}
                        />
                      </label>
                    ) : (
                      <div className="flex gap-2">
                        <Select
                          ariaLabel="Week number"
                          value={nth}
                          options={[1, 2, 3, 4, 5, -1, -2, -3, -4, -5].map((n) => ({
                            value: String(n),
                            label: n === -1 ? 'Last' : n < 0 ? `${-n} from last` : String(n),
                          }))}
                          onChange={touch(setNth)}
                        />
                        <Select
                          ariaLabel="Day of week"
                          value={nthDay}
                          options={REPEAT_DAYS.map((day, i) => ({
                            value: day,
                            label: dayNames[i],
                          }))}
                          onChange={touch(setNthDay)}
                        />
                      </div>
                    )}
                  </>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor={endsId} className="text-xs text-n-600">
                    Ends
                  </label>
                  <Select
                    id={endsId}
                    value={ends}
                    options={[
                      { value: 'never', label: 'Never' },
                      { value: 'until', label: 'On a date' },
                      { value: 'count', label: 'After a number of occurrences' },
                    ]}
                    onChange={touch(setEnds)}
                  />
                </div>
                {ends === 'until' && (
                  <input
                    className="h-8 min-w-0 rounded-md border border-n-300 bg-n-0 px-2 text-sm text-n-800"
                    aria-label="Last repeat date"
                    type="date"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                )}
                {ends === 'count' && (
                  <input
                    className="h-8 min-w-0 rounded-md border border-n-300 bg-n-0 px-2 text-sm text-n-800"
                    aria-label="Occurrence count"
                    type="number"
                    min={1}
                    max={1000}
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                  />
                )}
              </div>
            )}
            {rule !== null && (
              <p data-testid="repeat-preview" className="m-0 text-sm text-n-600">
                {describeRepeat({ kind: 'rule', rule }, anchor)}
              </p>
            )}
            {choice === CUSTOM && next?.kind === 'unknown' && (
              <p role="alert" className="m-0 text-sm text-danger">
                {next.reason}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
