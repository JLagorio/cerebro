/** Field arithmetic only (M61.4, D13). Spreadsheet A1 formulas use a separate
 * upstream IronCalc engine in src-tauri/src/sheet (M67.1). Missing inputs remain missing; evaluating a field formula never reads a
 * clock, executes source text, or writes a record. */
import { parseDateText } from './dateGrammar';
import { humanize } from './schema';

export type FormulaType = 'number' | 'date';
export type FormulaOperator = '+' | '-' | '*' | '/';
export type FormulaAst =
  | { kind: 'number'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'negate'; operand: FormulaAst }
  | { kind: 'binary'; op: FormulaOperator; left: FormulaAst; right: FormulaAst };
export interface FormulaField {
  name: string;
  kind: string;
  formula?: string;
}
export interface FormulaProblem {
  ok: false;
  error: string;
}
export interface CheckedFormula {
  ok: true;
  ast: FormulaAst;
  canonical: string;
  result: FormulaType;
  refs: string[];
  types: ReadonlyMap<string, FormulaType>;
}
type ParsedFormula = { ok: true; ast: FormulaAst } | FormulaProblem;
const MAX_DEPTH = 32;
const TOO_DEEP = "Formulas can't nest more than 32 deep.";
const EMPTY = "Write a formula over this database's number and date properties.";
const problem = (error: string): FormulaProblem => ({ ok: false, error });
const word = /^[A-Za-z_][A-Za-z0-9_]*$/;
const precedence = (node: FormulaAst): number =>
  node.kind === 'binary'
    ? node.op === '+' || node.op === '-'
      ? 1
      : 2
    : node.kind === 'negate'
      ? 3
      : 4;

interface Token {
  text: string;
  kind: 'number' | 'ref' | 'symbol';
}
function lex(text: string): Token[] | FormulaProblem {
  const tokens: Token[] = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === '{') {
      const end = text.indexOf('}', i + 1);
      if (end < 0) return problem('Close “{” with “}”.');
      const name = text.slice(i + 1, end).trim();
      if (name === '' || name.includes('{'))
        return problem(`“${text.slice(i, end + 1)}” can't be part of a formula.`);
      tokens.push({ text: name, kind: 'ref' });
      i = end + 1;
      continue;
    }
    const tail = text.slice(i);
    const numeric = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(tail);
    if (numeric !== null) {
      tokens.push({ text: numeric[0], kind: 'number' });
      i += numeric[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(tail);
    if (name !== null) {
      tokens.push({ text: name[0], kind: 'ref' });
      i += name[0].length;
      continue;
    }
    if ('+-*/()'.includes(text[i])) {
      tokens.push({ text: text[i++], kind: 'symbol' });
      continue;
    }
    return problem(`“${text[i]}” can't be part of a formula.`);
  }
  return tokens;
}

