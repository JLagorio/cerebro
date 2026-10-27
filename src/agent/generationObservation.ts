import type { GenerationObservation } from './types';

/** Selectors and observations are metadata only; they never name a local
 * process or grant permission to attach, stop, resume or replay a request. */
export function isGenerationRequestKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

/** Native receipts are bounded plain facts. Copy only their four fields,
 * so a malformed/cache-shaped object cannot add execution-looking values. */
export function readGenerationObservation(value: unknown): GenerationObservation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !isGenerationRequestKey(raw.generationId) ||
    !isGenerationRequestKey(raw.firstRunId) ||
    !isGenerationRequestKey(raw.currentRunId) ||
    typeof raw.state !== 'string' ||
    !/^[a-z][a-z_]{0,15}$/.test(raw.state)
  )
    return null;
  return {
    generationId: raw.generationId,
    firstRunId: raw.firstRunId,
    currentRunId: raw.currentRunId,
    state: raw.state,
  };
}
