/** Regenerate from a locally supplied Unicode CLDR windowsZones.xml.
 * No download happens here. Upstream XML stays outside the repository. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const input = process.argv[2];
if (!input) throw new Error('Usage: pnpm tsx scripts/windows-zones.ts <local windowsZones.xml>');
const xml = readFileSync(input, 'utf8');
if (xml.length > 1024 * 1024) throw new Error('The CLDR mapping exceeds 1 MiB.');
const rows: [string, string][] = [];
for (const element of xml.matchAll(/<mapZone\s+([^>]+)\/>/g)) {
  const attributes = Object.fromEntries(
    [...element[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  if (attributes.territory !== '001') continue;
  const { other, type } = attributes;
  if (!other || !type || /[&<>]/.test(other + type) || /\s/.test(type))
    throw new Error('Unexpected CLDR mapping shape.');
  new Intl.DateTimeFormat('en', { timeZone: type }).format(0);
  rows.push([other, type]);
}
rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
if (rows.length < 100 || new Set(rows.map(([name]) => name)).size !== rows.length)
  throw new Error('Missing or repeated CLDR world-zone rows.');
const output = `/** Generated from Unicode CLDR release-48, territory 001.
 * https://github.com/unicode-org/cldr/blob/release-48/common/supplemental/windowsZones.xml
 * Unicode License v3; see THIRD_PARTY_NOTICES.md.
 * Regenerate: pnpm tsx scripts/windows-zones.ts <local windowsZones.xml>
 */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = ${JSON.stringify(Object.fromEntries(rows), null, 2)};\n`;
const target = fileURLToPath(new URL('../src/engine/windowsZones.ts', import.meta.url));
writeFileSync(target, await format(output, { ...(await resolveConfig(target)), filepath: target }));
