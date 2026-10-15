/** Local calendar imports plan one human batch; the shared writer owns ids,
 * provenance and safe re-import. No account or calendar service is involved. */
import { MAX_BATCH_BYTES, MAX_BATCH_OPS } from './batch';
import { utf8Length } from './comments';
import { createTarget } from './createRecord';
import { dateEpoch } from './dateGrammar';
import { composeNote } from './frontmatter';
import { icsProperty, icsText, type IcsCalendar, type IcsEvent } from './ics';
import { endFromDuration, readIcsTime, type IcsTime } from './icsTime';
import { canonicalRecordId, validImportUrl } from './importSources';
import type { ImportBatchOp } from './importPlan';
import { validateValue } from './properties';
import { recordSlug } from './recordDraft';
import { parseRepeat, repeatFieldFor, serializeRepeat } from './recurrence';
import { isReservedTypeName } from './typeCatalog';
import type { Entry, Schema, TypeDef } from './types';
import { formatWikilink, linkTargetOf } from './wikilink';

export { readIcsTime, resolveZone, wallToInstant } from './icsTime';
export interface IcsMapping {
  type: string;
  date: string;
  person: string | null;
  location: string | null;
}
export interface IcsCounts {
  cancelled: number;
  missingUid: number;
  duplicate: number;
  unreadableStart: number;
  untitled: number;
  allDay: number;
  point: number;
  repeating: number;
  overrides: number;
  peopleLinked: number;
  peopleUnlinked: number;
  addressesRemoved: number;
  unknownZone: number;
  dstEdge: number;
  secondsDropped: number;
  invalidEnd: number;
}
export interface IcsImportPlan {
  ops: ImportBatchOp[];
  preview: { title: string; start: string; end: string | null; zone: string | null }[];
  counts: IcsCounts;
  zones: Record<string, number>;
  problem: string | null;
}
export const NO_DATED_DATABASE =
  'No database has a date property. Add a Date or Date range property to one, then import.';
const lower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const raw = (event: IcsEvent, name: string) => icsProperty(event.properties, name)?.value ?? '';
const text = (event: IcsEvent, name: string) => icsText(raw(event, name));

export function icsTargets(schema: Schema): TypeDef[] {
  const score = (type: TypeDef) =>
    Number(type.fields.some((f) => f.kind === 'daterange')) +
    Number(repeatFieldFor({ type: type.name }, schema) !== null) +
    Number(type.fields.some((f) => f.kind === 'person'));
  return [...schema.types.values()]
    .filter(
      (type) =>
        !isReservedTypeName(type.name) &&
        type.fields.some((field) => field.kind === 'date' || field.kind === 'daterange'),
    )
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
export function defaultIcsMapping(type: TypeDef): IcsMapping {
  return {
    type: type.name,
    date:
      (
        type.fields.find((field) => field.kind === 'daterange') ??
        type.fields.find((field) => field.kind === 'date')
      )?.name ?? '',
    person: type.fields.find((field) => field.kind === 'person')?.name ?? null,
    location: null,
  };
}
interface Contact {
  address: string;
  aliases: string[];
  replacement: string;
}
function contacts(event: IcsEvent): Contact[] {
  const found = new Map<string, Contact>();
  for (const property of event.properties) {
    if (!['ATTENDEE', 'ORGANIZER'].includes(property.name)) continue;
    const match = /^mailto:(.+)$/i.exec(property.value);
    if (!match) continue;
    let address = match[1].trim();
    try {
      address = decodeURIComponent(address);
    } catch {
      /* Retain the literal for redaction. */
    }
    if (!address.includes('@')) continue;
    const cn = icsText(property.params.CN?.[0] ?? '').trim();
    const aliases = [
      match[1].trim(),
      address,
      encodeURIComponent(address),
      ...(cn.includes('@')
        ? [cn, ...[...cn.matchAll(/[^\s<>()@]+@[^\s<>()@]+/g)].map((match) => match[0])]
        : []),
    ];
    found.set(lower(address), {
      address,
      aliases: [...new Set([...(found.get(lower(address))?.aliases ?? []), ...aliases])],
      replacement: cn && !cn.includes('@') ? cn : '(address removed)',
    });
  }
  return [...found.values()];
}
function carriesAddress(input: string, people: Contact[]): boolean {
  let text = input;
  for (let depth = 0; depth < 5; depth++) {
    if (people.some(({ aliases }) => aliases.some((alias) => lower(text).includes(lower(alias)))))
      return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      return false;
    }
    if (decoded === text) return false;
    text = decoded;
  }
  // A deeply nested encoding is not a trustworthy join link.
  return true;
}
function eventEnd(event: IcsEvent, start: IcsTime): { end: IcsTime | null; invalid: boolean } {
  const endProperty = icsProperty(event.properties, 'DTEND');
  const duration = raw(event, 'DURATION');
  let end = endProperty
    ? readIcsTime(endProperty)
    : duration
      ? endFromDuration(start, duration)
      : null;
  if (!end) return { end: null, invalid: !!endProperty || !!duration };
  const compare =
    start.epoch !== null && end.epoch !== null
      ? end.epoch - start.epoch
      : end.wall.localeCompare(start.wall);
  if (compare < 0 || (start.kind === 'date') !== (end.kind === 'date'))
    return { end: null, invalid: true };
  if (compare === 0) return { end: null, invalid: false };
  if (start.kind === 'date') {
    const instant = dateEpoch(`${end.wall}T00:00:00Z`);
    if (instant === null) return { end: null, invalid: true };
    const inclusive = new Date(instant - 86_400_000).toISOString().slice(0, 10);
    if (inclusive === start.value) return { end: null, invalid: false };
    end = { ...end, value: inclusive, wall: inclusive };
  }
  return { end, invalid: false };
}

