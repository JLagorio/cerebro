import { Fragment } from 'react';
import { commandDef } from '@/app/commands';
import { comboId, IS_MAC, keycapParts, parseKeys } from '@/lib/keys/combo';

/** Adjacent digit alternatives are one range, preserving the catalog order. */
function groups(specs: readonly string[], mac: boolean): string[][][] {
  const out: string[][][] = [];
  for (let at = 0; at < specs.length; at += 1) {
    const spec = specs[at]!;
    const steps = parseKeys(spec);
    const first = steps[0];
    let end = at;
    if (steps.length === 1 && /^\d$/.test(first.key)) {
      const prefix = comboId({ ...first, key: '' });
      while (end + 1 < specs.length) {
        const next = parseKeys(specs[end + 1]!);
        if (
          next.length !== 1 ||
          !/^\d$/.test(next[0].key) ||
          comboId({ ...next[0], key: '' }) !== prefix ||
          Number(next[0].key) !== Number(first.key) + end - at + 1
        )
          break;
        end += 1;
      }
    }
    const parts = keycapParts(spec, mac);
    if (end > at) {
      parts[0]![parts[0]!.length - 1] = `${first.key}–${parseKeys(specs[end]!)[0].key}`;
    }
    out.push(parts);
    at = end;
  }
  return out;
}

export function keysText(keys: string | readonly string[], mac: boolean = IS_MAC): string {
  return groups(typeof keys === 'string' ? [keys] : keys, mac)
    .map((steps) => steps.map((parts) => parts.join(mac ? '' : '+')).join(' then '))
    .join(' or ');
}

/** A text-only hint uses the same catalog and platform labels as the caps. */
export function keycapText(command: string, mac: boolean = IS_MAC): string {
  return keysText(commandDef(command).keys, mac);
}

type KeycapsProps = {
  className?: string;
  mac?: boolean;
} & ({ command: string; keys?: never } | { command?: never; keys: string | readonly string[] });

/** App commands name their row; a dialog-local key can supply its own spec. */
export function Keycaps({ command, keys, className = '', mac = IS_MAC }: KeycapsProps) {
  const specs =
    command !== undefined ? commandDef(command).keys : typeof keys === 'string' ? [keys] : keys;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs ${className}`}
      data-keys={specs.join(', ')}
      aria-label={keysText(specs, mac)}
    >
      {groups(specs, mac).map((steps, alternative) => (
        <Fragment key={alternative}>
          {alternative > 0 && <span className="px-0.5">or</span>}
          {steps.map((parts, step) => (
            <Fragment key={step}>
              {step > 0 && <span className="px-0.5">then</span>}
              <span className="inline-flex items-center gap-0.5">
                {parts.map((part, index) => (
                  <kbd
                    key={index}
                    className="min-w-4 rounded-sm border border-n-200 bg-transparent px-1 py-0.5 text-center font-mono text-xs leading-none"
                  >
                    {part}
                  </kbd>
                ))}
              </span>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
