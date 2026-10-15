import { kindFor } from './fileKinds';

export interface ImportInput {
  kind: 'calendar';
  name: string;
  content: string;
}
/** A local calendar is previewed before it can write. Extension and content
 * must agree; a renamed arbitrary text file never becomes an import. */
export function inletFor(name: string, head: string): ImportInput['kind'] | null {
  const row = kindFor(name);
  if (row.ingest !== 'import') return null;
  if (
    row.mime === 'text/calendar' &&
    /(?:^|[\r\n])BEGIN:VCALENDAR(?:[\r\n]|$)/i.test(head.slice(0, 65_536).replace(/^\uFEFF/, ''))
  )
    return 'calendar';
  return null;
}