export function planIcsImport(
  calendar: IcsCalendar,
  mapping: IcsMapping,
  entries: Entry[],
  schema: Schema,
): IcsImportPlan {
  const counts: IcsCounts = {
    cancelled: 0,
    missingUid: 0,
    duplicate: 0,
    unreadableStart: 0,
    untitled: 0,
    allDay: 0,
    point: 0,
    repeating: 0,
    overrides: 0,
    peopleLinked: 0,
    peopleUnlinked: 0,
    addressesRemoved: 0,
    unknownZone: 0,
    dstEdge: 0,
    secondsDropped: 0,
    invalidEnd: 0,
  };
  const result: IcsImportPlan = {
    ops: [],
    preview: [],
    counts,
    zones: Object.create(null) as Record<string, number>,
    problem: calendar.problem,
  };
  if (result.problem) return result;
  const type = icsTargets(schema).find((type) => type.name === mapping.type);
  if (!type) return { ...result, problem: NO_DATED_DATABASE };
  const date = type.fields.find(
    (field) => field.name === mapping.date && ['date', 'daterange'].includes(field.kind),
  );
  const person = type.fields.find(
    (field) => field.name === mapping.person && field.kind === 'person',
  );
  const location = type.fields.find(
    (field) => field.name === mapping.location && field.kind === 'text',
  );
  if (!date || (mapping.person !== null && !person) || (mapping.location !== null && !location))
    return { ...result, problem: 'Choose the date, person and location properties again.' };
  const target = createTarget(type.name, { entries, schema });
  const repeat = repeatFieldFor({ type: type.name }, schema);
  const overrides = new Map<string, string[]>();
  for (const event of calendar.events) {
    const recurrence = raw(event, 'RECURRENCE-ID'),
      uid = raw(event, 'UID');
    if (
      uid &&
      recurrence &&
      readIcsTime(icsProperty(event.properties, 'RECURRENCE-ID')) &&
      (event.method === 'CANCEL' ||
        raw(event, 'STATUS').toUpperCase() === 'CANCELLED' ||
        readIcsTime(icsProperty(event.properties, 'DTSTART')))
    )
      overrides.set(uid, [...(overrides.get(uid) ?? []), recurrence]);
  }
  const seen = new Set<string>();
  for (const event of calendar.events) {
    if (event.method === 'CANCEL' || raw(event, 'STATUS').toUpperCase() === 'CANCELLED') {
      counts.cancelled++;
      continue;
    }
    const uid = raw(event, 'UID'),
      recurrence = raw(event, 'RECURRENCE-ID');
    if (!uid.trim()) {
      counts.missingUid++;
      continue;
    }
    const recordId = `${uid} ${recurrence || '-'}`;
    let id: string;
    try {
      id = canonicalRecordId('ics', recordId);
    } catch {
      counts.missingUid++;
      continue;
    }
    if (seen.has(id)) {
      counts.duplicate++;
      continue;
    }
    const start = readIcsTime(icsProperty(event.properties, 'DTSTART'));
    if (!start) {
      counts.unreadableStart++;
      continue;
    }
    seen.add(id);
    const people = contacts(event);
    const scrub = (input: string) => {
      let output = input;
      for (const { aliases, replacement } of people) {
        const pattern = new RegExp(
          [...aliases]
            .sort((a, b) => b.length - a.length)
            .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|'),
          'gi',
        );
        output = output.replace(pattern, () => {
          counts.addressesRemoved++;
          return replacement;
        });
      }
      return output;
    };
    const title = scrub(text(event, 'SUMMARY')).trim() || 'Untitled event';
    if (!text(event, 'SUMMARY').trim()) counts.untitled++;
    const description = scrub(text(event, 'DESCRIPTION')),
      place = scrub(text(event, 'LOCATION'));
    const { end, invalid } = eventEnd(event, start);
    counts.invalidEnd += Number(invalid);
    counts.allDay += Number(start.kind === 'date');
    counts.point += Number(end === null);
    counts.overrides += Number(!!recurrence);
    const times = [start, end].filter((time): time is IcsTime => time !== null);
    counts.unknownZone += Number(times.some((time) => time.issue === 'unknown_zone'));
    counts.dstEdge += Number(
      times.some(
        (time) =>
          time.issue === 'gap' || time.issue === 'ambiguous' || time.issue === 'offset_precision',
      ),
    );
    counts.secondsDropped += Number(times.some((time) => time.secondsDropped));
    const fields: Record<string, unknown> = { ...target.frontmatter };
    fields[date.name] =
      date.kind === 'daterange'
        ? { start: start.value, ...(end ? { end: end.value } : {}) }
        : start.value;
    const footer: string[] = [];
    if (start.zone)
      footer.push(
        `* Time zone: ${scrub(start.zone)}${start.kind === 'floating' ? ' (times kept as written)' : ''}`,
      );
    if (end && date.kind === 'date') footer.push(`* Ends: ${end.value}`);
    if (place) {
      if (location) fields[location.name] = place;
      else footer.push(`* Location: ${place}`);
    }
    const url = raw(event, 'URL');
    const safeUrl =
      /^https:\/\//i.test(url) && validImportUrl(url) && !carriesAddress(url, people) ? url : null;
    if (safeUrl) footer.push(`* Join: ${safeUrl}`);
    const rrule = raw(event, 'RRULE');
    if (rrule) {
      counts.repeating++;
      const exceptions = [
        ...event.properties
          .filter((row) => row.name === 'EXDATE')
          .flatMap((row) => row.value.split(',')),
        ...(overrides.get(uid) ?? []),
      ];
      const rule = `${rrule}${exceptions.length ? `\nEXDATE:${[...new Set(exceptions)].join(',')}` : ''}`;
      const parsed = parseRepeat(rule);
      if (repeat?.date.name === date.name && parsed)
        fields[repeat.repeat.name] = scrub(
          parsed.kind === 'rule' ? serializeRepeat(parsed.rule) : parsed.raw,
        );
      else footer.push(`* Repeats: ${scrub(rule)} (only the first date is set)`);
    }
    for (const row of event.properties.filter((row) => row.name === 'RDATE'))
      footer.push(`* Also on: ${scrub(row.value)}`);
    const linked: string[] = [];
    let unlinked = 0;
    for (const { address } of people) {
      const matches = person
        ? entries.filter(
            (entry) =>
              (!person.target || entry.type === person.target) &&
              entry.type !== null &&
              schema.types
                .get(entry.type)
                ?.fields.some(
                  (field) =>
                    field.kind === 'email' &&
                    typeof entry.properties[field.name] === 'string' &&
                    lower((entry.properties[field.name] as string).trim()) === lower(address),
                ),
          )
        : [];
      const link = matches.length === 1 ? formatWikilink(linkTargetOf(matches[0])) : null;
      if (link !== null && !carriesAddress(link, people)) linked.push(link);
      else unlinked++;
    }
    if (person && linked.length) fields[person.name] = [...new Set(linked)];
    counts.peopleLinked += new Set(linked).size;
    counts.peopleUnlinked += unlinked;
    if (unlinked) footer.push(`* People not linked: ${unlinked}`);
    for (const field of type.fields)
      if (Object.hasOwn(fields, field.name) && validateValue(field, fields[field.name]) !== null)
        return {
          ...result,
          ops: [],
          problem: `The imported value does not fit ${field.name}. Choose another property.`,
        };
    const ordered: Record<string, unknown> = { type: type.name };
    for (const field of type.fields)
      if (Object.hasOwn(fields, field.name)) ordered[field.name] = fields[field.name];
    const content = composeNote(
      ordered,
      `# ${title}\n\n${description}${description ? '\n\n' : ''}***\n\nImported from a calendar file\n${footer.length ? `\n${footer.join('\n')}\n` : ''}`,
    );
    const zone =
      start.zone ??
      (start.kind === 'utc' ? 'UTC' : start.kind === 'date' ? 'All-day' : 'Local time');
    result.zones[zone] = (result.zones[zone] ?? 0) + 1;
    result.ops.push({
      op: 'import',
      system: 'ics',
      recordId,
      path: `${target.folder}/${recordSlug(`${start.wall.slice(0, 10)} ${title}`, 'event')}.md`,
      content,
      ...(safeUrl ? { url: safeUrl } : {}),
    });
    if (result.preview.length < 20)
      result.preview.push({ title, start: start.value, end: end?.value ?? null, zone: start.zone });
    if (result.ops.length > MAX_BATCH_OPS)
      return {
        ...result,
        ops: [],
        problem: `One import can hold up to ${MAX_BATCH_OPS} events. Split this calendar file and import it in parts.`,
      };
  }
  if (utf8Length(JSON.stringify(result.ops)) > MAX_BATCH_BYTES)
    return {
      ...result,
      ops: [],
      problem:
        'This import is too large for one batch. Split the calendar file and import it in parts.',
    };
  return result;
}
