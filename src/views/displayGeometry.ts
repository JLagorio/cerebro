/** Render-only defaults: measuring a host never changes a saved presentation. */
export function tableTitleWidth(available: number, saved?: number): number {
  if (saved !== undefined) return saved;
  if (available <= 0) return 320;
  return available < 720
    ? Math.max(200, Math.min(320, available * 0.6))
    : Math.max(320, Math.min(480, available * 0.32));
}

/** A time view budgets its viewport, independently of its stored columns. */
export function timeTableAllocation(available: number, requested?: number) {
  const width = available > 0 ? available : 1000;
  const narrow = width < 720;
  const min = narrow ? Math.min(160, width / 2) : 240;
  const max = narrow ? Math.min(220, width / 2) : Math.min(420, width / 2, width - 320);
  const preferred = requested ?? (narrow ? 180 : width * 0.35);
  return { min, max, width: Math.max(min, Math.min(max, preferred)), narrow };
}
