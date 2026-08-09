/**
 * `project()` — the TS half of the byte-stable OKF projection (M22.4/5),
 * a line-for-line port of `src-tauri/src/ledger/project.rs`. The reducer
 * needs it because `belief.attested` pins the hash of the pinned revision's
 * projection. Parity is proven by the conformance vectors.
 */

import type { Json } from './ids';

export function project(content: string, fields: Json): string {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return content;
  const entries = Object.entries(fields);
  if (entries.length === 0) return content;
  let out = '---\n';
  for (const [key, value] of entries) out += renderTopField(key, value);
  out += '---\n';
  out += content;
  return out;
}

function renderTopField(key: string, value: Json): string {
  if (Array.isArray(value)) return renderArrayField(key, value);
  if (typeof value === 'object' && value !== null) return `${key}: ${renderFlow(value)}\n`;
  return `${key}: ${renderScalar(value, false)}\n`;
}

function renderArrayField(key: string, items: Json[]): string {
  const allScalars = items.every((i) => typeof i !== 'object' || i === null);
  const flowSafe =
    allScalars && items.every((i) => !(typeof i === 'string' && needsQuote(i, true)));
  if (items.length === 0 || (allScalars && flowSafe)) {
    return `${key}: [${items.map((i) => renderScalar(i, true)).join(', ')}]\n`;
  }
  let out = `${key}:\n`;
  for (const item of items) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.length > 2) {
        let first = true;
        for (const [k, v] of entries) {
          out += first ? '  - ' : '    ';
          first = false;
          out +=
            typeof v === 'object' && v !== null
              ? `${k}: ${renderFlow(v)}\n`
              : `${k}: ${renderScalar(v, false)}\n`;
        }
      } else {
        out += `  - ${renderFlow(item)}\n`;
      }
    } else {
      out += `  - ${renderScalar(item, false)}\n`;
    }
  }
  return out;
}

function renderFlow(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(renderFlow).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const inner = Object.entries(value)
      .map(([k, v]) => `${k}: ${renderFlow(v)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  return renderScalar(value, true);
}

function renderScalar(value: Json, flow: boolean): string {
  if (typeof value === 'string') return needsQuote(value, flow) ? quote(value) : value;
  if (value === null) return 'null';
  return JSON.stringify(value);
}

function needsQuote(s: string, flow: boolean): boolean {
  if (s.length === 0) return true;
  const first = s[0];
  if ('[]{}#&*!|>\'"%@`'.includes(first) || /\s/.test(first)) return true;
  if (/\s$/.test(s) || s.endsWith(':')) return true;
  if (s.startsWith('- ') || s.startsWith('? ') || s === '-' || s === '~') return true;
  if (s.includes(': ') || s.includes(' #') || s.includes('\n') || s.includes('"')) return true;
  if (flow && /[,[\]{}]/.test(s)) return true;
  const lower = s.toLowerCase();
  if (['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(lower)) return true;
  // Rust-side twin is `s.parse::<f64>().is_ok()` — mirror its grammar, not
  // JS Number() (which would also accept hex and reject "inf").
  if (/^[+-]?(inf(inity)?|nan|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/i.test(s)) return true;
  return false;
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  return out + '"';
}
