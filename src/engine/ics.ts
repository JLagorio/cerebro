/** Calendar files are parsed as data, never fetched or interpreted as code. */
import { utf8Length } from './comments';
import { IMPORT_MAX_BYTES } from './fileKinds';

export interface IcsProperty {
  name: string;
  params: Record<string, string[]>;
  value: string;
}
export interface IcsEvent {
  properties: IcsProperty[];
  method: string | null;
}
export interface IcsCalendar {
  events: IcsEvent[];
  skipped: { todo: number; journal: number; freebusy: number; other: number; malformed: number };
  problem: string | null;
}

/** Separators inside quoted parameter values belong to that value. */
function pieces(text: string, separator: string): string[] | null {
  const result: string[] = [];
  let start = 0,
    quoted = false;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '"') quoted = !quoted;
    if (text[at] === separator && !quoted) {
      result.push(text.slice(start, at));
      start = at + 1;
    }
  }
  if (quoted) return null;
  result.push(text.slice(start));
  return result;
}

export function icsText(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_, character: string) =>
    /[nN]/.test(character) ? '\n' : character,
  );
}

function property(line: string): IcsProperty | null {
  let quoted = false,
    colon = -1;
  for (let at = 0; at < line.length; at++) {
    if (line[at] === '"') quoted = !quoted;
    if (line[at] === ':' && !quoted) {
      colon = at;
      break;
    }
  }
  if (colon < 1 || line.includes('\0')) return null;
  const head = pieces(line.slice(0, colon), ';');
  if (!head || !/^[A-Za-z0-9-]+$/.test(head[0])) return null;
  const params: Record<string, string[]> = {};
  for (const item of head.slice(1)) {
    const equals = item.indexOf('=');
    const key = item.slice(0, equals).toUpperCase();
    if (equals < 1 || !/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params, key)) return null;
    const values = pieces(item.slice(equals + 1), ',');
    if (
      !values ||
      values.some(
        (value) =>
          value === '' || (value.startsWith('"') ? !/^"[^"]*"$/.test(value) : value.includes('"')),
      )
    )
      return null;
    params[key] = values.map((value) => {
      const unquoted = value.startsWith('"') ? value.slice(1, -1) : value;
      return unquoted.replace(/\^([nN'^])/g, (_, character: string) =>
        /[nN]/.test(character) ? '\n' : character === "'" ? '"' : '^',
      );
    });
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

export function icsProperty(
  properties: readonly IcsProperty[],
  name: string,
): IcsProperty | undefined {
  return properties.find((row) => row.name === name.toUpperCase());
}

/** Unfold first, then parse a component stack. A malformed component is
 * counted; it never borrows an END from a sibling or promotes an alarm. */
export function parseIcs(source: string): IcsCalendar {
  const result: IcsCalendar = {
    events: [],
    skipped: { todo: 0, journal: 0, freebusy: 0, other: 0, malformed: 0 },
    problem: null,
  };
  // The calendar and CSV inlets share the 16 MiB import budget.
  if (utf8Length(source) > IMPORT_MAX_BYTES)
    return { ...result, problem: 'Choose a calendar file smaller than 16 MB.' };
  if (source.includes('\0'))
    return { ...result, problem: 'The calendar contains a NUL byte and cannot be imported.' };
  const lines: string[] = [];
  for (const line of source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(line)) {
      if (lines.length === 0) result.skipped.malformed++;
      else lines[lines.length - 1] += line.slice(1);
    } else lines.push(line);
  }
  const stack: { name: string; properties: IcsProperty[]; events: IcsProperty[][] }[] = [];
  for (const line of lines) {
    if (!line) continue;
    const row = property(line);
    if (!row) {
      result.skipped.malformed++;
      continue;
    }
    if (row.name === 'BEGIN') {
      const name = row.value.toUpperCase();
      if (!/^[A-Z0-9-]+$/.test(name) || Object.keys(row.params).length) {
        result.skipped.malformed++;
        continue;
      }
      stack.push({ name, properties: [], events: [] });
      continue;
    }
    const current = stack.at(-1);
    if (row.name === 'END') {
      if (!current || row.value.toUpperCase() !== current.name || Object.keys(row.params).length) {
        result.skipped.malformed++;
        continue;
      }
      stack.pop();
      const parent = stack.at(-1);
      if (current.name === 'VCALENDAR' && !parent) {
        const method = icsProperty(current.properties, 'METHOD')?.value.toUpperCase() ?? null;
        for (const properties of current.events) result.events.push({ properties, method });
      } else if (parent?.name === 'VCALENDAR') {
        if (current.name === 'VEVENT') parent.events.push(current.properties);
        else if (current.name === 'VTODO') result.skipped.todo++;
        else if (current.name === 'VJOURNAL') result.skipped.journal++;
        else if (current.name === 'VFREEBUSY') result.skipped.freebusy++;
        else if (current.name !== 'VTIMEZONE') result.skipped.other++;
      } else if (current.name === 'VEVENT' || current.name === 'VCALENDAR')
        result.skipped.malformed++;
      continue;
    }
    if (!current) result.skipped.malformed++;
    else if (current.name === 'VCALENDAR' || current.name === 'VEVENT')
      current.properties.push(row);
  }
  result.skipped.malformed += stack.length;
  return result;
}
