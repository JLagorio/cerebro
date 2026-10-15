import { useEffect, useMemo, useState } from 'react';
import {
  parseSheetFence,
  sheetNames,
  sheetRequest,
  type SheetComputed,
  type SheetResult,
} from '@/engine/sheet/fence';
import { calculateSheets } from '@/lib/ipc';

export type SheetState =
  | { status: 'pending'; name: string }
  | { status: 'ready'; sheet: SheetComputed }
  | {
      status: 'unavailable';
      name: string;
      reason: 'fence' | 'engine' | 'name' | 'too-large';
      message: string;
    };

const cache = new Map<string, Promise<SheetResult[]>>();
const CACHE_LIMIT = 16;
export function resetSheetCache(): void {
  cache.clear();
}

function computed(
  key: string,
  sheets: Parameters<typeof calculateSheets>[0],
): Promise<SheetResult[]> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = Promise.resolve()
    .then(() => calculateSheets(sheets))
    .then((result) => {
      if (!Array.isArray(result) || result.length !== sheets.length)
        throw new Error("The sheet engine stopped on this page's sheets.");
      return result;
    })
    .catch((error: unknown) => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
  cache.set(key, pending);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return pending;
}

/** All fences on a page share one request, even when several blocks render
 * it. Results never enter the page source or outlive a changed request. */
export function useSheetWorkbook(
  sources: readonly string[],
  unclosed: readonly number[] = [],
): SheetState[] {
  const sourceKey = JSON.stringify([sources, unclosed]);
  const prepared = useMemo(() => {
    const [source, missing] = JSON.parse(sourceKey) as [string[], number[]];
    const fences = source.map((text, index) =>
      missing.includes(index)
        ? {
            ok: false as const,
            reason: 'header' as const,
            message: 'This sheet block has no closing fence.',
          }
        : parseSheetFence(text),
    );
    const names = sheetNames(fences);
    const request = sheetRequest(fences);
    const initial: SheetState[] = fences.map((fence, index) =>
      fence.ok
        ? { status: 'pending', name: names[index] }
        : { status: 'unavailable', name: names[index], reason: 'fence', message: fence.message },
    );
    return { initial, ...request, key: JSON.stringify(request.sheets) };
  }, [sourceKey]);
  const [result, setResult] = useState<{ prepared: typeof prepared; states: SheetState[] } | null>(
    null,
  );
  useEffect(() => {
    if (!prepared.sheets.length) return;
    let live = true;
    void computed(prepared.key, prepared.sheets)
      .then((sheets) => {
        const states = [...prepared.initial];
        sheets.forEach((sheet, index) => {
          states[prepared.slots[index]] = sheet.ok
            ? { status: 'ready', sheet }
            : {
                status: 'unavailable',
                name: sheet.name,
                reason: sheet.problem === 'too_large' ? 'too-large' : 'name',
                message: sheet.message,
              };
        });
        if (live) setResult({ prepared, states });
      })
      .catch((error: unknown) => {
        const states = [...prepared.initial];
        prepared.slots.forEach((slot, index) => {
          states[slot] = {
            status: 'unavailable',
            name: prepared.sheets[index].name,
            reason: 'engine',
            message: error instanceof Error ? error.message : String(error),
          };
        });
        if (live) setResult({ prepared, states });
      });
    return () => {
      live = false;
    };
  }, [prepared]);
  return result?.prepared === prepared ? result.states : prepared.initial;
}
