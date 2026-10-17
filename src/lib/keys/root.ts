import type { CommandDef } from '@/app/commands';
import { hasModalLayers, subscribeLayers } from '@/components/ui/layers';
import { claimsKey, claimsOf, isEditableTarget } from './claims';
import { armChord, cancelChord, finishChord } from './chords';
import { isLetter, matchesSpec, type KeyLike } from './combo';
import { findBinding, inDesktop, type Chain } from './registry';

/**
 * The one keydown listener app shortcuts go through (M65.1).
 *
 * Capture phase on `window`, so it sees a key before every component on the
 * page. A React `stopPropagation` anywhere below — 90-odd of them, most
 * guarding an editor's keys — no longer silences ⌘K: the keymap has already
 * answered by then. What the keymap must NOT take, a surface says with
 * `data-key-claim` (`claims.ts`), and Escape is never bound: it belongs to
 * `layers.ts`.
 *
 * Scopes are DOM regions marked `data-key-scope` (name) and
 * `data-key-scope-id`. Focus picks the innermost one; when focus is on
 * `<body>` or in neutral chrome (`data-key-neutral`: the sidebar, the status
 * bar, toasts), the last scope a focusin or pointerdown landed in does.
 * Pointerdown counts because WKWebView never focuses a clicked button. With
 * neither, the page scope (`data-key-scope-page`) does.
 */

/** The scope id the root keeps when nothing in the DOM marks a page: a page
 * rendered on its own (a component test) binds its page commands here. */
export const ROOT_PAGE_ID = 'page:root';

const BARE_MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS']);

let installs = 0;
let recorded: Element | null = null;
let stopLayers: (() => void) | null = null;

function nearestScope(target: EventTarget | null): Element | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  return target.closest('[data-key-scope]');
}

function isNeutral(target: EventTarget | null): boolean {
  // An explicit scope inside chrome (a page's contextual navigation portal)
  // takes its own keys. A neutral control inside that scope still opts out.
  return (
    target instanceof Element &&
    target.closest('[data-key-neutral], [data-key-scope]')?.hasAttribute('data-key-neutral') ===
      true
  );
}

function record(e: Event): void {
  if (isNeutral(e.target)) return;
  recorded = nearestScope(e.target);
}

function available(scope: Element): boolean {
  return scope.isConnected && scope.closest('[inert], [hidden], [aria-hidden="true"]') === null;
}

/** The chain of scope ids a keystroke resolves along right now. */
export function activeChain(): Chain {
  if (typeof document === 'undefined') return ['app'];
  const active = document.activeElement;
  const focusCounts = active !== null && active !== document.body && !isNeutral(active);
  let start = focusCounts ? nearestScope(active) : recorded;
  if (start !== null && !available(start)) start = null;
  const pages = [...document.querySelectorAll('[data-key-scope-page]')];
  const page =
    pages.find(
      (page) => page.matches('[data-testid="pane"][data-active="true"]') && available(page),
    ) ??
    pages.find(available) ??
    null;
  if (start?.closest('[data-testid="pane"][data-parked="true"]')) start = null;
  start ??= page;
  const chain: string[] = [];
  for (let node: Element | null = start; node !== null;) {
    const id = node.getAttribute('data-key-scope-id');
    if (id !== null) chain.push(id);
    node = node.parentElement?.closest('[data-key-scope]') ?? null;
  }
  // Isolated page tests bind the root fallback. Mounted but hidden pages,
  // including those behind canvas chat, must never regain that authority.
  if (page === null && pages.length === 0) chain.push(ROOT_PAGE_ID);
  chain.push('app');
  return chain;
}

/**
 * Whether `def` may answer this keystroke. Letters stand down on an editable
 * target and under a modal layer; modifier commands stand down on an editable
 * target unless `inEditor`, and under a modal layer unless `inModal`.
 */
export function keyAdmits(
  def: CommandDef,
  e: KeyLike,
  at: { editable: boolean; modal: boolean },
): boolean {
  const { editable, modal } = at;
  const spec = def.keys.find((k) => matchesSpec(k, e));
  if (spec === undefined) return false;
  if (isLetter(spec)) {
    if (editable || modal) return false;
  } else {
    if (editable && !def.inEditor) return false;
    if (modal && !def.inModal) return false;
  }
  if (def.desktopOnly && !inDesktop()) return false;
  return true;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  if (BARE_MODIFIERS.has(e.key)) return;
  if (e.key === 'Escape') {
    cancelChord();
    return;
  }
  const target = e.target;
  if (claimsKey(claimsOf(target), e)) {
    cancelChord();
    return;
  }
  const editable = isEditableTarget(target);
  const modal = hasModalLayers();
  if (editable || modal) cancelChord();
  const finished = finishChord(e);
  if (finished?.swallow) {
    e.preventDefault();
    e.stopPropagation();
    finished.hit?.run(e);
    return;
  }
  const chain = activeChain();
  if (!editable && !modal && armChord(e, chain)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const hit = findBinding(chain, (def) => keyAdmits(def, e, { editable, modal }));
  if (hit === null) return;
  e.preventDefault();
  e.stopPropagation();
  hit.run(e);
}

/**
 * Install the listeners. Ref-counted, so the app shell and the test setup
 * can both hold it; the returned release is safe to call twice.
 */
export function installKeyRoot(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (installs === 0) {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('focusin', record, true);
    window.addEventListener('pointerdown', record, true);
    window.addEventListener('pointerdown', cancelChord, true);
    window.addEventListener('blur', cancelChord);
    stopLayers = subscribeLayers(() => {
      if (hasModalLayers()) cancelChord();
    });
  }
  installs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('focusin', record, true);
      window.removeEventListener('pointerdown', record, true);
      window.removeEventListener('pointerdown', cancelChord, true);
      window.removeEventListener('blur', cancelChord);
      stopLayers?.();
      stopLayers = null;
      cancelChord();
    }
  };
}

/** Test seam: forget the recorded scope. */
export function resetKeyRoot(): void {
  recorded = null;
  cancelChord();
}
