/**
 * The whiteboard scene model (M68.1, D14 (b)). A board IS a JSON Canvas 1.0
 * document plus Cerebro's extras: text, file, link and group cards with
 * whole-number, axis-aligned boxes, connections that name two cards, and
 * ink strokes (an extra, like a text card's shape). There is no rotation and
 * no affine transform: the box is the one geometry authority.
 *
 * Types only. Items live in Maps keyed by id, never plain records, so an id
 * such as `__proto__` is just an id. An absent optional field stays
 * undefined; nothing here defaults it. `z` is an order key (order.ts) derived
 * when a board is read and never saved, because array order is the file's
 * z-order.
 */

/** A JSON value the scene carries and never reads. */
export type RawJson = unknown;

/**
 * The codec's opaque record of what a file held beyond the model: unknown
 * keys with their values, and the order keys were written in. Commands
 * carry it by spread and never read it; a new item has none.
 */
export interface FileFacts {
  readonly extra: ReadonlyMap<string, RawJson>;
  readonly keyOrder: readonly string[];
}

export type CardShape = 'rectangle' | 'ellipse' | 'diamond';
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat';

/** Whole numbers in board units; width and height are at least 1. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface CardBase extends Box {
  readonly id: string;
  readonly z: string;
  /** A preset `1`–`6` or a hex colour (colors.ts); a loaded value may be neither. */
  readonly color?: string;
  /** The JSON Canvas node's unknown keys and key order. */
  readonly facts?: FileFacts;
  /** The same record for this card's entry in the board's `cerebro` extras. */
  readonly cardFacts?: FileFacts;
}

export interface TextCard extends CardBase {
  readonly type: 'text';
  readonly text: string;
  /** A Cerebro extra: Obsidian draws every text card as a rectangle. */
  readonly shape: CardShape;
}

export interface FileCard extends CardBase {
  readonly type: 'file';
  /** A vault-relative path. */
  readonly file: string;
  readonly subpath?: string;
}

export interface LinkCard extends CardBase {
  readonly type: 'link';
  readonly url: string;
}

export interface GroupCard extends CardBase {
  readonly type: 'group';
  readonly label?: string;
  readonly background?: string;
  readonly backgroundStyle?: BackgroundStyle;
}

export type BoardNode = TextCard | FileCard | LinkCard | GroupCard;
export type CardType = BoardNode['type'];

export interface BoardEdge {
  readonly id: string;
  readonly z: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly fromSide?: Side;
  readonly toSide?: Side;
  readonly fromEnd?: EdgeEnd;
  readonly toEnd?: EdgeEnd;
  readonly color?: string;
  readonly label?: string;
  readonly facts?: FileFacts;
}

/**
 * A freehand stroke. `points` are flat whole-number triples: x and y in
 * tenths of a unit from the box's top-left corner (so 0 to width × 10 and 0
 * to height × 10), then pressure in thousandths (0 to 1000).
 */
export interface InkStroke extends Box {
  readonly id: string;
  readonly z: string;
  readonly points: readonly number[];
  /** The stroke's diameter in board units, 1 to MAX_INK_SIZE. */
  readonly size: number;
  /** Whether pressure is simulated from speed rather than recorded. */
  readonly simulated: boolean;
  readonly color?: string;
  readonly facts?: FileFacts;
}

export interface Board {
  readonly nodes: ReadonlyMap<string, BoardNode>;
  readonly edges: ReadonlyMap<string, BoardEdge>;
  readonly ink: ReadonlyMap<string, InkStroke>;
  /** The file's top-level unknown keys and key order. */
  readonly facts?: FileFacts;
  /** The same record for the board's `cerebro` extras object. */
  readonly cerebro?: FileFacts;
}

export type Item = BoardNode | BoardEdge | InkStroke;

/** `n:` a card, `e:` a connection, `i:` an ink stroke: ids are unique only within their kind. */
export type ItemKind = 'n' | 'e' | 'i';
export type ItemKey = `n:${string}` | `e:${string}` | `i:${string}`;

/** A command's or a check's refusal, in words a person reads. A UI value, not a policy code. */
export interface Refusal {
  readonly code: 'id' | 'box' | 'color' | 'end' | 'vocab' | 'value' | 'ink' | 'missing';
  readonly message: string;
}

/** `Omit` over each member of a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller supplies for a new item: the scene assigns id and z, and a new item carries no facts. */
export type NewCard = DistributiveOmit<BoardNode, 'id' | 'z' | 'facts' | 'cardFacts'>;
export type NewEdge = Omit<BoardEdge, 'id' | 'z' | 'facts'>;
export type NewStroke = Omit<InkStroke, 'id' | 'z' | 'facts'>;

/** What a command takes beside its payload: the caller's id factory, the only source of new ids. */
export interface CommandContext {
  readonly createId: () => string;
}

export interface CommandReport {
  /** Connections a copy left behind because one of their cards wasn't copied. */
  readonly droppedEdges?: number;
  /** Connections a delete removed because one of their cards went. */
  readonly removedEdges?: number;
}

/**
 * A command's answer. A no-op answers ok with the same board, by reference;
 * bad input answers with a refusal, never a throw.
 */
export type CommandResult =
  | {
      readonly ok: true;
      readonly board: Board;
      readonly label: string;
      readonly selection?: readonly ItemKey[];
      readonly report?: CommandReport;
    }
  | { readonly ok: false; readonly refusal: Refusal };

/** A pure command: the same board, payload and ids always give the same result. */
export type Command<P> = (board: Board, payload: P, ctx: CommandContext) => CommandResult;
