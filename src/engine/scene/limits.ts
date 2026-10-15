/**
 * The scene's file caps come from the artifact both codecs read (M68.2).
 * Editor history and clipboard caps belong only to this UI model.
 */
import { CANVAS_FORMAT } from './format';

/** Undo steps the editor keeps. */
export const HISTORY_LIMIT = 100;
/** How far a paste or duplicate shifts its items, in board units. */
export const PASTE_OFFSET = 24;
/** The smallest width or height a box may have. */
export const MIN_SIZE = 1;
/** The largest |x| or |y|, and the largest width or height. */
export const MAX_COORD = CANVAS_FORMAT.limits.max_coord;
/** The longest id, counted in code points. */
export const MAX_ID_CHARS = CANVAS_FORMAT.limits.max_id_chars;
/** The most samples one ink stroke holds. */
export const MAX_INK_POINTS = CANVAS_FORMAT.limits.max_ink_points;
/** The widest ink stroke, in board units. */
export const MAX_INK_SIZE = CANVAS_FORMAT.limits.max_ink_size;
/** The longest clipboard fragment, in UTF-16 code units. */
export const FRAGMENT_MAX_CHARS = 2_000_000;
/** The most cards, connections and strokes one fragment holds. */
export const FRAGMENT_MAX_ITEMS = 5_000;
