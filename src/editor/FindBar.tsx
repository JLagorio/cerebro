import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { closeHistory } from 'prosemirror-history';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useEscapeLayer } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { assigneeLabel, wikilinkLabel } from './chipLabels';
import { clearFindHits, FIND_CLASS, findHighlightsKey, showFindHits } from './findHighlights';
import {
  findHits,
  firstAtOrAfter,
  nextIndex,
  replacementPlan,
  type FindHit,
  type LabelOf,
} from './findMatches';
import { NotePathContext } from './notePath';
import { blockElement, openTogglesAround } from './sectionLinks';

/**
 * Find and replace in a page (M59.6): ⌘F, ⌥⌘F for Replace, ⌘G and ⇧⌘G.
 *
 * WKWebView has no find bar, so nothing found anything before this. Matching
 * is findMatches.ts's and drawing is findHighlights.ts's; this is the bar,
 * the keys, and the one place the page is changed: Replace, which is an
 * ordinary edit the editor's debounced save writes like any other (D2). The
 * bar itself never writes a file.
 *
 * Several pages can be on screen at once (a page and a record peek), so each
 * mounted bar registers here and a key acts on one: the bar whose page holds
 * focus, else the page focused last, else the first page in the document.
 * Focus anywhere else, or in a dialog or menu inside the page, and the key is
 * left alone, not even prevented. Not `hasLayers()`: the record peek is a
 * surface layer, and ⌘F inside it must still find.
 */

type Editor = BlockNoteEditor<any, any, any>;

interface FindBarProps {
  editor: Editor;
  /** The editor's host element: where focus is looked for, and hits drawn. */
  host: RefObject<HTMLElement | null>;
  readOnly: boolean;
}

interface Registered {
  host: () => HTMLElement | null;
  lastFocusAt: number;
}

const bars = new Set<Registered>();
let focusClock = 0;

/** Focus inside one of these, within the page, belongs to it and not to find. */
const BLOCKERS = '[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';

