import rules from '../../shared/knowledge/source-location.v1.json';

export interface SourceLocator {
  version: 1;
  vaultId: string;
  path: string;
  sourceHash: string;
  kind: 'body' | 'property';
  bodyUtf8Range?: { start: number; end: number };
  propertyKey?: string;
  quote: string;
  prefix: string;
  suffix: string;
}
export type ResolveSourceResult =
  | { status: 'exact'; locator: SourceLocator }
  | { status: 'relocated'; locator: SourceLocator; previousHash: string }
  | { status: 'changed'; path: string; reason: string }
  | { status: 'unavailable' | 'unsupported'; reason: string };
export interface SourceContent {
  sourceHash: string;
  body: string;
  fields: { key: string; text: string }[];
  carrier: string;
}
/** Byte offsets stay raw UTF-8; the editor is responsible for its own position map. */
export function sourceUtf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function utf16AtByte(text: string, byte: number): number | null {
  if (!Number.isSafeInteger(byte) || byte < 0) return null;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    if (bytes === byte) return index;
    bytes += sourceUtf8Length(char);
    index += char.length;
    if (bytes > byte) return null;
  }
  return bytes === byte ? index : null;
}

export function boundedSourceBody(body: string): string {
  let bytes = 0;
  let index = 0;
  for (const char of body) {
    bytes += sourceUtf8Length(char);
    if (bytes > rules.maxBodyBytes) break;
    index += char.length;
  }
  return body.slice(0, index);
}

function validLocator(locator: SourceLocator): boolean {
  const range = locator.bodyUtf8Range;
  return (
    /^[a-f0-9]{64}$/.test(locator.sourceHash) &&
    locator.quote.length > 0 &&
    [...locator.quote].length <= rules.quoteScalars &&
    [...locator.prefix].length <= rules.contextScalars &&
    [...locator.suffix].length <= rules.contextScalars &&
    (locator.kind === 'body'
      ? locator.propertyKey === undefined &&
        range !== undefined &&
        Number.isSafeInteger(range.start) &&
        Number.isSafeInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= rules.maxBodyBytes
      : locator.kind === 'property' &&
        range === undefined &&
        typeof locator.propertyKey === 'string' &&
        locator.propertyKey.length > 0)
  );
}

function candidates(text: string, locator: SourceLocator): number[] {
  const found: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(locator.quote, from);
    if (start < 0) break;
    const end = start + locator.quote.length;
    if (
      text.slice(0, start).endsWith(locator.prefix) &&
      text.slice(end).startsWith(locator.suffix)
    ) {
      found.push(start);
      if (found.length > 1) break;
    }
    // Advancing one code unit includes overlapping matches; a valid quote
    // starts at a scalar boundary (never halfway through an emoji).
    from = start + 1;
  }
  return found;
}

export function resolveSourceWith(
  scope: { vaultId: string; admits: (path: string) => boolean },
  locator: SourceLocator,
  read: () => SourceContent | null,
): ResolveSourceResult {
  const unavailable: ResolveSourceResult = {
    status: 'unavailable',
    reason: 'Source is unavailable.',
  };
  if (scope.vaultId !== locator.vaultId || !scope.admits(locator.path)) return unavailable;
  if (
    !locator.path ||
    sourceUtf8Length(locator.path) > rules.maxPathBytes ||
    sourceUtf8Length(locator.vaultId) > rules.maxVaultIdBytes ||
    locator.path.includes('\\') ||
    /\p{Cc}/u.test(locator.path) ||
    /^[a-z]:/i.test(locator.path) ||
    locator.path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return unavailable;
  if (locator.version !== rules.version)
    return { status: 'unsupported', reason: 'Unsupported source location version.' };
  const changed = (): ResolveSourceResult => ({
    status: 'changed',
    path: locator.path,
    reason: 'The recorded passage no longer resolves uniquely.',
  });
  if (!validLocator(locator)) return changed();
  const source = read();
  if (!source) return unavailable;
  if (source.carrier !== 'markdown')
    return { status: 'unsupported', reason: 'This carrier has no Markdown source location.' };
  const body = boundedSourceBody(source.body);
  const same = source.sourceHash === locator.sourceHash;
  let resolved: SourceLocator = { ...locator, sourceHash: source.sourceHash };
  if (locator.kind === 'body') {
    const range = locator.bodyUtf8Range!;
    if (same) {
      const start = utf16AtByte(body, range.start);
      const end = utf16AtByte(body, range.end);
      if (start === null || end === null || body.slice(start, end) !== locator.quote)
        return changed();
    } else {
      const found = candidates(body, locator);
      if (found.length !== 1) return changed();
      const start = sourceUtf8Length(body.slice(0, found[0]));
      resolved = {
        ...resolved,
        bodyUtf8Range: { start, end: start + sourceUtf8Length(locator.quote) },
      };
    }
  } else {
    const fields = source.fields.filter((field) => field.key === locator.propertyKey);
    if (fields.length !== 1) return changed();
    const matches = candidates(fields[0].text, locator).length;
    // An unchanged hash identifies the row, never an individual array member.
    // Relocation still needs one unique quote-plus-context occurrence.
    if (matches === 0 || (!same && matches !== 1)) return changed();
  }
  return same
    ? { status: 'exact', locator: resolved }
    : { status: 'relocated', locator: resolved, previousHash: locator.sourceHash };
}

/** A producer supplies its retained raw window, never normalized display text. */
export function sourceLocatorForWindow(
  vaultId: string,
  path: string,
  sourceHash: string,
  text: string,
  range: { start: number; end: number },
  propertyKey?: string,
): SourceLocator | null {
  const start = utf16AtByte(text, range.start);
  const end = utf16AtByte(text, range.end);
  if (start === null || end === null || start >= end) return null;
  const locator: SourceLocator = {
    version: 1,
    vaultId,
    path,
    sourceHash,
    kind: propertyKey === undefined ? 'body' : 'property',
    ...(propertyKey === undefined ? { bodyUtf8Range: range } : { propertyKey }),
    quote: text.slice(start, end),
    prefix: [...text.slice(0, start)].slice(-rules.contextScalars).join(''),
    suffix: [...text.slice(end)].slice(0, rules.contextScalars).join(''),
  };
  return validLocator(locator) ? locator : null;
}
