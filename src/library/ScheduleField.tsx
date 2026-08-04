import { Select } from '@/components/ui/Select';
import { parseSchedule } from '@/engine/skills';

/**
 * Build a schedule instead of typing its grammar (M18.4).
 *
 * `schedule:` accepts four shapes — `hourly`, `daily HH:MM`, `weekdays HH:MM`,
 * `weekly <day> HH:MM` — and a string that does not parse is not an error. It
 * is simply not a schedule: the agent never runs, and there is nowhere in the
 * app that would ever mention it. That is the worst possible failure for a
 * field whose entire job is "this happens without me watching".
 *
 * The controls only ever emit strings that parse. The free-text escape hatch is
 * gone on purpose — the file is still hand-editable, and a hand-written value
 * this cannot represent is preserved and shown rather than overwritten.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Repeat = 'never' | 'hourly' | 'daily' | 'weekdays' | 'weekly';

function readRepeat(value: string): Repeat {
  const parsed = parseSchedule(value);
  if (parsed === null) return 'never';
  return parsed.kind;
}

function readTime(value: string): string {
  const parsed = parseSchedule(value);
  if (parsed === null || parsed.kind === 'hourly') return '09:00';
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
}

function readDay(value: string): number {
  const parsed = parseSchedule(value);
  return parsed !== null && parsed.kind === 'weekly' ? parsed.day : 1;
}

export function ScheduleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const repeat = readRepeat(value);
  const time = readTime(value);
  const day = readDay(value);
  // A value that is neither blank nor parseable came from a hand-edit or an
  // older build. Shown rather than silently normalised away — the controls
  // below would otherwise rewrite somebody's file the moment they looked at it.
  const unparseable = value.trim() !== '' && parseSchedule(value) === null;

  const emit = (next: { repeat?: Repeat; time?: string; day?: number }) => {
    const r = next.repeat ?? repeat;
    const t = next.time ?? time;
    const d = next.day ?? day;
    if (r === 'never') return onChange('');
    if (r === 'hourly') return onChange('hourly');
    if (r === 'weekly') return onChange(`weekly ${DAYS[d]} ${t}`);
    return onChange(`${r} ${t}`);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          width={168}
          value={repeat}
          ariaLabel="Repeat"
          onChange={(e) => emit({ repeat: e.target.value as Repeat })}
          options={[
            { value: 'never', label: 'Not on a clock' },
            { value: 'hourly', label: 'Every hour' },
            { value: 'daily', label: 'Every day' },
            { value: 'weekdays', label: 'Every weekday' },
            { value: 'weekly', label: 'Every week' },
          ]}
        />
        {repeat === 'weekly' && (
          <Select
            size="sm"
            width={130}
            value={String(day)}
            ariaLabel="Day"
            onChange={(e) => emit({ day: Number(e.target.value) })}
            options={DAY_LABELS.map((label, i) => ({ value: String(i), label }))}
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
      </div>
      {repeat !== 'never' && (
        <p className="m-0 text-2xs text-n-500">
          {/* The catch-up rule, said where it matters: people assume a missed
              week means seven runs, and decline to schedule anything. */}
          Your machine’s clock. An app that was closed all week owes one catch-up run, not seven.
        </p>
      )}
      {unparseable && (
        <p className="m-0 text-2xs text-danger-600" role="alert">
          This record says <code className="font-mono">{value}</code>, which this app cannot read —
          so it is not running on a clock. Pick a schedule above to replace it.
        </p>
      )}
    </div>
  );
}
