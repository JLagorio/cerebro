/** Drop dead places and coalesce adjacent equal survivors before stepping.
 * A dead current place is a gap: Back takes its nearest predecessor and
 * Forward its nearest successor, rather than consuming an extra step.
 * Skipped live slots stay in history, so a file held elsewhere is reachable
 * again when the other pane releases it (M65.8). */
export function stepLive<T>(
  slots: readonly T[],
  index: number,
  dir: -1 | 1,
  isLive: (slot: T) => boolean,
  same: (a: T, b: T) => boolean,
  skip: (slot: T) => boolean = () => false,
): { slots: T[]; index: number; moved: boolean } {
  const groups: { slot: T; positions: number[] }[] = [];
  slots.forEach((slot, position) => {
    if (!isLive(slot)) return;
    const last = groups.at(-1);
    if (last && same(last.slot, slot)) {
      last.positions.push(position);
      if (position === index) last.slot = slot;
    } else groups.push({ slot, positions: [position] });
  });
  if (!groups.length) return { slots: [], index: 0, moved: false };
  const current = groups.findIndex((group) => group.positions.includes(index));
  let target =
    current >= 0
      ? current + dir
      : dir === -1
        ? groups.reduce(
            (last, group, at) => (group.positions.some((position) => position < index) ? at : last),
            -1,
          )
        : groups.findIndex((group) => group.positions.some((position) => position > index));
  while (target >= 0 && target < groups.length && skip(groups[target].slot)) target += dir;
  const moved = target >= 0 && target < groups.length;
  const nearest = groups.reduce(
    (best, group, at) => {
      const distance = Math.min(...group.positions.map((position) => Math.abs(position - index)));
      return distance < best.distance ? { at, distance } : best;
    },
    { at: 0, distance: Infinity },
  ).at;
  return {
    slots: groups.map((group) => group.slot),
    index: moved ? target : current >= 0 ? current : nearest,
    moved,
  };
}
