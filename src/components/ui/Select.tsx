import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import './select.css';

/**
 * The design system's select, and the only one: no native `<select>` draws
 * anywhere in the app (owner, 2026-10-18). A native popup cannot carry the
 * design system's type, icons or check marks, and it looks like a different
 * program in each theme and on each OS.
 *
 * A listbox button (the M2 `Dropdown` pattern, which now renders this): the
 * trigger names the current value, and the options open in a `Popover` —
 * portalled, so a scrolling ancestor never clips them, and flipped up near
 * the window's foot. While it is open the LIST holds focus and names its
 * highlighted row with `aria-activedescendant` (M16.35), as the collapsible
 * listbox pattern does: a button cannot carry an active descendant, so with
 * focus left on the trigger a screen reader heard none of the rows. Closing
 * returns focus to the trigger; Tab moves on from it.
 *
 * The keyboard is a native select's: arrows, Home and End, Page Up and Page
 * Down, Enter or Space to pick, and typing a name. Escape belongs to the
 * Popover's layer. Typing on a CLOSED trigger opens the list at the match
 * instead of changing the value, because several hosts write the moment the
 * value changes, and a stray keystroke must not.
 *
 * `searchable` makes it a combobox, for a list long enough to hunt through
 * (a vault's types): a search field sits at the top of the open list and
 * takes focus in the list's place, as the combobox naming the highlighted
 * row. Typing filters the rows, best match first; the arrows, Page Up and
 * Page Down walk what is left, Enter picks, and Home, End and Space stay the
 * field's. A key typed on the closed trigger opens the list with it searched.
 */
export interface SelectOption {
  value: string;
  label: string;
  /** A lucide icon before the label, drawn on the trigger too. */
  icon?: string;
  /** The icon's colour, in the list and on the trigger: a type's own. */
  color?: string;
  /** Listed, never picked: skipped by the keyboard and the pointer. */
  disabled?: boolean;
  /** Right-aligned secondary text in the list. */
  hint?: string;
}

export interface SelectProps {
  options: readonly SelectOption[];
  value: string;
  /** Called with the picked value, and only when it differs from `value`. */
  onChange: (value: string) => void;
  /**
   * Accessible name, for a select with no `<label htmlFor>` naming it — a
   * filter, or a clause in a sentence. Named `ariaLabel` like every control
   * here: `aria-label` written on a component is silently dropped, because
   * JSX skips excess-property checks for hyphenated attribute names.
   */
  ariaLabel?: string;
  /** The id of the element that names it, when a label sits elsewhere. */
  labelledBy?: string;
  /** The trigger's id, for a `<label htmlFor>`. */
  id?: string;
  /** "sm" 28 | "md" 32 (default) */
  size?: 'sm' | 'md';
  /** `ghost` draws no border until the pointer finds it: property values,
   *  the inspector, toolbars. */
  variant?: 'outline' | 'ghost';
  width?: number | string;
  disabled?: boolean;
  /** Shown, muted, while `value` matches no option. */
  placeholder?: string;
  /** A search field at the top of the list filters it (a combobox). */
  searchable?: boolean;
  /** The search field's placeholder. */
  searchPlaceholder?: string;
  invalid?: boolean;
  className?: string;
  style?: React.CSSProperties;
  testId?: string;
}

/** How long a typed prefix lives before the next key starts a new one. */
const TYPEAHEAD_MS = 700;
const PAGE = 10;
/** A searchable list's least width: a vault's longest type names whole,
 *  and room to type over them. */
const SEARCH_MIN_WIDTH = 240;

/** How well an option answers a search: the start of its label, the start
 *  of a word in it, anywhere in it, then its hint. -1 when it does not. */
function rank(option: SelectOption, needle: string): number {
  const label = option.label.toLocaleLowerCase();
  if (label.startsWith(needle)) return 0;
  if (label.split(/\s+/).some((word) => word.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  return option.hint?.toLocaleLowerCase().includes(needle) === true ? 3 : -1;
}

/** The options a search shows, as indices into `options`: all of them, in
 *  order, for no search; otherwise the matches, best first and in order
 *  within a rank. */
function shownFor(options: readonly SelectOption[], needle: string): number[] {
  const all = options.map((_, i) => i);
  if (needle === '') return all;
  return all
    .map((i) => ({ i, r: rank(options[i], needle) }))
    .filter(({ r }) => r !== -1)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ i }) => i);
}

