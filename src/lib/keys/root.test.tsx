import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandDef } from '@/app/commands';
import { popLayer, pushLayer, resetLayers } from '@/components/ui/layers';
import { isEditableTarget } from './claims';
import { APP_SCOPE, bind } from './registry';
import { activeChain, keyAdmits, ROOT_PAGE_ID } from './root';

// src/test/setup.ts installs the root, exactly as App.tsx does.

afterEach(() => {
  cleanup();
  resetLayers();
  document.body.replaceChildren();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** A page scope and a peek, side by side, and neutral chrome. */
function mountScopes() {
  const host = document.createElement('div');
  host.innerHTML =
    '<main data-key-scope="page" data-key-scope-id="page:1" data-key-scope-page>' +
    '<button id="in-page">a</button><input id="field"><textarea id="area"></textarea>' +
    '<select id="pick"></select><div contenteditable="true"><p id="prose">x</p></div>' +
    '<div data-key-claim="editor"><button id="claimed">c</button></div></main>' +
    '<aside data-key-scope="peek" data-key-scope-id="peek:1"><button id="in-peek">b</button></aside>' +
    '<nav data-key-neutral><button id="nav">n</button></nav>';
  document.body.append(host);
  const at = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;
  return { host, at };
}

const PAGE = { id: 'page:1', name: 'page' };
const PEEK = { id: 'peek:1', name: 'peek' };

describe('the capture-phase listener', () => {
  // The M29.53 regression: a blanket React stopPropagation starved App.tsx's
  // old bubble-phase window listener, so ⌘K was dead inside a source box.
  it('a component that stops every keydown does not silence a bound ⌘K', () => {
    const open = vi.fn();
    bind(APP_SCOPE, 'palette.open', { run: open });
    const { getByRole } = render(
      <div onKeyDown={(e) => e.stopPropagation()}>
        <button type="button">inside</button>
      </div>,
    );
    const button = getByRole('button');
    button.focus();
    fireEvent.keyDown(button, { key: 'k', metaKey: true });
    expect(open).toHaveBeenCalledOnce();
  });

  it('prevents and stops a handled key, and leaves an unhandled one untouched', () => {
    bind(APP_SCOPE, 'palette.open', { run: () => {} });
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      const handled = keydown(document.body, { key: 'k', metaKey: true });
      expect(handled.defaultPrevented).toBe(true);
      expect(later).not.toHaveBeenCalled();
      const unhandled = keydown(document.body, { key: 'q', metaKey: true });
      expect(unhandled.defaultPrevented).toBe(false);
      expect(later).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', later);
    }
  });

  it('ignores a key in an IME composition', () => {
    const open = vi.fn();
    bind(APP_SCOPE, 'palette.open', { run: open });
    keydown(document.body, { key: 'k', metaKey: true, isComposing: true });
    keydown(document.body, { key: 'k', metaKey: true, keyCode: 229 });
    expect(open).not.toHaveBeenCalled();
  });

  it('never takes Escape', () => {
    expect(keydown(document.body, { key: 'Escape' }).defaultPrevented).toBe(false);
  });
});

describe('editors, claims and layers', () => {
  it('a modifier command stands down in every editable target, unless inEditor', () => {
    const { at } = mountScopes();
    const split = vi.fn();
    const open = vi.fn();
    bind(PAGE, 'work.split', { run: split });
    bind(APP_SCOPE, 'palette.open', { run: open });
    for (const id of ['field', 'area', 'pick', 'prose']) {
      keydown(at(id), { key: '\\', metaKey: true });
      keydown(at(id), { key: 'k', metaKey: true });
    }
    expect(split).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(4);
  });

  it('a claimed element keeps its keys', () => {
    const { at } = mountScopes();
    const undo = vi.fn();
    bind(APP_SCOPE, 'undo', { run: undo });
    expect(keydown(at('claimed'), { key: 'z', metaKey: true }).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    keydown(at('in-page'), { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledOnce();
  });

  it('a modal layer stands commands down unless inModal; a modal:false one does not', () => {
    mountScopes();
    const split = vi.fn();
    const open = vi.fn();
    bind(PAGE, 'work.split', { run: split });
    bind(APP_SCOPE, 'palette.open', { run: open });
    pushLayer('dialog');
    keydown(document.body, { key: '\\', metaKey: true });
    keydown(document.body, { key: 'k', metaKey: true });
    expect(split).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    popLayer('dialog');
    pushLayer('peek', { modal: false });
    keydown(document.body, { key: '\\', metaKey: true });
    expect(split).toHaveBeenCalledOnce();
  });

  it('a desktopOnly command needs the desktop shell', () => {
    mountScopes();
    const close = vi.fn();
    bind(PAGE, 'work.closeTab', { run: close });
    expect(keydown(document.body, { key: 'w', metaKey: true }).defaultPrevented).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    keydown(document.body, { key: 'w', metaKey: true });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('letters', () => {
  // No letter row ships before M65.1b, so the gate is asked directly.
  const LETTER: CommandDef = {
    id: 'test.down',
    label: 'Down',
    keys: ['j'],
    scope: 'page',
    group: 'Lists',
  };
  const j = {
    key: 'j',
    code: 'KeyJ',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  it('stand down in an input, textarea, select and contenteditable', () => {
    const { at } = mountScopes();
    for (const id of ['field', 'area', 'pick', 'prose']) {
      expect(keyAdmits(LETTER, j, { editable: isEditableTarget(at(id)), modal: false })).toBe(
        false,
      );
    }
    expect(keyAdmits(LETTER, j, { editable: isEditableTarget(at('in-page')), modal: false })).toBe(
      true,
    );
  });

  it('stand down under a modal layer, even when marked inModal', () => {
    expect(keyAdmits(LETTER, j, { editable: false, modal: true })).toBe(false);
    expect(keyAdmits({ ...LETTER, inModal: true }, j, { editable: false, modal: true })).toBe(
      false,
    );
  });
});

describe('which scope a key resolves in', () => {
  it('the focused element picks its scope', () => {
    const { at } = mountScopes();
    at('in-peek').focus();
    expect(activeChain()).toEqual(['peek:1', 'app']);
    at('in-page').focus();
    expect(activeChain()).toEqual(['page:1', 'app']);
  });

  it('with focus on body, the last pointerdown picks it', () => {
    const { at } = mountScopes();
    const page = vi.fn();
    const peek = vi.fn();
    bind(PAGE, 'diagram.undo', { run: page });
    bind(PEEK, 'diagram.undo', { run: peek });
    fireEvent.pointerDown(at('in-peek'));
    keydown(document.body, { key: 'z', metaKey: true });
    expect(peek).toHaveBeenCalledOnce();
    expect(page).not.toHaveBeenCalled();
  });

  it('neutral chrome keeps the scope it found, focused or clicked', () => {
    const { at } = mountScopes();
    fireEvent.pointerDown(at('in-peek'));
    fireEvent.pointerDown(at('nav'));
    at('nav').focus();
    expect(activeChain()).toEqual(['peek:1', 'app']);
  });

  it('nothing recorded falls back to the page scope', () => {
    mountScopes();
    expect(activeChain()).toEqual(['page:1', 'app']);
  });

  it('a removed scope falls back to the page scope', () => {
    const { at, host } = mountScopes();
    fireEvent.pointerDown(at('in-peek'));
    host.querySelector('aside')!.remove();
    expect(activeChain()).toEqual(['page:1', 'app']);
  });

  it('an unscoped click forgets the scope', () => {
    const { at } = mountScopes();
    fireEvent.pointerDown(at('in-peek'));
    fireEvent.pointerDown(document.body);
    expect(activeChain()).toEqual(['page:1', 'app']);
  });

  it('with no page in the DOM, the root keeps a fallback page', () => {
    expect(activeChain()).toEqual([ROOT_PAGE_ID, 'app']);
  });
});
