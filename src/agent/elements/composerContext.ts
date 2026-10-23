import type { ContextUsage } from '@/components/ai/Context';
import type { ContextUseState } from '@/agent/useContextUse';

/**
 * The composer's Context reading (M91.12a) from what `useContextUse` pulled
 * (M91.5). The element knows three readings; the pull's wait for a
 * session's first answer is none of them, so it reads not recorded — never
 * a figure, and never another conversation's — until the answer lands. A
 * window that is not a positive count was not reported, so nothing divides
 * by it, and a count that is not one could not be read (CV-05). Nothing
 * here keeps a reading (Q7). Pure.
 */

const NOT_RECORDED: ContextUsage = { state: 'not_recorded' };
const UNAVAILABLE: ContextUsage = { state: 'unavailable' };

/** A reported window: a positive, finite count; else not reported. */
function windowOf(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The element's reading of what the composer's pull answered. */
export function contextUsageOf(reading: ContextUseState): ContextUsage {
  switch (reading.state) {
    case 'recorded': {
      if (!(Number.isFinite(reading.used) && reading.used >= 0)) return UNAVAILABLE;
      const model = reading.model?.trim() ?? '';
      return {
        state: 'recorded',
        used: reading.used,
        window: windowOf(reading.window),
        model: model === '' ? null : model,
      };
    }
    case 'unavailable':
      return UNAVAILABLE;
    case 'loading':
    case 'not_recorded':
      return NOT_RECORDED;
  }
}
