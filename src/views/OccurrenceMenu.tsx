import { useEffect, useRef, useState } from 'react';
import { detachOccurrence } from '@/app/recurrenceActions';
import { Popover } from '@/components/ui/Popover';
import { describeRepeat, type CalendarItem } from '@/engine/recurrence';
import { formatTime } from '@/engine/dates';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

export function OccurrenceMenu({
  item,
  anchor,
  onClose,
}: {
  item: CalendarItem;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLElement | null>(anchor);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const vault = useVaultStore((state) => state.vaultPath);
  const opened = useRef(vault);
  useEffect(() => {
    if (opened.current !== vault) onClose();
  }, [vault, onClose]);
  if (item.value === null || item.rule === null) return null;
  const value = item.value;
  const [year, month, day] = value.start.split('-').map(Number);
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
  const time =
    value.startTime === null
      ? ''
      : ` · ${formatTime(value.startTime, '12')}${value.endTime === null ? '' : ` – ${formatTime(value.endTime, '12')}`}`;
  const detach = async () => {
    if (pending.current || opened.current !== useVaultStore.getState().vaultPath) return;
    pending.current = true;
    setBusy(true);
    const path = await detachOccurrence(item.series.path, value);
    pending.current = false;
    setBusy(false);
    if (path !== null) onClose();
  };
  return (
    <Popover
      role="dialog"
      ariaLabel="Repeating event"
      anchorRef={anchorRef}
      onClose={onClose}
      trapFocus
    >
      <div
        data-testid="occurrence-menu"
        className="flex w-[320px] flex-col gap-3 rounded-lg border border-n-200 bg-n-0 p-3 shadow-lg"
      >
        <div>
          <div className="text-sm font-semibold text-n-900">{item.series.title}</div>
          <div className="mt-1 text-xs text-n-600">
            {date}
            {time}
          </div>
          <div className="mt-1 text-xs text-n-500">
            {describeRepeat({ kind: 'rule', rule: item.rule }, value)}
          </div>
        </div>
        <button
          type="button"
          data-testid="occurrence-this"
          disabled={busy}
          onClick={() => void detach()}
          className="rounded-md border-0 bg-transparent p-2 text-left hover:bg-n-50 disabled:opacity-50"
        >
          <span className="block text-sm text-n-800">This event</span>
          <span className="block text-xs text-n-500">Make this one its own page</span>
        </button>
        <button
          type="button"
          data-testid="occurrence-all"
          disabled={busy}
          onClick={() => {
            onClose();
            useNavStore.getState().navigate({ kind: 'doc', path: item.series.path });
          }}
          className="rounded-md border-0 bg-transparent p-2 text-left hover:bg-n-50 disabled:opacity-50"
        >
          <span className="block text-sm text-n-800">All events</span>
          <span className="block text-xs text-n-500">Open the repeating record</span>
        </button>
      </div>
    </Popover>
  );
}
