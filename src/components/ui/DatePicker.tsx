import { useLayoutEffect, useRef, useState } from 'react';
import { Calendar } from '@/components/ui/Calendar';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import {
  formatDate,
  formatTime,
  localTimezone,
  REMIND_OPTIONS,
  toIsoDate,
  type DateDisplayFormat,
  type DateValue,
  type RemindOffset,
  type TimeDisplayFormat,
} from '@/engine/dates';

const FORMAT_OPTIONS: { id: DateDisplayFormat; label: string }[] = [
  { id: 'full', label: 'Full date' },
  { id: 'short', label: 'Short date' },
  { id: 'mdy', label: 'Month/Day/Year' },
  { id: 'dmy', label: 'Day/Month/Year' },
  { id: 'ymd', label: 'Year/Month/Day' },
  { id: 'relative', label: 'Relative' },
];

const TIME_FORMAT_OPTIONS: { id: TimeDisplayFormat; label: string }[] = [
  { id: 'hidden', label: 'Hidden' },
  { id: '12', label: '12 hour' },
  { id: '24', label: '24 hour' },
];

/** Side flyout of checkable options; clamps itself inside the viewport. */
function FlyoutMenu<T extends string>({
  options,
  activeId,
  onPick,
}: {
  options: { id: T; label: string }[];
  activeId: T;
  onPick: (id: T) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shiftX, setShiftX] = useState(0);
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const overflow = rect.right - (window.innerWidth - 8);
    // Overflowing right: flip to the left side of the picker instead.
    if (overflow > 0) setShiftX(-(rect.width * 2 + 16));
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ transform: shiftX === 0 ? undefined : `translateX(${shiftX}px)` }}
      className="absolute left-full top-[-6px] z-50 ml-1.5 w-56 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="menuitemradio"
          aria-checked={o.id === activeId}
          onClick={() => onPick(o.id)}
          className="flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
        >
          <span className="min-w-0 flex-1 truncate">{o.label}</span>
          {o.id === activeId && <Icon name="check" size={14} color="var(--n-700)" />}
        </button>
      ))}
    </div>
  );
}

