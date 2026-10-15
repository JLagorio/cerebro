import type { CanvasTransform } from '@/mermaid/CanvasViewport';
import { MAX_SCALE, MIN_SCALE } from '@/mermaid/CanvasViewport';
const KEY = 'cerebro.whiteboard.cameras';
interface StoredCamera {
  key: string;
  transform: CanvasTransform;
}
type CameraStorage = Pick<Storage, 'getItem' | 'setItem'>;
function valid(value: unknown): value is StoredCamera {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<StoredCamera>;
  const t = entry.transform;
  return (
    typeof entry.key === 'string' &&
    !!t &&
    Number.isFinite(t.scale) &&
    t.scale >= MIN_SCALE &&
    t.scale <= MAX_SCALE &&
    !!t.offset &&
    Number.isFinite(t.offset.x) &&
    Number.isFinite(t.offset.y)
  );
}
function rows(storage: CameraStorage): StoredCamera[] {
  const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
  return Array.isArray(parsed) ? parsed.filter(valid).slice(-100) : [];
}
export function readCamera(key: string, storage?: CameraStorage): CanvasTransform | null {
  try {
    return rows(storage ?? window.localStorage).find((row) => row.key === key)?.transform ?? null;
  } catch {
    return null;
  }
}
export function writeCamera(
  key: string,
  transform: CanvasTransform,
  storage?: CameraStorage,
): void {
  try {
    if (!valid({ key, transform })) return;
    const target = storage ?? window.localStorage;
    target.setItem(
      KEY,
      JSON.stringify(
        [...rows(target).filter((row) => row.key !== key), { key, transform }].slice(-100),
      ),
    );
  } catch {
    /* A view preference cannot make the board unavailable. */
  }
}