/** Pratt parser with a bounded syntax depth and no eval or Function door. */
export function parseFormula(text: string): ParsedFormula {
  const tokens = lex(text);
  if (!Array.isArray(tokens)) return tokens;
  if (tokens.length === 0) return problem(EMPTY);
  let at = 0;
  let error: string | null = null;
  const fail = (message: string): null => {
    error ??= message;
    return null;
  };
  const parse = (minimum: number, depth: number): FormulaAst | null => {
    if (depth > MAX_DEPTH) return fail(TOO_DEEP);
    const token = tokens[at++];
    if (token === undefined) return fail(`The formula stops after “${tokens.at(-1)!.text}”.`);
    let left: FormulaAst | null;
    if (token.kind === 'number') {
      const value = Number(token.text);
      if (!Number.isFinite(value)) return fail(`“${token.text}” can't be part of a formula.`);
      left = { kind: 'number', value };
    } else if (token.kind === 'ref') left = { kind: 'ref', name: token.text };
    else if (token.text === '-') {
      const operand = parse(3, depth + 1);
      left = operand === null ? null : { kind: 'negate', operand };
    } else if (token.text === '(') {
      left = parse(0, depth + 1);
      if (left === null) return null;
      if (tokens[at]?.text !== ')') return fail('Close “(” with “)”.');
      at++;
    } else
      return fail(
        token.text === ')'
          ? "There's a “)” with no “(” before it."
          : `“${token.text}” can't be part of a formula.`,
      );
    if (left === null) return null;
    while (at < tokens.length) {
      const next = tokens[at];
      if (!['+', '-', '*', '/'].includes(next.text) || next.kind !== 'symbol') break;
      const level = next.text === '+' || next.text === '-' ? 1 : 2;
      if (level < minimum) break;
      at++;
      const right = parse(level + 1, depth + 1);
      if (right === null) return null;
      left = { kind: 'binary', op: next.text as FormulaOperator, left, right };
    }
    return left;
  };
  const ast = parse(0, 1);
  if (ast === null) return problem(error ?? EMPTY);
  if (at < tokens.length)
    return problem(
      tokens[at].text === ')'
        ? "There's a “)” with no “(” before it."
        : `Put an operator between “${tokens[at - 1].text}” and “${tokens[at].text}”.`,
    );
  // A long, left-associated chain has shallow parser calls but a deep AST.
  const pending = [{ node: ast, depth: 1 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (depth > MAX_DEPTH) return problem(TOO_DEEP);
    if (node.kind === 'binary')
      pending.push({ node: node.left, depth: depth + 1 }, { node: node.right, depth: depth + 1 });
    else if (node.kind === 'negate') pending.push({ node: node.operand, depth: depth + 1 });
  }
  return { ok: true, ast };
}

/** Keep decimal literals inside this dialect when JS would print an exponent. */
function renderNumber(value: number): string {
  if (value < 0) return `-${renderNumber(-value)}`;
  const text = String(value);
  if (!text.includes('e')) return text;
  const [mantissa, exponent] = text.split('e');
  const digits = mantissa.replace('.', '');
  const point =
    (mantissa.indexOf('.') < 0 ? mantissa.length : mantissa.indexOf('.')) + Number(exponent);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function renderFormula(ast: FormulaAst): string {
  const render = (node: FormulaAst, floor = 0): string => {
    let text: string;
    if (node.kind === 'number') text = renderNumber(node.value);
    else if (node.kind === 'ref') text = word.test(node.name) ? node.name : `{${node.name}}`;
    else if (node.kind === 'negate') text = `-${render(node.operand, 3)}`;
    else
      text = `${render(node.left, precedence(node))} ${node.op} ${render(node.right, precedence(node) + 1)}`;
    return precedence(node) < floor ? `(${text})` : text;
  };
  return render(ast);
}

function fieldNamed(fields: readonly FormulaField[], name: string): FormulaField | undefined {
  const key = name.toLowerCase();
  return (
    fields.find((field) => field.name.toLowerCase() === key) ??
    fields.find((field) => humanize(field.name).toLowerCase() === key)
  );
}

/** Canonical keys are resolved before checking dependency types and cycles. */
export function checkFormula(
  text: string,
  fields: readonly FormulaField[],
  { typeName = 'This database', ownName }: { typeName?: string; ownName?: string } = {},
): CheckedFormula | FormulaProblem {
  const parsed = parseFormula(text);
  if (!parsed.ok) return parsed;
  const refs = new Set<string>();
  const types = new Map<string, FormulaType>();
  const checkedAtDepth = new Map<string, FormulaType>();
  let error: string | null = null;
  const fail = (message: string): null => {
    error ??= message;
    return null;
  };
  const check = (node: FormulaAst, path: string[], direct: boolean): FormulaType | null => {
    if (error !== null) return null;
    if (node.kind === 'number') return 'number';
    if (node.kind === 'ref') {
      const def = fieldNamed(fields, node.name);
      if (def === undefined) return fail(`${typeName} has no property called “${node.name}”.`);
      node.name = def.name;
      if (direct) refs.add(def.name);
      if (path.includes(def.name))
        return fail(`${humanize(def.name)} reads this property back, so it can't be used here.`);
      let result: FormulaType | null;
      if (def.kind === 'number' || def.kind === 'date') result = def.kind;
      else if (def.kind === 'formula') {
        if (path.length >= MAX_DEPTH) return fail(TOO_DEEP);
        const cached = checkedAtDepth.get(`${def.name}:${path.length}`);
        if (cached !== undefined) return cached;
        const inner = parseFormula(def.formula ?? '');
        if (!inner.ok) return fail(inner.error);
        result = check(inner.ast, [...path, def.name], false);
        if (result !== null) checkedAtDepth.set(`${def.name}:${path.length}`, result);
      } else
        return fail(
          `${humanize(def.name)} is a ${def.kind} property; formulas read number, date and formula properties.`,
        );
      if (result !== null) types.set(def.name, result);
      return result;
    }
    if (node.kind === 'negate') {
      const result = check(node.operand, path, direct);
      return result === 'date' ? fail("A date can't be negative.") : result;
    }
    const left = check(node.left, path, direct);
    const right = check(node.right, path, direct);
    if (left === null || right === null) return null;
    if (left === 'number' && right === 'number') return 'number';
    if (node.op === '+')
      return left === 'date' && right === 'date'
        ? fail("Two dates can't be added; subtract them to count the days between.")
        : 'date';
    if (node.op === '-')
      return left === 'number'
        ? fail("A date can't be subtracted from a number.")
        : right === 'date'
          ? 'number'
          : 'date';
    return fail('Only numbers can be multiplied or divided.');
  };
  const result = check(parsed.ast, ownName === undefined ? [] : [ownName], true);
  return result === null
    ? problem(error ?? EMPTY)
    : {
        ok: true,
        ast: parsed.ast,
        canonical: renderFormula(parsed.ast),
        result,
        refs: [...refs],
        types,
      };
}

/** Direct references remain discoverable even when the expression's types
 * are invalid, so rename and deletion cannot silently orphan an input. */
export function formulaReads(text: string, fields: readonly FormulaField[]): string[] | null {
  const parsed = parseFormula(text);
  if (!parsed.ok) return null;
  const names = new Set<string>();
  const walk = (node: FormulaAst): boolean => {
    if (node.kind === 'ref') {
      const def = fieldNamed(fields, node.name);
      if (def === undefined) return false;
      names.add(def.name);
      return true;
    }
    if (node.kind === 'negate') return walk(node.operand);
    return node.kind !== 'binary' || (walk(node.left) && walk(node.right));
  };
  return walk(parsed.ast) ? [...names] : null;
}

export function renameFormulaRefs(
  text: string,
  fields: readonly FormulaField[],
  from: string,
  to: string,
): string | null {
  const parsed = parseFormula(text);
  if (!parsed.ok) return null;
  const walk = (node: FormulaAst): boolean => {
    if (node.kind === 'ref') {
      const def = fieldNamed(fields, node.name);
      if (def === undefined) return false;
      node.name = def.name === from ? to : def.name;
      return true;
    }
    if (node.kind === 'negate') return walk(node.operand);
    return node.kind !== 'binary' || (walk(node.left) && walk(node.right));
  };
  return walk(parsed.ast) ? renderFormula(parsed.ast) : null;
}

// Proleptic Gregorian arithmetic in days since 0001-01-01. Date construction
// would turn years 1–99 into 1901–1999 and introduce DST into elapsed days.
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const beforeYear = (year: number) => {
  const y = year - 1;
  return 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
};
const monthDays = (year: number, month: number) =>
  month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
function dateNumber(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const endpoint = parseDateText(raw);
  if (endpoint === null) return undefined;
  const [year, month, day] = endpoint.date.split('-').map(Number);
  if (year < 1 || year > 9999) return undefined;
  let ordinal = beforeYear(year) + day - 1;
  for (let m = 1; m < month; m++) ordinal += monthDays(year, m);
  const [hour, minute] = (endpoint.time ?? '00:00').split(':').map(Number);
  return ordinal + (hour * 60 + minute) / 1440;
}
function dateText(value: number): string | undefined {
  const minutes = Math.round(value * 1440);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= beforeYear(10000) * 1440)
    return undefined;
  const ordinal = Math.floor(minutes / 1440);
  let lo = 1;
  let hi = 10000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (beforeYear(mid) <= ordinal) lo = mid;
    else hi = mid;
  }
  let rest = ordinal - beforeYear(lo);
  let month = 1;
  while (rest >= monthDays(lo, month)) {
    rest -= monthDays(lo, month);
    month++;
  }
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const day = `${pad(lo, 4)}-${pad(month)}-${pad(rest + 1)}`;
  const time = minutes % 1440;
  return time === 0 ? day : `${day} ${pad(Math.floor(time / 60))}:${pad(time % 60)}`;
}

