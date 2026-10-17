import source from '../../../shared/canvas/agent-limits.v1.json';

export interface CanvasLimits {
  readonly format: 1;
  readonly artifact_version: number;
  readonly edit: Readonly<
    Record<
      | 'ops'
      | 'id_chars'
      | 'text_chars'
      | 'label_chars'
      | 'file_chars'
      | 'subpath_chars'
      | 'url_chars',
      number
    >
  >;
  readonly read: { readonly nodes: number; readonly bytes: number; readonly ids: number };
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function keys(
  value: unknown,
  expected: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(`Canvas agent limits ${path} must contain only ${expected.join(', ')}.`);
}
function positive(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Canvas agent limits ${path} must be a positive whole number.`);
}
export function readCanvasLimits(value: unknown): CanvasLimits {
  if (!object(value) || value.format !== 1)
    throw new Error('Canvas agent limits format must be 1.');
  keys(value, ['format', 'artifact_version', 'read', 'edit'], 'root');
  positive(value.artifact_version, 'artifact_version');
  keys(value.read, ['nodes', 'bytes', 'ids'], 'read');
  for (const field of ['nodes', 'bytes', 'ids']) positive(value.read[field], `read.${field}`);
  const edit = [
    'ops',
    'id_chars',
    'text_chars',
    'label_chars',
    'file_chars',
    'subpath_chars',
    'url_chars',
  ];
  keys(value.edit, edit, 'edit');
  for (const field of edit) positive(value.edit[field], `edit.${field}`);
  return value as unknown as CanvasLimits;
}
export const CANVAS_LIMITS = readCanvasLimits(source);
