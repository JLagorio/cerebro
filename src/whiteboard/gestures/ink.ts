import { addInk } from '@/engine/scene/commands';
import { strokeFromSamples, type DrawSample } from '@/engine/scene/draw';
import type { Board, InkStroke } from '@/engine/scene/model';
export function draftInk(
  board: Board,
  id: string,
  samples: readonly DrawSample[],
  simulated: boolean,
  color?: string | null,
): InkStroke | null {
  const stroke = strokeFromSamples(samples, simulated);
  if (!stroke) return null;
  const result = addInk(
    board,
    { strokes: [{ ...stroke, ...(color ? { color } : {}) }] },
    { createId: () => id },
  );
  return result.ok ? (result.board.ink.get(id) ?? null) : null;
}
