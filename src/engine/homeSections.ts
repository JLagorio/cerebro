import { dateBandFor, dateScale, type BandContext } from './dateBuckets';
import { dateEpoch, parseDateText, readDateValue } from './dateGrammar';

export interface HomeSectionKey {
  key: string;
  label: string;
  order: number;
}
export interface HomeSection<T> extends HomeSectionKey {
  rows: T[];
}

/** No clock is read here. The caller supplies one moment for all lanes. */
export function backSection(
  at: string | null | undefined,
  now: Date,
  ctx: BandContext,
): HomeSectionKey {
  const epoch = at == null ? null : dateEpoch(at);
  const endpoint = at == null ? null : parseDateText(at);
  if (epoch === null || endpoint === null)
    return { key: 'unrecorded', label: 'When not recorded', order: 100 };
  const elapsed = now.getTime() - epoch;
  if (elapsed < 5 * 60_000) return { key: 'minutes', label: 'Last few minutes', order: 0 };
  if (elapsed < 60 * 60_000) return { key: 'hour', label: 'Last hour', order: 1 };
  if (endpoint.date === ctx.today) {
    const hour = Number((endpoint.time ?? '00:00').slice(0, 2));
    const part =
      hour >= 18
        ? ['evening', 'Evening', 2]
        : hour >= 12
          ? ['afternoon', 'Afternoon', 3]
          : hour >= 6
            ? ['morning', 'Morning', 4]
            : ['early', 'Earlier today', 5];
    return { key: String(part[0]), label: String(part[1]), order: Number(part[2]) };
  }
  const band = dateBandFor(endpoint.date, 'created_time', undefined, ctx);
  return {
    key: band.key,
    label: band.label,
    order: 10 + dateScale('created_time', ctx).findIndex((b) => b.key === band.key),
  };
}

export function forwardSection(value: unknown, now: Date, ctx: BandContext): HomeSectionKey {
  if (value == null || value === '') return { key: 'no-date', label: 'No date', order: 100 };
  const parsed = readDateValue(value);
  if (parsed === null) return { key: 'invalid', label: 'Not a date', order: 99 };
  const wall = `${ctx.today} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const start = `${parsed.start.date} ${parsed.start.time ?? '00:00'}`;
  const end = parsed.end === null ? null : `${parsed.end.date} ${parsed.end.time ?? '23:59'}`;
  if (end !== null && start <= wall && end >= wall) return { key: 'now', label: 'Now', order: -1 };
  const band = dateBandFor(parsed.start.date, 'date', undefined, ctx, { deadline: true });
  return {
    key: band.key,
    label: band.label,
    order: dateScale('date', ctx, true).findIndex((b) => b.key === band.key),
  };
}

/** Keep section order and deterministic subject ties without mutating input. */
export function sectionize<T extends { subject: string }>(
  rows: readonly T[],
  section: (row: T) => HomeSectionKey,
  compare?: (a: T, b: T) => number,
): HomeSection<T>[] {
  const groups = new Map<string, HomeSection<T>>();
  for (const row of rows) {
    const key = section(row);
    const group = groups.get(key.key) ?? { ...key, rows: [] };
    group.rows.push(row);
    groups.set(key.key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) => (compare?.(a, b) ?? 0) || a.subject.localeCompare(b.subject)),
    }));
}
