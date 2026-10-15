import { checkSet } from './board';
import { CANVAS_LIMITS, type CanvasLimits } from './canvasLimits';
import { addCards, addEdges, resizeItems, updateCards, updateEdges } from './commands';
import { CANVAS_FORMAT as F } from './format';
import { hasLoneSurrogate, utf8Length } from './json';
import { readCanvas, writeCanvas } from './jsonCanvas';
import type { Board, BoardNode, CommandResult, NewCard, NewEdge } from './model';

/** Rust's canvas/edit.rs twin; src-tauri/fixtures/canvas-edit-cases.json owns the words and bytes. */
export interface CanvasEditContext {
  readonly boardPath: string;
  readonly webSchemes: readonly string[];
  readonly mintId: (seed: string) => string;
  readonly targetState: (path: string) => 'exists' | 'missing' | 'outside' | 'unchecked';
  readonly limits?: CanvasLimits['edit'];
}
export interface CanvasEditPlan {
  readonly content: string;
  readonly ops: readonly string[];
  readonly created: readonly { readonly op: number; readonly id: string }[];
  readonly warnings: readonly string[];
}
export type CanvasEditResult =
  | { readonly ok: true; readonly plan: CanvasEditPlan }
  | { readonly ok: false; readonly reason: string };
const NODE = ['x', 'y', 'width', 'height', 'color', 'text', 'file', 'subpath', 'url', 'label'];
const EDGE = ['fromNode', 'toNode', 'fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label'];
const BOX = ['x', 'y', 'width', 'height'];
const CONTENT: Readonly<Record<string, string>> = { text: 'text', file: 'file', link: 'url' };
const CLEAR = ['color', 'subpath', 'label', 'fromSide', 'toSide', 'fromEnd', 'toEnd'];
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const words = (values: readonly string[]) =>
  values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