const needleOf = (text: string) => text.trim().toLocaleLowerCase();

export function Select({
  options,
  value,
  onChange,
  ariaLabel,
  labelledBy,
  id,
  size = 'md',
  variant = 'outline',
  width,
  disabled = false,
  placeholder,
  searchable = false,
  searchPlaceholder = 'Search…',
  invalid = false,
  className = '',
  style,
  testId,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [search, setSearch] = useState('');
  // The trigger's width when the list opened: the list is at least as wide
  // as the button and grows for a long option.
  const [minWidth, setMinWidth] = useState<number>();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<number, HTMLElement>());
  const typed = useRef({ text: '', at: 0 });
  // Where the pointer last really moved. A list scrolled under a resting
  // pointer (typeahead, Page Down) gets synthetic mouse events at the SAME
  // coordinates, and those must not move the highlight: typing "ru" would
  // otherwise land on whatever row slid under the pointer, and Enter pick it.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const listId = useId();
  const valueId = `${listId}-value`;
  const triggerId = id ?? `${listId}-trigger`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchId = `${listId}-search`;
  const optionId = (i: number) => `${listId}-option-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex === -1 ? null : options[selectedIndex];
  const enabled = (i: number) => options[i] !== undefined && options[i].disabled !== true;
  // The rows the list draws, as indices into `options`; the keyboard walks
  // their positions. Closed, or with nothing searched, that is every option.
  const shown = shownFor(options, searchable && open ? needleOf(search) : '');
  const at = shown.indexOf(active);

  /** The nearest pickable row from position `from` of `rows`, stepping by
   *  `step`; `from` itself counts. */
  const nearest = (from: number, step: 1 | -1, rows = shown): number => {
    for (let p = from; p >= 0 && p < rows.length; p += step) if (enabled(rows[p])) return rows[p];
    return -1;
  };
  const first = (rows = shown) => nearest(0, 1, rows);
  const last = () => nearest(shown.length - 1, -1);

  const openAt = (index: number, text = '') => {
    pointer.current = null;
    setActive(index);
    setSearch(text);
    setMinWidth(anchorRef.current?.getBoundingClientRect().width);
    setOpen(true);
  };
  const openMenu = () => openAt(enabled(selectedIndex) ? selectedIndex : first());
  const close = () => setOpen(false);
  const pick = (index: number) => {
    const option = options[index];
    if (option === undefined || option.disabled === true) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };
  /** A new search is a new list: its best row is highlighted, or with the
   *  search emptied, the current value again. */
  const searchFor = (text: string) => {
    setSearch(text);
    const needle = needleOf(text);
    setActive(
      needle === '' && enabled(selectedIndex) ? selectedIndex : first(shownFor(options, needle)),
    );
  };

  // The highlighted row is kept in view by scrolling the LIST alone. Not
  // `scrollIntoView`: that also scrolls every scrolling ancestor, and a page
  // scroll is what the Popover closes on — the list would shut as it opened.
  useEffect(() => {
    const list = listRef.current;
    const row = active < 0 ? undefined : optionRefs.current.get(active);
    if (!open || list === null || row === undefined) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
    // A search re-lays the rows under a highlight that may not have moved.
  }, [open, active, search]);

  // The open list takes focus, or its search field does, once the Popover
  // has placed it: it renders hidden for its first frame, and a hidden
  // element cannot be focused.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let tries = 0;
    const take = () => {
      const target = document.getElementById(searchable ? searchId : listId);
      if (target === null) return;
      if (document.activeElement !== target) {
        target.focus({ preventScroll: true });
        // A key typed on the trigger seeded the search: typing goes on after it.
        if (target instanceof HTMLInputElement && document.activeElement === target) {
          target.setSelectionRange(target.value.length, target.value.length);
        }
      }
      if (document.activeElement !== target && tries < 10) {
        tries += 1;
        frame = requestAnimationFrame(take);
      }
    };
    take();
    return () => cancelAnimationFrame(frame);
  }, [open, listId, searchId, searchable]);

  /** The row a typed prefix lands on, cycling past the current row when the
   *  same letter is pressed again — a native select's typeahead. */
  const typeahead = (key: string, from: number): number => {
    const now = Date.now();
    const buffer = typed.current;
    buffer.text = now - buffer.at > TYPEAHEAD_MS ? key : buffer.text + key;
    buffer.at = now;
    const needle = buffer.text.toLocaleLowerCase();
    const repeat = [...needle].every((c) => c === needle[0]);
    const prefix = repeat ? needle[0] : needle;
    const start = repeat ? from + 1 : Math.max(from, 0);
    for (let k = 0; k < options.length; k += 1) {
      const i = (start + k + options.length) % options.length;
      if (enabled(i) && options[i].label.toLocaleLowerCase().startsWith(prefix)) return i;
    }
    return -1;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    // A key that is composing a character belongs to the input method.
    if (e.nativeEvent.isComposing) return;
    const modified = e.metaKey || e.ctrlKey || e.altKey;
    const printable = e.key.length === 1 && e.key !== ' ' && !modified;
    // Keys from the search field: its own text editing stays its own.
    const inSearch = searchable && e.target === searchRef.current;
    if (!open) {
      // A chord on a closed trigger is the app's: ⌘Enter in a form submits
      // it, and must not open the list as well. On an OPEN list, ⌘Enter picks
      // the highlighted row and goes on to the form, which submits that.
      if (modified) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      } else if (printable && searchable) {
        e.preventDefault();
        openAt(first(shownFor(options, needleOf(e.key))), e.key);
      } else if (printable) {
        const hit = typeahead(e.key, selectedIndex);
        if (hit !== -1) {
          e.preventDefault();
          openAt(hit);
        }
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        // Belt only: the Popover's layer takes Escape before React sees it.
        // This branch serves an event dispatched at the element itself.
        e.stopPropagation();
        close();
        return;
      case 'ArrowDown': {
        e.preventDefault();
        const next = nearest(at + 1, 1);
        if (next !== -1) setActive(next);
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = at <= 0 ? first() : nearest(at - 1, -1);
        if (prev !== -1) setActive(prev);
        return;
      }
      case 'PageDown': {
        e.preventDefault();
        const next = nearest(Math.min(at + PAGE, shown.length - 1), -1);
        setActive(next !== -1 && shown.indexOf(next) > at ? next : last());
        return;
      }
      case 'PageUp': {
        e.preventDefault();
        const prev = nearest(Math.max(at - PAGE, 0), 1);
        setActive(prev !== -1 && shown.indexOf(prev) < at ? prev : first());
        return;
      }
      case 'Home':
      case 'End':
        // In the search field they move the caret, as in any text field.
        if (inSearch) return;
        e.preventDefault();
        setActive(e.key === 'Home' ? first() : last());
        return;
      case ' ':
        // A space is part of a search.
        if (inSearch) return;
        e.preventDefault();
        pick(active);
        return;
      case 'Enter':
        e.preventDefault();
        pick(active);
        return;
      case 'Tab':
        // Back to the trigger before the browser moves focus, so Tab goes on
        // from the select rather than from the list at the end of the page.
        triggerRef.current?.focus({ preventScroll: true });
        close();
        return;
      default: {
        if (!printable || inSearch) return;
        if (searchable) {
          // Typed before the field took focus, or while the trigger holds
          // it: the search is given it all the same.
          e.preventDefault();
          searchFor(search + e.key);
          searchRef.current?.focus({ preventScroll: true });
          return;
        }
        const hit = typeahead(e.key, active);
        if (hit !== -1) {
          e.preventDefault();
          setActive(hit);
        }
      }
    }
  };

  const optionRows = shown.map((i) => {
    const o = options[i];
    return (
      <div
        key={`${o.value}:${i}`}
        ref={(el) => {
          if (el === null) optionRefs.current.delete(i);
          else optionRefs.current.set(i, el);
        }}
        id={optionId(i)}
        role="option"
        aria-selected={o.value === value}
        aria-disabled={o.disabled === true || undefined}
        data-value={o.value}
        data-active={i === active || undefined}
        className="cb-select-option"
        // The list, or its search field, keeps focus: a press on a row must
        // not take it.
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={(e) => {
          const last = pointer.current;
          if (last !== null && last.x === e.clientX && last.y === e.clientY) return;
          pointer.current = { x: e.clientX, y: e.clientY };
          if (enabled(i) && i !== active) setActive(i);
        }}
        onClick={() => pick(i)}
      >
        {o.icon !== undefined && (
          <Icon className="cb-select-icon" name={o.icon} size={13} color={o.color} />
        )}
        <span className="cb-select-option-label">{o.label}</span>
        {o.hint !== undefined && <span className="cb-select-option-hint">{o.hint}</span>}
        {o.value === value && <Icon className="cb-select-check" name="check" size={14} />}
      </div>
    );
  });
  // A select named by a label names its list the same way.
  const listName = {
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabel === undefined ? (labelledBy ?? triggerId) : undefined,
  };
  // A searchable list is at least SEARCH_MIN_WIDTH wide, never narrower than
  // its trigger.
  const floor = searchable ? Math.max(SEARCH_MIN_WIDTH, minWidth ?? 0) : minWidth;

  return (
    <span
      ref={anchorRef}
      className={`cb-select cb-select-${size} cb-select-${variant} ${className}`}
      style={{ width, ...style }}
      // Its unmodified keys are its own, as a native select's were: the
      // keymap's j/k, Enter, Space, arrows and chords stand down while the
      // trigger has focus (M65.1 claims), and ⌘-chords still reach the app.
      data-key-claim="typing"
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        data-testid={testId}
        data-value={value}
        data-state={open ? 'open' : 'closed'}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        // Named by its label, it still says its value, as a native select
        // does; named by its value alone, it needs nothing more.
        aria-describedby={
          ariaLabel !== undefined || labelledBy !== undefined || id !== undefined
            ? valueId
            : undefined
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        // WebKit (and so the macOS app's WKWebView) never focuses a button
        // it presses, and its mousedown takes back any focus given during
        // the press — so the trigger takes focus on the click, before the
        // list mounts (the Popover returns focus to whatever held it then).
        onClick={(e) => {
          if (document.activeElement !== e.currentTarget) {
            e.currentTarget.focus({ preventScroll: true });
          }
          if (open) close();
          else openMenu();
        }}
        className="cb-select-trigger"
      >
        {selected?.icon !== undefined && (
          <Icon className="cb-select-icon" name={selected.icon} size={13} color={selected.color} />
        )}
        {selected !== null ? (
          <span id={valueId} className="cb-select-value">
            {selected.label}
          </span>
        ) : (
          <span id={valueId} className="cb-select-value cb-select-placeholder">
            {placeholder ?? ''}
          </span>
        )}
        <Icon className="cb-select-chevron" name="chevron-down" size={14} />
      </button>
      {open && !searchable && (
        <Popover
          anchorRef={anchorRef}
          onClose={close}
          role="listbox"
          ariaLabel={listName['aria-label']}
          ariaLabelledBy={listName['aria-labelledby']}
          keyClaim="typing"
          id={listId}
          activeDescendant={active < 0 ? undefined : optionId(active)}
          className={`cb-select-list cb-select-${size}-list`}
        >
          {/* As wide as the trigger at least, and at most the wider of the
              trigger and 360px: a full-width select in a dialog lists its
              rows inside its own panel, and a narrow one's long option
              truncates rather than spanning the window. */}
          <div
            ref={listRef}
            className="cb-select-options"
            style={{ minWidth, maxWidth: Math.max(360, minWidth ?? 0) }}
          >
            {optionRows}
          </div>
        </Popover>
      )}
      {open && searchable && (
        <Popover
          anchorRef={anchorRef}
          onClose={close}
          keyClaim="typing"
          className={`cb-select-list cb-select-${size}-list cb-select-searchable`}
        >
          {/* A press anywhere here but the field, the list's padding and the
              gaps between rows included, leaves focus in the field. */}
          <div
            className="cb-select-combo"
            style={{ minWidth: floor, maxWidth: Math.max(360, floor ?? 0) }}
            onMouseDown={(e) => {
              if (e.target !== searchRef.current) e.preventDefault();
            }}
          >
            <div className="cb-select-search">
              <Icon className="cb-select-search-icon" name="search" size={14} />
              <input
                ref={searchRef}
                id={searchId}
                type="text"
                role="combobox"
                className="cb-select-search-input"
                value={search}
                placeholder={searchPlaceholder}
                {...listName}
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={at < 0 ? undefined : optionId(active)}
                aria-autocomplete="list"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => searchFor(e.target.value)}
              />
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              {...listName}
              className="cb-select-options"
            >
              {optionRows}
            </div>
            {shown.length === 0 && (
              <div className="cb-select-empty" role="status">
                No matches
              </div>
            )}
          </div>
        </Popover>
      )}
    </span>
  );
}
