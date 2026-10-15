import RAW from '../../../shared/canvas/format.v1.json';

export const CANVAS_FORMAT_PATH = 'shared/canvas/format.v1.json';
export const CANVAS_DIGEST_PATH = 'shared/canvas/format.v1.sha256';

export interface CanvasFormat {
  readonly format: 1;
  readonly artifact_version: number;
  readonly json_canvas: '1.0';
  readonly cerebro_versions: readonly number[];
  readonly vocab: Readonly<
    Record<
      'node_types' | 'sides' | 'ends' | 'background_styles' | 'color_presets' | 'shapes',
      readonly string[]
    >
  >;
  readonly limits: Readonly<
    Record<
      | 'max_bytes'
      | 'max_depth'
      | 'max_id_chars'
      | 'max_coord'
      | 'max_nodes'
      | 'max_edges'
      | 'max_strokes'
      | 'max_ink_points'
      | 'max_ink_size',
      number
    >
  >;
  readonly key_order: Readonly<
    Record<
      'board' | 'text' | 'file' | 'link' | 'group' | 'edge' | 'cerebro' | 'card' | 'stroke',
      readonly string[]
    >
  >;
  readonly layout: { readonly indent: string; readonly trailing_newline: boolean };
}

const ROOT_KEYS = [
  'format',
  'artifact_version',
  'json_canvas',
  'cerebro_versions',
  'vocab',
  'limits',
  'key_order',
  'layout',
];
const VOCAB_KEYS = ['node_types', 'sides', 'ends', 'background_styles', 'color_presets', 'shapes'];
const LIMIT_KEYS = [
  'max_bytes',
  'max_depth',
  'max_id_chars',
  'max_coord',
  'max_nodes',
  'max_edges',
  'max_strokes',
  'max_ink_points',
  'max_ink_size',
];
const ORDER_KEYS = ['board', 'text', 'file', 'link', 'group', 'edge', 'cerebro', 'card', 'stroke'];
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((s) => typeof s === 'string' && s.length > 0) &&
  new Set(v).size === v.length;

/** Both codecs reject a damaged artifact before reading any board. */
export function parseCanvasFormat(raw: unknown): CanvasFormat {
  if (!object(raw) || raw.format !== 1) throw new Error('Canvas format must be 1.');
  if (
    !exact(raw, ROOT_KEYS) ||
    !positive(raw.artifact_version) ||
    raw.json_canvas !== '1.0' ||
    !Array.isArray(raw.cerebro_versions) ||
    raw.cerebro_versions.length === 0 ||
    !raw.cerebro_versions.every(positive) ||
    new Set(raw.cerebro_versions).size !== raw.cerebro_versions.length
  ) {
    throw new Error('Canvas format has missing, unknown or invalid fields.');
  }
  if (!exact(raw.vocab, VOCAB_KEYS) || !Object.values(raw.vocab).every(strings))
    throw new Error('Canvas vocabulary must contain each non-empty, unique list.');
  if (!exact(raw.limits, LIMIT_KEYS) || !Object.values(raw.limits).every(positive))
    throw new Error('Canvas limits must be positive whole numbers.');
  if (!exact(raw.key_order, ORDER_KEYS) || !Object.values(raw.key_order).every(strings))
    throw new Error('Canvas key order must contain every object type.');
  if (
    !exact(raw.layout, ['indent', 'trailing_newline']) ||
    typeof raw.layout.indent !== 'string' ||
    !/^[ \t]+$/.test(raw.layout.indent) ||
    typeof raw.layout.trailing_newline !== 'boolean'
  )
    throw new Error('Canvas layout must name an indent and trailing newline choice.');
  return raw as unknown as CanvasFormat;
}

export const CANVAS_FORMAT = parseCanvasFormat(RAW);
