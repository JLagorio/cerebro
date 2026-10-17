/** Matching, not deliverability. Shared mail address/mailbox cases hold this
 * to mail/address.rs; non-ASCII spelling is retained, ASCII is folded. */
const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
export function normalizeAddress(raw: string): string | null {
  let value = trim(raw);
  if (/^mailto:/i.test(value)) value = trim(value.slice(7));
  if (value.startsWith('<') && value.endsWith('>')) value = trim(value.slice(1, -1));
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    [...local].length < 1 ||
    [...local].length > 64 ||
    !domain.includes('.') ||
    domain.split('.').some((part) => !part) ||
    /[\p{White_Space}\p{Cc}]/u.test(value) ||
    [...value].some((c) => '<>()[],;:"\\'.includes(c))
  )
    return null;
  return asciiLower(value);
}
export interface Mailbox {
  address: string;
  name: string | null;
}
export function parseMailbox(raw: string, nameChars: number): Mailbox | null {
  const value = trim(raw.replace(/\u00a0/g, ' '));
  const at = value.lastIndexOf('<');
  if (at < 0) {
    const address = normalizeAddress(value);
    return address === null ? null : { address, name: null };
  }
  const address = normalizeAddress(value.slice(at));
  if (address === null) return null;
  let name = trim(trim(value.slice(0, at)).replace(/^"+|"+$/g, ''));
  const lower = asciiLower(name);
  const vias = [' via ', ' (via ']
    .map((marker) => lower.indexOf(marker))
    .filter((index) => index >= 0);
  if (vias.length) name = name.slice(0, Math.min(...vias));
  name = trim(trim(name).replace(/^"+|"+$/g, ''));
  return {
    address,
    name:
      !name || name.includes('@')
        ? null
        : [...name.replace(/\p{Cc}/gu, '')].slice(0, nameChars).join(''),
  };
}
export function domainOf(raw: string): string | null {
  return normalizeAddress(raw)?.split('@')[1] ?? null;
}
