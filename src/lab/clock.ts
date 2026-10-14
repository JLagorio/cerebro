import { VAULT_TODAY } from '@/lib/vaultToday';

/**
 * The state lab's clock (M64.1): the instant the e2e specs pin, so a preset
 * reads "3 hours ago" the same in the lab, in vitest and in Playwright.
 */
export const LAB_NOW = VAULT_TODAY;

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** An ISO stamp in UTC as epoch milliseconds, built with `Date.UTC` rather
 * than handed to the string parser, whose reading of a stamp has varied
 * between engines. */
export function instantOf(stamp: string): number {
  const parts = STAMP.exec(stamp);
  if (parts === null) throw new Error(`the lab clock takes YYYY-MM-DDTHH:MM:SSZ, not ${stamp}`);
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Clock pinned to 28 Jul 2026, 12:00 UTC", in the same words in every locale. */
export function clockLine(stamp: string = LAB_NOW): string {
  const at = new Date(instantOf(stamp));
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `Clock pinned to ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** The real constructor, held while a pin is installed. */
let real: DateConstructor | null = null;

/**
 * Pin what the clock READS: `Date.now()` and a zero-argument `new Date()` (and
 * `Date()` called bare) return `at`. `new Date(value)` and every timer stay
 * real, as with Playwright's `setFixedTime`, so debounces and React's own
 * scheduling still run.
 *
 * Idempotent: pinning again moves the pin, and the returned `unpin` restores
 * the real clock either way. Instances share the real prototype, so a date
 * made before the pin is still `instanceof Date` after it.
 */
export function pinClock(at: string = LAB_NOW): () => void {
  const RealDate = real ?? Date;
  real = RealDate;
  const ms = instantOf(at);
  const Pinned = function (this: unknown, ...args: unknown[]) {
    if (new.target === undefined) return new RealDate(ms).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [ms] : args, new.target) as Date;
  } as unknown as DateConstructor;
  Object.setPrototypeOf(Pinned, RealDate);
  Object.defineProperty(Pinned, 'prototype', { value: RealDate.prototype });
  Object.defineProperty(Pinned, 'now', { value: () => ms, configurable: true, writable: true });
  globalThis.Date = Pinned;
  return unpin;
}

/** Restore the real clock. A no-op when nothing is pinned. */
export function unpin(): void {
  if (real === null) return;
  globalThis.Date = real;
  real = null;
}