/** `read` is schema.fieldValue bound to one entry; derived formula inputs
 * therefore share its memo and do not read stale stored frontmatter. */
export function evaluateFormula(
  checked: CheckedFormula,
  read: (name: string) => unknown,
): number | string | undefined {
  const evaluate = (node: FormulaAst): { value: number; kind: FormulaType } | undefined => {
    if (node.kind === 'number')
      return Number.isFinite(node.value) ? { value: node.value, kind: 'number' } : undefined;
    if (node.kind === 'ref') {
      const raw = read(node.name);
      const kind = checked.types.get(node.name)!;
      const value =
        kind === 'date'
          ? dateNumber(raw)
          : typeof raw === 'number' && Number.isFinite(raw)
            ? raw
            : undefined;
      return value === undefined ? undefined : { value, kind };
    }
    if (node.kind === 'negate') {
      const operand = evaluate(node.operand);
      return operand === undefined ? undefined : { value: -operand.value, kind: 'number' };
    }
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (left === undefined || right === undefined || (node.op === '/' && right.value === 0))
      return undefined;
    const value =
      node.op === '+'
        ? left.value + right.value
        : node.op === '-'
          ? left.value - right.value
          : node.op === '*'
            ? left.value * right.value
            : left.value / right.value;
    const kind =
      left.kind === 'date' && right.kind === 'date'
        ? 'number'
        : left.kind === 'date' || right.kind === 'date'
          ? 'date'
          : 'number';
    if (!Number.isFinite(value) || (kind === 'date' && dateText(value) === undefined))
      return undefined;
    return { value, kind };
  };
  const result = evaluate(checked.ast);
  return result === undefined
    ? undefined
    : result.kind === 'date'
      ? dateText(result.value)
      : result.value;
}
