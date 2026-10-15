import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  MAX_SCHEDULE_ITEMS,
  formatSchedule,
  nextFire,
  parseSchedule,
  type Schedule,
} from '@/engine/skills';
import { parseSchedulePhrase } from '@/engine/schedulePhrase';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Repeat = 'never' | Schedule['kind'];
const REPEATS: { value: Repeat; label: string }[] = [
  { value: 'never', label: 'Not on a clock' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'days', label: 'Certain days' },
  { value: 'monthly', label: 'Every month' },
  { value: 'once', label: 'Once' },
];
const pad = (n: number) => String(n).padStart(2, '0');
export function scheduleZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
}

/** Controls change only their own authored item. A phrase parses before it
 * replaces the list, so no unrecognized prose reaches a live schedule. */
export function ScheduleField({
  value,
  onChange,
  now = new Date(),
}: {
  value: string[];
  onChange: (next: string[]) => void;
  now?: Date;
}) {
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const replace = (index: number, item: string | null) => {
    if (item === null) onChange(value.filter((_, i) => i !== index));
    else if (value.length === 0) onChange([item]);
    else onChange(value.map((old, i) => (i === index ? item : old)));
  };
  return (
    <div className="flex flex-col gap-2">
      <Input
        size="sm"
        value={phrase}
        ariaLabel="Type a schedule"
        placeholder="Or type it — weekdays at 9am"
        onChange={(e) => {
          setPhrase(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const parsed = parseSchedulePhrase(phrase, now);
          if (!parsed.ok) {
            setError(parsed.reason);
            return;
          }
          onChange([parsed.schedule]);
          setPhrase('');
          setError(null);
        }}
      />
      {error !== null && (
        <p className="m-0 text-2xs text-danger-600" role="alert">
          {error}
        </p>
      )}
      {(value.length === 0 ? [''] : value).map((item, index) => (
        <TimeRow key={index} value={item} now={now} onChange={(next) => replace(index, next)} />
      ))}
      {value.length > 0 && value.length < MAX_SCHEDULE_ITEMS && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => onChange([...value, 'daily 09:00'])}>
            Add a time
          </Button>
        </div>
      )}
      <p data-testid="schedule-clock" className="m-0 text-2xs text-n-500">
        Times use this computer&apos;s clock ({scheduleZone()}). If Cerebro was closed when a run
        came due, it runs once when Cerebro opens, not once per missed time. Resuming or changing
        the schedule waits for its next time.
      </p>
    </div>
  );
}
function TimeRow({
  value,
  onChange,
  now,
}: {
  value: string;
  onChange: (item: string | null) => void;
  now: Date;
}) {
  const parsed = parseSchedule(value);
  const repeat: Repeat = parsed?.kind ?? 'never';
  const timed = parsed !== null && parsed.kind !== 'hourly' ? parsed : { hour: 9, minute: 0 };
  const time = `${pad(timed.hour)}:${pad(timed.minute)}`;
  const day = parsed?.kind === 'weekly' ? parsed.day : 1;
  const days = parsed?.kind === 'days' ? parsed.days : [1, 4];
  const monthDay = parsed?.kind === 'monthly' ? parsed.day : 1;
  const date =
    parsed?.kind === 'once'
      ? parsed.date
      : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const emit = (next: {
    repeat?: Repeat;
    time?: string;
    day?: number;
    days?: number[];
    monthDay?: number | 'last';
    date?: string;
  }) => {
    const kind = next.repeat ?? repeat;
    if (kind === 'never') return onChange(null);
    if (kind === 'hourly') return onChange('hourly');
    const [hour, minute] = (next.time ?? time).split(':').map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
    const at = { hour, minute };
    const schedule: Schedule =
      kind === 'weekly'
        ? { kind, day: next.day ?? day, ...at }
        : kind === 'days'
          ? { kind, days: next.days ?? days, ...at }
          : kind === 'monthly'
            ? { kind, day: next.monthDay ?? monthDay, ...at }
            : kind === 'once'
              ? { kind, date: next.date ?? date, ...at }
              : { kind, ...at };
    const formatted = formatSchedule(schedule);
    if (parseSchedule(formatted) !== null) onChange(formatted);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="schedule-item">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          width={168}
          value={repeat}
          ariaLabel="Repeat"
          options={REPEATS}
          onChange={(e) => emit({ repeat: e.target.value as Repeat })}
        />
        {repeat === 'weekly' && (
          <Select
            size="sm"
            width={130}
            value={String(day)}
            ariaLabel="Day"
            options={DAYS.map((label, i) => ({ value: String(i), label }))}
            onChange={(e) => emit({ day: Number(e.target.value) })}
          />
        )}
        {repeat === 'monthly' && (
          <Select
            size="sm"
            width={130}
            value={String(monthDay)}
            ariaLabel="Day of month"
            options={[
              ...Array.from({ length: 28 }, (_, i) => ({
                value: String(i + 1),
                label: `${i + 1}${i === 0 || i === 20 ? 'st' : i === 1 || i === 21 ? 'nd' : i === 2 || i === 22 ? 'rd' : 'th'}`,
              })),
              { value: 'last', label: 'Last day' },
            ]}
            onChange={(e) =>
              emit({ monthDay: e.target.value === 'last' ? 'last' : Number(e.target.value) })
            }
          />
        )}
        {repeat === 'once' && (
          <input
            type="date"
            value={date}
            aria-label="Date"
            onChange={(e) => emit({ date: e.target.value })}
            className="rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-800 outline-none focus-visible:border-cortex-400"
          />
        )}
        {repeat !== 'never' && repeat !== 'hourly' && (
          <>
            <span className="text-xs text-n-500">at</span>
            <input
              type="time"
              value={time}
              aria-label="Time"
              data-testid="schedule-time"
              onChange={(e) => emit({ time: e.target.value })}
              className="rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-800 outline-none focus-visible:border-cortex-400"
            />
          </>
        )}
        {value !== '' && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Remove this time
          </Button>
        )}
      </div>
      {repeat === 'days' && (
        <div className="flex flex-wrap gap-2">
          {DAYS.map((label, i) => (
            <label key={label} className="flex items-center gap-1 text-xs text-n-600">
              <input
                type="checkbox"
                checked={days.includes(i)}
                onChange={() =>
                  emit({ days: days.includes(i) ? days.filter((d) => d !== i) : [...days, i] })
                }
              />
              {label}
            </label>
          ))}
        </div>
      )}
      {parsed?.kind === 'once' && nextFire(parsed, now) === null && (
        <p className="m-0 text-2xs text-warn-700">
          That time has passed, so this never runs. Pick a later one.
        </p>
      )}
      {value.trim() !== '' && parsed === null && (
        <p className="m-0 text-2xs text-danger-600" role="alert">
          This record says <code className="font-mono">{value}</code>, which this app cannot read —
          so it is not running on a clock. Pick a schedule above to replace it.
        </p>
      )}
    </div>
  );
}