function SettingRow({
  label,
  value,
  onClick,
  children,
}: {
  label: string;
  value?: React.ReactNode;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const inner = (
    <>
      <span className="text-[13px] text-[var(--n-800)]">{label}</span>
      <span className="flex-1" />
      {value}
    </>
  );
  return (
    <div className="relative">
      {onClick !== undefined ? (
        <button
          type="button"
          onClick={onClick}
          className="flex h-8 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left hover:bg-[var(--n-50)]"
        >
          {inner}
        </button>
      ) : (
        <div className="flex h-8 w-full items-center gap-2 px-2">{inner}</div>
      )}
      {children}
    </div>
  );
}

const boxClass = (active: boolean) =>
  [
    'flex h-8 min-w-0 flex-1 items-center rounded-lg border px-2.5 text-[13px]',
    active
      ? 'border-[var(--cortex-500)] bg-[var(--cortex-50)] text-[var(--n-900)] shadow-[0_0_0_2px_var(--cortex-100)]'
      : 'border-[var(--n-200)] bg-[var(--n-25,var(--n-50))] text-[var(--n-800)]',
  ].join(' ');

export interface DatePickerProps {
  value: DateValue;
  /** Today's ISO date — injected for testability. */
  today?: string;
  onChange: (v: DateValue) => void;
  onClear: () => void;
  /** Frontmatter date fields hide rows their storage can't carry. */
  showEndToggle?: boolean;
  showTime?: boolean;
  showRemind?: boolean;
}

/**
 * Notion-style date picker (M2.x): start/end range, display format,
 * optional time with 12/24h clock, machine-local timezone, and reminder
 * presets. Composes the base Calendar; pure controlled component — the
 * caller anchors it in a popover and persists the value.
 */
export function DatePicker({
  value,
  today,
  onChange,
  onClear,
  showEndToggle = true,
  showTime = true,
  showRemind = true,
}: DatePickerProps) {
  const todayIso = today ?? toIsoDate(new Date());
  const [month, setMonth] = useState((value.end ?? value.start).slice(0, 7));
  const [endpoint, setEndpoint] = useState<'start' | 'end'>('start');
  const [flyout, setFlyout] = useState<'format' | 'timeformat' | 'remind' | null>(null);
  const tz = localTimezone();
  const hasTime = value.startTime !== null;

  const pickDay = (date: string) => {
    if (value.end === null) {
      onChange({ ...value, start: date });
      return;
    }
    const next = endpoint === 'start' ? { ...value, start: date } : { ...value, end: date };
    // Keep the range ordered whichever endpoint moved.
    if (next.end !== null && next.end < next.start) {
      [next.start, next.end] = [next.end, next.start];
      [next.startTime, next.endTime] = [next.endTime, next.startTime];
    }
    onChange(next);
    setEndpoint(endpoint === 'start' ? 'end' : 'start');
  };

  const toggleEnd = (on: boolean) => {
    onChange(
      on
        ? { ...value, end: value.start, endTime: value.startTime }
        : { ...value, end: null, endTime: null },
    );
    setEndpoint(on ? 'end' : 'start');
  };

  const toggleTime = (on: boolean) => {
    if (on) {
      const now = new Date();
      const t = `${String(now.getHours()).padStart(2, '0')}:00`;
      onChange({ ...value, startTime: t, endTime: value.end !== null ? t : null });
    } else {
      onChange({ ...value, startTime: null, endTime: null, timeFormat: '12' });
    }
  };

  const setTime = (part: 'startTime' | 'endTime') => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.value !== '') onChange({ ...value, [part]: e.target.value });
  };

  const jumpToday = () => {
    setMonth(todayIso.slice(0, 7));
    pickDay(todayIso);
  };

  const dateBox = (which: 'start' | 'end') => {
    const date = which === 'start' ? value.start : (value.end ?? value.start);
    const time = which === 'start' ? value.startTime : value.endTime;
    const active = value.end === null ? which === 'start' : endpoint === which;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <button
          type="button"
          data-testid={`date-box-${which}`}
          onClick={() => {
            setEndpoint(which);
            setMonth(date.slice(0, 7));
          }}
          className={boxClass(active)}
        >
          <span className="truncate">{formatDate(date, 'short', todayIso)}</span>
        </button>
        {hasTime && time !== null && (
          <input
            type="time"
            aria-label={`${which === 'start' ? 'Start' : 'End'} time`}
            value={time}
            onChange={setTime(which === 'start' ? 'startTime' : 'endTime')}
            className="h-8 w-[92px] flex-none rounded-lg border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 text-[12.5px] text-[var(--n-800)]"
          />
        )}
      </div>
    );
  };

  const closeFlyouts = () => setFlyout(null);

  return (
    <div
      data-testid="date-picker"
      className="flex w-[300px] flex-col gap-0.5 rounded-xl border border-[var(--n-200)] bg-[var(--n-0)] p-2.5 shadow-[0_8px_28px_rgba(22,26,36,0.16)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-1.5 pb-2">
        {dateBox('start')}
        {value.end !== null && dateBox('end')}
      </div>
      <Calendar
        month={month}
        onMonthChange={(m) => {
          setMonth(m);
          closeFlyouts();
        }}
        start={value.start}
        end={value.end}
        onPick={pickDay}
        todayLabel={hasTime ? 'Now' : 'Today'}
        onToday={jumpToday}
      />
      <div className="mt-1.5 border-t border-[var(--n-100)] pt-1.5">
        {showEndToggle && (
          <SettingRow
            label="End date"
            value={
              <Switch checked={value.end !== null} onChange={toggleEnd} ariaLabel="End date" />
            }
          />
        )}
        <SettingRow
          label="Date format"
          onClick={() => setFlyout(flyout === 'format' ? null : 'format')}
          value={
            <span className="flex items-center gap-1 text-[12.5px] text-[var(--n-500)]">
              {FORMAT_OPTIONS.find((o) => o.id === value.format)?.label}
              <Icon name="chevron-right" size={13} color="var(--n-400)" />
            </span>
          }
        >
          {flyout === 'format' && (
            <FlyoutMenu
              options={FORMAT_OPTIONS}
              activeId={value.format}
              onPick={(id) => {
                onChange({ ...value, format: id });
                closeFlyouts();
              }}
            />
          )}
        </SettingRow>
        {showTime && (
          <SettingRow
            label="Include time"
            value={<Switch checked={hasTime} onChange={toggleTime} ariaLabel="Include time" />}
          />
        )}
        {showTime && hasTime && (
          <>
            <SettingRow
              label="Time format"
              onClick={() => setFlyout(flyout === 'timeformat' ? null : 'timeformat')}
              value={
                <span className="flex items-center gap-1 text-[12.5px] text-[var(--n-500)]">
                  {TIME_FORMAT_OPTIONS.find((o) => o.id === value.timeFormat)?.label}
                  <Icon name="chevron-right" size={13} color="var(--n-400)" />
                </span>
              }
            >
              {flyout === 'timeformat' && (
                <FlyoutMenu
                  options={TIME_FORMAT_OPTIONS}
                  activeId={value.timeFormat}
                  onPick={(id) => {
                    onChange({ ...value, timeFormat: id });
                    closeFlyouts();
                  }}
                />
              )}
            </SettingRow>
            <SettingRow
              label="Timezone"
              value={
                <span className="text-[12.5px] text-[var(--n-500)]" title={tz.zone}>
                  {tz.short}
                </span>
              }
            />
          </>
        )}
        {showRemind && (
          <SettingRow
            label="Remind"
            onClick={() => setFlyout(flyout === 'remind' ? null : 'remind')}
            value={
              <span className="flex items-center gap-1 text-[12.5px] text-[var(--n-500)]">
                {REMIND_OPTIONS.find((o) => o.id === (value.remind ?? 'none'))?.label.replace(
                  / \(9:00 AM\)$/,
                  '',
                )}
                <Icon name="chevron-right" size={13} color="var(--n-400)" />
              </span>
            }
          >
            {flyout === 'remind' && (
              <FlyoutMenu
                options={REMIND_OPTIONS}
                activeId={value.remind ?? 'none'}
                onPick={(id) => {
                  onChange({ ...value, remind: id === 'none' ? null : (id as RemindOffset) });
                  closeFlyouts();
                }}
              />
            )}
          </SettingRow>
        )}
      </div>
      <div className="border-t border-[var(--n-100)] pt-1">
        <SettingRow label="Clear" onClick={onClear} />
      </div>
      {showRemind && (
        <div className="flex items-center gap-1.5 border-t border-[var(--n-100)] px-2 pb-0.5 pt-2 text-[12px] text-[var(--n-400)]">
          <Icon name="circle-help" size={13} />
          Reminders fire as desktop notifications
        </div>
      )}
    </div>
  );
}

/** Preview label for the time boxes (exported for tests). */
export function timeBoxLabel(time: string, format: TimeDisplayFormat): string {
  return formatTime(time, format === 'hidden' ? '12' : format);
}
