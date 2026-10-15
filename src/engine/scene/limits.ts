/**
 * The scene core's caps (M68.1). M68.2 moves the file limits (coordinates,
 * ids, ink) into `shared/canvas/format.v1.json`, which both codecs read, and
 * this file then takes them from there; the editor and clipboard caps stay.
 */

/** Undo steps the editor keeps. */
export const HISTORY_LIMIT = 100;
/** How far a paste or duplicate shifts its items, in board units. */
export const PASTE_OFFSET = 24;
/** The smallest width or height a box may have. */
export const MIN_SIZE = 1;
/** The largest |x| or |y|, and the largest width or height. */
export const MAX_COORD = 1_000_000_000;
/** The longest id, counted in code points. */
export const MAX_ID_CHARS = 128;
/** The most samples one ink stroke holds. */
export const MAX_INK_POINTS = 16_384;
/** The widest ink stroke, in board units. */
export const MAX_INK_SIZE = 64;
/** The longest clipboard fragment, in UTF-16 code units. */
export const FRAGMENT_MAX_CHARS = 2_000_000;
/** The most cards, connections and strokes one fragment holds. */
export const FRAGMENT_MAX_ITEMS = 5_000;
