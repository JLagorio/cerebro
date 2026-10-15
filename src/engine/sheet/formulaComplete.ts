/** Upstream owns parsing. This adapter only turns its context into UI choices.
 * Catalog: IronCalc 0.8.3, commit 9bed9ec023e645101df6b6ac5aebbe0708b259fb,
 * webapp/IronCalc/src/components/FormulaHelper/functions.json (functions.LICENSE). */
export type ExpectedToken =
  'Range' | 'Other' | { FunctionName: string } | { Argument: [string, number] };
export interface CompletionContext {
  expecting: ExpectedToken[];
  /** Character offset in the formula body, excluding the leading '='. */
  replace_from: number;
}
export interface FunctionArgument {
  name: string;
  type: string;
  description: string;
}
export interface CatalogEntry {
  name: string;
  description: string;
  args: FunctionArgument[];
  variadic: boolean;
}
export type FormulaCompletion =
  | { kind: 'functions'; entries: CatalogEntry[] }
  | { kind: 'argument'; entry: CatalogEntry; index: number; argument: FunctionArgument }
  | null;
export function catalogEntries(raw: unknown): CatalogEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).flatMap(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.description !== 'string' || !Array.isArray(row.args)) return [];
    const args: FunctionArgument[] = [];
    let variadic = false;
    for (const arg of row.args) {
      if (!Array.isArray(arg) || arg.length !== 3 || !arg.every((part) => typeof part === 'string'))
        return [];
      if (arg[0] === '...') variadic = true;
      else args.push({ name: arg[0].replace(/\*$/, ''), type: arg[1], description: arg[2] });
    }
    return [{ name: name.toUpperCase(), description: row.description, args, variadic }];
  });
}
/** DOM caret offsets are UTF-16; the engine accepts a character offset in raw text. */
export const toChars = (text: string, utf16: number): number =>
  [...text.slice(0, Math.max(0, utf16))].length;
export const toUtf16 = (text: string, chars: number): number =>
  [...text].slice(0, Math.max(0, chars)).join('').length;
const COMMON = ['SUM', 'AVERAGE', 'IF', 'COUNT', 'MIN', 'MAX', 'ROUND'];
export function completionFor(
  context: CompletionContext | null,
  catalog: readonly CatalogEntry[],
): FormulaCompletion {
  if (!context) return null;
  const name = context.expecting.find(
    (token): token is { FunctionName: string } =>
      typeof token === 'object' && 'FunctionName' in token,
  );
  if (name) {
    const prefix = name.FunctionName.toUpperCase();
    const rank = (name: string) => {
      const at = COMMON.indexOf(name);
      return at < 0 ? COMMON.length : at;
    };
    const entries = catalog
      .filter((entry) => entry.name.startsWith(prefix))
      .sort(
        (a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )
      .slice(0, 40);
    return entries.length ? { kind: 'functions', entries } : null;
  }
  const hint = context.expecting.find(
    (token): token is { Argument: [string, number] } =>
      typeof token === 'object' && 'Argument' in token,
  );
  if (!hint) return null;
  const [functionName, index] = hint.Argument;
  const entry = catalog.find((entry) => entry.name === functionName.toUpperCase());
  const argument =
    entry?.args[entry.variadic ? Math.min(index - 1, entry.args.length - 1) : index - 1];
  return entry && argument ? { kind: 'argument', entry, index, argument } : null;
}
export const expectsReference = (context: CompletionContext | null): boolean =>
  context?.expecting.includes('Range') ?? false;
export function insertFunction(
  text: string,
  cursor: number,
  context: CompletionContext,
  name: string,
): { text: string; cursor: number } {
  const start = toUtf16(text, context.replace_from + (text.startsWith('=') ? 1 : 0));
  const after = text.slice(cursor);
  const insert = name + (after.startsWith('(') ? '' : '(');
  return {
    text: text.slice(0, start) + insert + after,
    cursor: start + insert.length + (after.startsWith('(') ? 1 : 0),
  };
}
