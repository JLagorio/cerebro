import { Fragment } from 'react';
import { instantText } from '@/engine/whenText';

/** A stamp with a time of day: shown on the reader's clock, like a run's. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One leaf as text: an instant on the reader's clock, nothing as a dash. */
function leafText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return INSTANT.test(value) ? instantText(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * A frontmatter value with structure — a map such as `generated: {by, at}`,
 * or a list of them — drawn the way a person reads it: one `key value` line
 * per key, nested maps indented under theirs. It is shown, not edited: a
 * text field would round-trip the map to disk as one string, which is how a
 * map becomes the text "[object Object]".
 */
export function StructuredValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (!value.some((item) => isMap(item) || Array.isArray(item))) {
      return <span>{value.map(leafText).join(', ')}</span>;
    }
    return (
      <div data-testid="structured-value" className="flex min-w-0 flex-col gap-1.5">
        {value.map((item, i) => (
          <StructuredValue key={i} value={item} />
        ))}
      </div>
    );
  }
  if (!isMap(value)) return <span>{leafText(value)}</span>;
  return (
    <dl
      data-testid="structured-value"
      className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs leading-4"
    >
      {Object.entries(value).map(([key, item]) => (
        <Fragment key={key}>
          <dt className="text-n-400">{key}</dt>
          <dd className="m-0 min-w-0 text-n-700 [overflow-wrap:anywhere]">
            {isMap(item) || Array.isArray(item) ? <StructuredValue value={item} /> : leafText(item)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Whether a value needs `StructuredValue` rather than a text field. */
export function isStructured(value: unknown): boolean {
  return Array.isArray(value) ? value.some((v) => isMap(v) || Array.isArray(v)) : isMap(value);
}