function refuse(reason: string): never {
  throw new Error(reason);
}
const quote = (s: string) => JSON.stringify(s);
function string(op: Record<string, unknown>, key: string, n: number): string {
  const value = op[key];
  if (typeof value !== 'string' || hasLoneSurrogate(value))
    refuse(`Op ${n}: \`${key}\` must be text.`);
  return value;
}
function checkId(value: string, n: number, max: number): void {
  if (value.length < 1 || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value))
    refuse(`Op ${n}: ${quote(value)} can't be an id. Use 1 to ${max} letters, digits, - or _.`);
}
function freshId(
  op: Record<string, unknown>, n: number, hash: string, ids: ReadonlySet<string>, ctx: CanvasEditContext,
): string {
  let value: string;
  if ('id' in op) value = string(op, 'id', n);
  else {
    let suffix = 0;
    do {
      value = ctx.mintId(`${hash}:${n}${suffix === 0 ? '' : `:${suffix}`}`).slice(0, 16);
      suffix += 1;
    } while (ids.has(value));
  }
  checkId(value, n, (ctx.limits ?? CANVAS_LIMITS.edit).id_chars);
  if (ids.has(value)) refuse(`Op ${n}: the id ${value} is already on this board.`);
  return value;
}
function pathRefusal(file: string, n: number): never {
  refuse(`Op ${n}: ${quote(file)} isn't a path inside the vault. Name a file such as notes/plan.md, with no ../, leading / or hidden folder.`);
}
// Rust char::is_whitespace; JS trim includes BOM but excludes NEXT LINE.
const whitespace = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const control = /[\u0000-\u001f\u007f-\u009f]/;
function fields(op: Record<string, unknown>, kind: string, n: number, ctx: CanvasEditContext): Record<string, string | number | null> {
  const limits = ctx.limits ?? CANVAS_LIMITS.edit;
  const out: Record<string, string | number | null> = {};
  for (const key of kind === 'edge' ? EDGE : NODE) {
    if (!(key in op)) continue;
    if (BOX.includes(key)) {
      const min = key === 'width' || key === 'height' ? 1 : -F.limits.max_coord;
      const max = F.limits.max_coord;
      const value = op[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
        refuse(`Op ${n}: \`${key}\` must be a whole number from ${min} to ${max}.`);
      out[key] = value === 0 ? 0 : value;
      continue;
    }
    if (kind !== 'edge' && ['text', 'file', 'subpath', 'url', 'label'].includes(key) &&
      CONTENT[kind] !== key && !(key === 'label' && kind === 'group') && !(key === 'subpath' && kind === 'file'))
      refuse(`Op ${n}: a ${kind} node takes no \`${key}\`.`);
    const value = string(op, key, n);
    if (value === '' && CLEAR.includes(key)) { out[key] = null; continue; }
    const cap = ({ text: limits.text_chars, label: limits.label_chars, file: limits.file_chars,
      subpath: limits.subpath_chars, url: limits.url_chars } as Record<string, number>)[key];
    if (cap !== undefined && [...value].length > cap)
      refuse(`Op ${n}: \`${key}\` is longer than ${cap} characters.`);
    if ((key === 'text' || key === 'label') && [...value].some(c => c < ' ' && !(key === 'text' && '\t\n\r'.includes(c))))
      refuse(`Op ${n}: \`${key}\` holds a control character a board can't carry.`);
    if (key === 'color' && !F.vocab.color_presets.includes(value) && !/^#[0-9a-f]{6}$/i.test(value))
      refuse(`Op ${n}: ${quote(value)} isn't a colour. Use a preset 1 to 6, or #rrggbb.`);
    if (key === 'file') {
      if (value === '' || value.startsWith('/') || value.includes('\\') || control.test(value) || value.split('/').some(part => part === '' || part.startsWith('.')))
        pathRefusal(value, n);
      if (value === ctx.boardPath) refuse(`Op ${n}: a card can't show its own board.`);
    }
    if (key === 'subpath' && !value.startsWith('#')) refuse(`Op ${n}: \`subpath\` must start with #.`);
    if (key === 'url') {
      const split = value.indexOf('://');
      if (split < 0 || value.length === split + 3 || !ctx.webSchemes.some(s => s.toLowerCase() === value.slice(0, split).toLowerCase()) || control.test(value) || whitespace.test(value))
        refuse(`Op ${n}: ${quote(value)} isn't a web address. Start it with ${ctx.webSchemes.join(' or ')}://.`);
    }
    if ((key === 'fromSide' || key === 'toSide') && !F.vocab.sides.includes(value))
      refuse(`Op ${n}: ${quote(value)} isn't a side. Use top, right, bottom or left.`);
    if ((key === 'fromEnd' || key === 'toEnd') && !F.vocab.ends.includes(value))
      refuse(`Op ${n}: ${quote(value)} isn't an edge end. Use none or arrow.`);
    if (key === 'fromNode' || key === 'toNode') checkId(value, n, limits.id_chars);
    out[key] = key === 'color' ? value.toLowerCase() : value;
  }
  return out;
}
function fileWarning(file: string, id: string, n: number, ctx: CanvasEditContext, warnings: string[]): void {
  switch (ctx.targetState(file)) {
    case 'outside': pathRefusal(file, n);
    case 'missing': warnings.push(`The card ${id} points at ${file}, which is not in the vault; it keeps that path.`); break;
    case 'unchecked': warnings.push(`The card ${id} points at ${file}, outside what this run may read, so it was not checked.`); break;
  }
}
function ends(edge: Record<string, unknown>, n: number, board: Board): void {
  for (const key of ['fromNode', 'toNode']) {
    const value = typeof edge[key] === 'string' ? edge[key] : '';
    if (!board.nodes.has(value)) refuse(`Op ${n}: the edge would point at ${quote(value)}, which is not on the board.`);
  }
}
function result(value: CommandResult): Board {
  if (!value.ok) refuse(value.refusal.message);
  return value.board;
}

/** Caller supplies hashing and the scoped file lookup; this never reads disk or a clock. */
export function planCanvasEdit(text: string, beforeHash: string, ops: unknown, ctx: CanvasEditContext): CanvasEditResult {
  try {
    if (!Array.isArray(ops)) refuse('edit_canvas needs `ops`, a list of operations');
    const limits = ctx.limits ?? CANVAS_LIMITS.edit;
    if (ops.length > limits.ops) refuse(`edit_canvas takes at most ${limits.ops} ops in one call; this call has ${ops.length}.`);
    if (ops.length === 0) refuse('edit_canvas needs at least one op.');
    const loaded = readCanvas(text);
    if (!loaded.ok) refuse(`${ctx.boardPath} can't be read as a whiteboard (${loaded.message}), so it was left as it is.`);
    let board = loaded.board;
    const ids = new Set([...board.nodes.keys(), ...board.edges.keys()]);
    const lines: string[] = [], warnings: string[] = [], created: {op:number;id:string}[] = [];
    let changed = false;
    for (let index = 0; index < ops.length; index += 1) {
      const n = index + 1, op: unknown = ops[index];
      if (!object(op)) refuse(`Op ${n} must be an object with \`op\`.`);
      const kind = op.op;
      if (typeof kind !== 'string' || !['add_node', 'update_node', 'add_edge', 'update_edge'].includes(kind))
        refuse(`Op ${n}: \`op\` must be add_node, update_node, add_edge or update_edge.`);
      const node = kind.endsWith('node'), add = kind.startsWith('add');
      const allowed = node ? NODE : EDGE;
      const extra = Object.keys(op).filter(k => !allowed.includes(k) && k !== 'op' && k !== 'id' && !(node && k === 'type')).sort()[0];
      if (extra !== undefined) refuse(`Op ${n}: ${extra} isn't something ${kind} sets.`);
      if (node && !add && 'type' in op) refuse(`Op ${n}: a node's type can't change.`);
      if (add && node) {
        const type = op.type;
        if (typeof type !== 'string' || !F.vocab.node_types.includes(type)) refuse(`Op ${n}: add_node needs \`type\`: text, file, link or group.`);
        for (const key of [...BOX, ...(CONTENT[type] === undefined ? [] : [CONTENT[type]])])
          if (!(key in op)) refuse(`Op ${n}: a ${type} node needs \`${key}\`.`);
        const set = fields(op, type, n, ctx), id = freshId(op, n, beforeHash, ids, ctx);
        const card = Object.fromEntries(Object.entries(set).filter(([,v]) => v !== null));
        if (type === 'file') fileWarning(card.file as string, id, n, ctx, warnings);
        board = result(addCards(board, {cards: [{...card, type, ...(type === 'text' ? {shape:'rectangle'} : {})} as NewCard]}, {createId:()=>id}));
        ids.add(id); created.push({op:n,id}); changed = true;
        lines.push(`Added the ${type} node ${id}.`);
      } else if (add) {
        const set = fields(op, 'edge', n, ctx), id = freshId(op, n, beforeHash, ids, ctx);
        ends(set, n, board);
        const edge = Object.fromEntries(Object.entries(set).filter(([,v]) => v !== null));
        board = result(addEdges(board, {edges: [edge as unknown as NewEdge]}, {createId:()=>id}));
        ids.add(id); created.push({op:n,id}); changed = true;
        lines.push(`Added the edge ${id} from ${set.fromNode} to ${set.toNode}.`);
      } else {
        if (!('id' in op) || !allowed.some(key => key in op)) refuse(`Op ${n}: ${kind} needs \`id\` and at least one field to change.`);
        const id = string(op, 'id', n); checkId(id, n, limits.id_chars);
        const found = node ? board.nodes.get(id) : board.edges.get(id);
        if (found === undefined) refuse(`Op ${n}: no ${node ? 'node' : 'edge'} with id ${quote(id)} on this board.`);
        const set = fields(op, node ? (found as BoardNode).type : 'edge', n, ctx);
        const old = found as unknown as Record<string, unknown>;
        const changes = Object.keys(set).filter(key => set[key] === null ? Object.hasOwn(old, key) : old[key] !== set[key]);
        if (node) {
          if ('type' in found && found.type === 'file' && changes.includes('file')) fileWarning(set.file as string, id, n, ctx, warnings);
          const box = {...found, ...Object.fromEntries(Object.entries(set).filter(([key])=>BOX.includes(key)))} as BoardNode;
          board = result(resizeItems(board, {boxes:[{key:`n:${id}`,box}]}, {createId:()=>id}));
          const content = Object.fromEntries(Object.entries(set).filter(([key])=>!BOX.includes(key)));
          board = result(updateCards(board, {updates:[{id,set:content}]}, {createId:()=>id}));
        } else {
          if ('fromNode' in op || 'toNode' in op) ends({...found,...set}, n, board);
          board = result(updateEdges(board, {updates:[{id,set}]}, {createId:()=>id}));
        }
        if (changes.length === 0) lines.push(`${node ? 'Node' : 'Edge'} ${id} already had those values.`);
        else { changed = true; lines.push(`Changed ${words(changes)} on ${node ? 'node' : 'edge'} ${id}.`); }
      }
    }
    for (const [what,count,max] of [['nodes',board.nodes.size,F.limits.max_nodes],['edges',board.edges.size,F.limits.max_edges]] as const)
      if (count > max) refuse(`The board would hold ${count} ${what}; a board holds at most ${max}.`);
    const problem = checkSet(loaded.board, board);
    if (problem !== null) refuse(problem.message);
    const content = changed ? writeCanvas(board) : text;
    const bytes = utf8Length(content);
    if (bytes > F.limits.max_bytes) refuse(`The board would hold ${bytes} bytes; a board holds at most ${F.limits.max_bytes}.`);
    const readback = readCanvas(content);
    if (!readback.ok || writeCanvas(readback.board) !== writeCanvas(board)) refuse('The changed board would not read back as planned, so it was left as it is.');
    return {ok:true,plan:{content,ops:lines,created,warnings}};
  } catch (error) {
    return {ok:false,reason:error instanceof Error ? error.message : String(error)};
  }
}
