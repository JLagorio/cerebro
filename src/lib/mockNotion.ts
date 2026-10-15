/** Browser-only captured outcomes. Rust alone converts Notion markup and
 * relinks existing pages. Seeds use the Rust fixture writer's output, never a
 * second converter; each mock run gets its own lifetime and permission book. */
export interface MockNotionRefusal {
  reason: string;
  words: string;
}
export interface MockNotionCapture {
  title: string;
  result:
    | { markdown: string; counts: { linked: number; media: number; databases: number } }
    | { refusal: MockNotionRefusal };
  /** Explicit fixture for a composed fallback; the desktop validates its
   * complete grammar. An unseeded fallback is unavailable in browser mode. */
  composed?: { body: string; markdown: string };
}
interface Captured {
  capture: MockNotionCapture;
  composable: boolean;
}
const runs = new Map<string, Map<string, Captured>>();
export function resetNotionCaptures(): void {
  runs.clear();
}
export function seedNotionCapture(run: string, page: string, capture: MockNotionCapture): void {
  const held = runs.get(run) ?? new Map<string, Captured>();
  if (!held.has(page) && held.size >= 8) held.delete(held.keys().next().value!);
  held.set(page, { capture: structuredClone(capture), composable: false });
  runs.set(run, held);
}
export function beginMockNotionRun(run: string, enabled: boolean): void {
  runs.delete(run);
  if (!enabled || typeof window === 'undefined') return;
  const seeds = (window as unknown as { __cerebroMockCaptures?: Record<string, MockNotionCapture> })
    .__cerebroMockCaptures;
  for (const [page, capture] of Object.entries(seeds ?? {}).slice(0, 8))
    seedNotionCapture(run, page, capture);
}
export function endMockNotionRun(run: string): void {
  runs.delete(run);
}
export function notionCapture(run: string, page: string): Captured | undefined {
  return runs.get(run)?.get(page);
}
export function notionRefusal(why: MockNotionRefusal): string {
  let words = `import_refused: ${why.reason} — ${why.words} Nothing was written.`;
  if (['truncated', 'narrated', 'unhandled_markup'].includes(why.reason))
    words +=
      ' You may compose the page yourself from what the fetch returned and call again with it as body; it will be marked as composed by you.';
  return words;
}
