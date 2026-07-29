/**
 * Which backend the app is running against.
 *
 * Tauri injects `__TAURI_INTERNALS__` into the webview, so its absence means
 * the frontend is running alone — `pnpm dev`, vitest, Playwright — against
 * the in-memory mocks in lib/mockIpc.ts and agent/mockAgent.ts. Nothing in
 * that mode touches disk and the assistant's replies are a fixed script.
 *
 * This test used to live as a private copy in three modules and was stated
 * nowhere on screen, which made `pnpm dev` indistinguishable from the real
 * app right up until you wondered why your own vault would not open and why
 * the assistant said the same thing every time. It is one function now, and
 * demo mode announces itself (app/DemoBadge.tsx).
 */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when both the vault and the assistant are simulated. */
export function isDemoMode(): boolean {
  return !inTauri();
}
