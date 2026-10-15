/** Strict JSON tokens, retaining number spelling, member order and raw unknown
 * values. JSON.parse never sees a board; only known strings are interpreted by
 * the canvas reader. Escaped lone surrogates may ride unknown values unchanged. */
export type JsonValue =
  | {
      readonly kind: 'object';
      readonly members: ReadonlyMap<string, JsonValue>;
      readonly raw: string;
    }
  | { readonly kind: 'array'; readonly items: readonly JsonValue[]; readonly raw: string }
  | { readonly kind: 'string'; readonly value: string; readonly raw: string }
  | { readonly kind: 'number'; readonly value: number; readonly raw: string }
  | { readonly kind: 'boolean'; readonly value: boolean; readonly raw: string }
  | { readonly kind: 'null'; readonly raw: string };

export type JsonObject = Extract<JsonValue, { kind: 'object' }>;

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** UTF-8 length without a DOM encoder; callers reject lone raw surrogates. */
export function utf8Length(text: string): number {
  let length = 0;
  for (const c of text) {
    const code = c.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

export function parseJson(text: string, maxDepth: number): JsonValue {
  if (hasLoneSurrogate(text)) throw new Error('JSON contains an unpaired character.');
  let at = 0;
  const whitespace = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at += 1;
  };
  const bad = (): never => {
    throw new Error(`Invalid JSON at character ${at + 1}.`);
  };
  const string = (): { kind: 'string'; value: string; raw: string } => {
    const start = at++;
    let value = '';
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') return { kind: 'string', value, raw: text.slice(start, at) };
      if (c.charCodeAt(0) < 0x20) bad();
      if (c !== '\\') {
        value += c;
        continue;
      }
      const escaped = text[at++];
      if (escaped === 'u') {
        const digits = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) bad();
        value += String.fromCharCode(parseInt(digits, 16));
        at += 4;
      } else {
        const escapes: Readonly<Record<string, string>> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (!Object.hasOwn(escapes, escaped)) bad();
        value += escapes[escaped];
      }
    }
    return bad();
  };
  const value = (depth: number): JsonValue => {
    whitespace();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) throw new Error(`JSON exceeds ${maxDepth} levels.`);
      at += 1;
      whitespace();
      const parts: string[] = [];
      const members = new Map<string, JsonValue>();
      const items: JsonValue[] = [];
      const end = c === '{' ? '}' : ']';
      if (text[at] !== end) {
        while (true) {
          whitespace();
          if (c === '{') {
            if (text[at] !== '"') bad();
            const key = string();
            whitespace();
            if (text[at++] !== ':') bad();
            const item = value(depth + 1);
            members.set(key.value, item);
            parts.push(`${key.raw}:${item.raw}`);
          } else {
            const item = value(depth + 1);
            items.push(item);
            parts.push(item.raw);
          }
          whitespace();
          if (text[at] === end) break;
          if (text[at++] !== ',') bad();
        }
      }
      at += 1;
      const raw = c + parts.join(',') + end;
      return c === '{' ? { kind: 'object', members, raw } : { kind: 'array', items, raw };
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return literal === 'null'
          ? { kind: 'null', raw: literal }
          : { kind: 'boolean', value: literal === 'true', raw: literal };
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (match === null) return bad();
    at += match[0].length;
    return { kind: 'number', value: Number(match[0]), raw: match[0] };
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) bad();
  return result;
}

/** Opaque facts serialize through the clipboard without rounding a number or
 * decoding an unknown string. A writer validates them before accepting them. */
export interface RawValue {
  readonly canvasRaw: string;
}
export const rawValue = (value: JsonValue): RawValue => ({ canvasRaw: value.raw });