/** The bar a find key acts on, or null to leave the key alone. */
function targetBar(): Registered | null {
  const live = [...bars].filter((b) => b.host()?.isConnected === true);
  if (live.length === 0) return null;
  const active = document.activeElement;
  const nothingFocused =
    active === null || active === document.body || active === document.documentElement;
  if (!nothingFocused) {
    // The innermost page holding focus.
    const owners = live.filter((b) => b.host()!.contains(active));
    const owner = owners.find((b) => !owners.some((o) => o !== b && b.host()!.contains(o.host())));
    if (owner === undefined) return null;
    // A dialog or menu between the page and the focus owns the keystroke; one
    // the whole page sits in (a peek) does not.
    const blocker = active.closest(BLOCKERS);
    if (blocker !== null && !blocker.contains(owner.host())) return null;
    return owner;
  }
  const recent = live.reduce<Registered | null>(
    (best, b) => (b.lastFocusAt > (best?.lastFocusAt ?? 0) ? b : best),
    null,
  );
  if (recent !== null) return recent;
  return live.sort((a, b) =>
    a.host()!.compareDocumentPosition(b.host()!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )[0];
}

/** The longest selection that seeds the query. */
const MAX_SEED = 200;

/** Escape, while focus is inside the bar: a layer only then (Q15), so Escape
 * in the page keeps its editor meanings and a surface behind stays open. */
function EscapeWhileFocused({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(onEscape, { kind: 'surface' });
  return null;
}

/** A chip's label for find: link and person chips only, read once per pass. */
function labelsFor(entries: Entry[], notePath: string | null): LabelOf {
  const memo = new Map<string, string>();
  return (type, attrs) => {
    if (type !== 'wikilink' && type !== 'assignee') return null;
    const target = typeof attrs.target === 'string' ? attrs.target : '';
    const alias = typeof attrs.alias === 'string' ? attrs.alias : '';
    const key = `${type}\u0000${target}\u0000${alias}`;
    let label = memo.get(key);
    if (label === undefined) {
      label =
        type === 'wikilink'
          ? wikilinkLabel({ target, alias }, entries, notePath)
          : assigneeLabel({ target }, entries);
      memo.set(key, label);
    }
    return label;
  };
}

/**
 * Replace `ranges` (last first) with `text`, as one undo step. History is
 * closed before, so the replace never joins the typing that came just before
 * it, and after, so the typing that follows never joins the replace. An
 * empty `text` deletes (Q13). Refused on a locked page, mid-composition, or
 * with nothing to replace.
 */
function applyReplacements(
  editor: Editor,
  ranges: readonly { from: number; to: number }[],
  text: string,
): boolean {
  if (!editor.isEditable || editor.prosemirrorView?.composing === true || ranges.length === 0) {
    return false;
  }
  editor.transact((tr) => {
    closeHistory(tr);
    for (const { from, to } of ranges) {
      if (text === '') {
        tr.delete(from, to);
        continue;
      }
      const $from = tr.doc.resolve(from);
      const $to = tr.doc.resolve(to);
      tr.replaceWith(
        from,
        to,
        tr.doc.type.schema.text(text, $from.marksAcross($to) ?? $from.marks()),
      );
    }
  });
  editor.transact((tr) => {
    closeHistory(tr);
  });
  return true;
}

/** What Replace all says it did. */
function replacedStatus(replaced: number, links: number): string {
  const left = links === 1 ? '1 in a link left as is' : `${links} in links left as is`;
  if (replaced > 0) return links > 0 ? `Replaced ${replaced} · ${left}` : `Replaced ${replaced}`;
  return links > 0 ? `Nothing replaced · ${left}` : 'Nothing to change';
}

/** Where the drawn current hit sits now, mapped through every edit since. */
function drawnCurrentFrom(editor: Editor): number | null {
  const set = findHighlightsKey.getState(editor.prosemirrorState);
  const current = set
    ?.find()
    .find((d) =>
      String((d as unknown as { type: { attrs: { class?: string } } }).type.attrs.class).includes(
        FIND_CLASS.current,
      ),
    );
  return current?.from ?? null;
}

function BarIcon({
  icon,
  label,
  testId,
  disabled,
  pressed,
  onClick,
}: {
  icon: string;
  label: string;
  testId: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        className={`cb-find-icon${pressed === true ? ' cb-find-icon-on' : ''}`}
      >
        <Icon name={icon} size={14} />
      </button>
    </Tooltip>
  );
}

export function FindBar({ editor, host, readOnly }: FindBarProps) {
  const entries = useVaultStore((s) => s.entries);
  const notePath = useContext(NotePathContext);
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [hits, setHits] = useState<FindHit[]>([]);
  // The query `hits` were found for: until the next frame finds the one just
  // typed, the count says nothing rather than "No matches".
  const [foundFor, setFoundFor] = useState('');
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [focusInBar, setFocusInBar] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const findInput = useRef<HTMLInputElement | null>(null);
  const frame = useRef<number | null>(null);
  const reasonRef = useRef<'query' | 'doc'>('doc');

  // The latest values, for the window listener and the frame callback.
  const live = useRef({ open, query, hits, current, entries, notePath, readOnly });
  live.current = { open, query, hits, current, entries, notePath, readOnly };

  const labelOf = () => labelsFor(live.current.entries, live.current.notePath);

  /** Bring hit `hit` into view: open the toggles around it, then centre it. */
  const reveal = (hit: FindHit | undefined) => {
    const el = host.current;
    if (hit === undefined || el === null) return;
    if (hit.blockId !== null) {
      const block = blockElement(el, hit.blockId);
      if (block !== null) openTogglesAround(block);
    }
    window.requestAnimationFrame(() => {
      el.querySelector(`[data-find="${hit.index}"]`)?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      });
    });
  };

  /** Find `q` now, starting at the first hit at or after `anchor`. */
  const compute = (q: string, anchor: number): { hits: FindHit[]; current: number } => {
    const found = findHits(editor.prosemirrorState.doc, q, labelOf());
    const at = firstAtOrAfter(found, anchor);
    setHits(found);
    setFoundFor(q);
    setCurrent(at);
    live.current.hits = found;
    live.current.current = at;
    showFindHits(editor, found, at);
    return { hits: found, current: at };
  };

  /** Run a find still waiting for its frame now, so a step never draws hits
   * the page has moved out from under. */
  const settle = () => {
    if (frame.current === null) return;
    window.cancelAnimationFrame(frame.current);
    frame.current = null;
    reasonRef.current = 'doc';
    compute(live.current.query, drawnCurrentFrom(editor) ?? editor.prosemirrorState.selection.from);
  };

  /** Find again on the next frame, once, however many changes asked. */
  const schedule = (reason: 'query' | 'doc') => {
    if (reason === 'query') reasonRef.current = 'query';
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      if (!live.current.open) return;
      if (editor.prosemirrorView?.composing === true) {
        schedule('doc');
        return;
      }
      const why = reasonRef.current;
      reasonRef.current = 'doc';
      const anchor = drawnCurrentFrom(editor) ?? editor.prosemirrorState.selection.from;
      const next = compute(live.current.query, anchor);
      if (why === 'query') reveal(next.hits[next.current - 1]);
    });
  };

  const openBar = (withReplace: boolean) => {
    const state = live.current;
    const focusInside =
      findInput.current !== null &&
      findInput.current.closest('[role="search"]')?.contains(document.activeElement) === true;
    let q = state.query;
    if (!focusInside) {
      const selected = editor.getSelectedText();
      if (selected.length >= 1 && selected.length <= MAX_SEED && !/[\r\n]/.test(selected)) {
        q = selected;
      }
    }
    if (withReplace && !state.readOnly) setShowReplace(true);
    setOpen(true);
    setQuery(q);
    setStatus(null);
    setFocusTick((n) => n + 1);
    const anchor = state.open
      ? (drawnCurrentFrom(editor) ?? editor.prosemirrorState.selection.from)
      : editor.prosemirrorState.selection.from;
    const next = compute(q, anchor);
    reveal(next.hits[next.current - 1]);
  };

  const step = (by: 1 | -1) => {
    settle();
    const { hits: all, current: at } = live.current;
    if (all.length === 0) return;
    const to = nextIndex(at, all.length, by);
    setCurrent(to);
    live.current.current = to;
    showFindHits(editor, all, to);
    reveal(all[to - 1]);
  };

  const close = () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    setOpen(false);
    setFocusInBar(false);
    setStatus(null);
    setHits([]);
    setCurrent(0);
    clearFindHits(editor);
    editor.focus();
  };

  const replaceOne = () => {
    const { hits: drawn, current: at, query: q } = live.current;
    if (readOnly || drawn[at - 1] === undefined) return;
    // Found again on the page as it is now: an edit may have landed since the
    // last frame, and the drawn current hit has moved with it.
    const all = findHits(editor.prosemirrorState.doc, q, labelOf());
    const hit = all[firstAtOrAfter(all, drawnCurrentFrom(editor) ?? drawn[at - 1].from) - 1];
    if (hit === undefined || hit.inLink) return;
    if (hit.text !== replacement) applyReplacements(editor, [hit], replacement);
    const next = compute(q, hit.from + replacement.length);
    reveal(next.hits[next.current - 1]);
  };

  const replaceAll = () => {
    if (readOnly) return;
    const q = live.current.query;
    const plan = replacementPlan(findHits(editor.prosemirrorState.doc, q, labelOf()), replacement);
    applyReplacements(editor, plan.ranges, replacement);
    setStatus(replacedStatus(plan.ranges.length, plan.skippedLinks));
    compute(q, 0);
  };

  // The registry entry, and where this page last held focus.
  const act = useRef({ openBar, step });
  act.current = { openBar, step };
  useEffect(() => {
    const me: Registered = { host: () => host.current, lastFocusAt: 0 };
    bars.add(me);
    const el = host.current;
    const onFocusIn = () => {
      focusClock += 1;
      me.lastFocusAt = focusClock;
    };
    el?.addEventListener('focusin', onFocusIn);
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const find = !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f';
      // ⌥ changes `key` on a Mac keyboard; `code` names the physical key.
      const findReplace = !e.shiftKey && e.altKey && e.code === 'KeyF';
      const move = !e.altKey && e.key.toLowerCase() === 'g';
      if (!find && !findReplace && !move) return;
      if (targetBar() !== me) return;
      if (move) {
        if (!live.current.open) return;
        e.preventDefault();
        act.current.step(e.shiftKey ? -1 : 1);
        return;
      }
      e.preventDefault();
      act.current.openBar(findReplace);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      bars.delete(me);
      el?.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKey);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [host]);

  // Find again as the page changes, only while the bar is open.
  useEffect(() => {
    if (!open) return;
    return editor.onChange(() => schedule('doc'));
    // `schedule` reads everything through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editor]);

  // A renamed page renames its links' labels.
  useEffect(() => {
    if (live.current.open) schedule('doc');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, notePath]);

  useLayoutEffect(() => {
    if (focusTick === 0) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [focusTick]);

  if (!open) return null;

  const hit = hits[current - 1];
  const count =
    query === '' || foundFor !== query
      ? ''
      : hits.length === 0
        ? 'No matches'
        : `${current} of ${hits.length}${hit?.inLink === true ? ' · in a link' : ''}`;
  const replacing = showReplace && !readOnly;

  return (
    <div className="cb-find-row">
      <div
        role="search"
        aria-label="Find in page"
        data-testid="find-bar"
        className="cb-find-bar"
        onFocus={() => setFocusInBar(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusInBar(false);
        }}
      >
        {focusInBar && <EscapeWhileFocused onEscape={close} />}
        <div className="cb-find-line">
          {!readOnly && (
            <BarIcon
              icon={replacing ? 'chevron-down' : 'chevron-right'}
              label="Show replace"
              testId="find-toggle-replace"
              pressed={replacing}
              onClick={() => setShowReplace((v) => !v)}
            />
          )}
          <input
            ref={findInput}
            data-testid="find-input"
            className="cb-find-input"
            placeholder="Find in page"
            aria-label="Find in page"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              live.current.query = e.target.value;
              setStatus(null);
              schedule('query');
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }}
          />
          <span data-testid="find-count" className="cb-find-count" aria-live="polite">
            {count}
          </span>
          <BarIcon
            icon="chevron-up"
            label="Previous match"
            testId="find-prev"
            disabled={hits.length === 0}
            onClick={() => step(-1)}
          />
          <BarIcon
            icon="chevron-down"
            label="Next match"
            testId="find-next"
            disabled={hits.length === 0}
            onClick={() => step(1)}
          />
          <BarIcon icon="x" label="Close" testId="find-close" onClick={close} />
        </div>
        {replacing && (
          <div className="cb-find-line">
            <input
              data-testid="find-replace-input"
              className="cb-find-input"
              placeholder="Replace with"
              aria-label="Replace with"
              value={replacement}
              onChange={(e) => {
                setReplacement(e.target.value);
                setStatus(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) replaceAll();
                else replaceOne();
              }}
            />
            <Tooltip label={hit?.inLink === true ? 'Links keep their names' : ''}>
              <button
                type="button"
                data-testid="find-replace"
                className="cb-btn cb-btn-sm cb-btn-secondary"
                disabled={hit === undefined || hit.inLink}
                onClick={replaceOne}
              >
                Replace
              </button>
            </Tooltip>
            <Button
              size="sm"
              testId="find-replace-all"
              disabled={hits.length === 0}
              onClick={replaceAll}
            >
              Replace all
            </Button>
          </div>
        )}
        {status !== null && (
          <div data-testid="find-status" className="cb-find-status" role="status">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
