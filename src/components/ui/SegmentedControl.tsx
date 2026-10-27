import React from 'react';
import { Icon } from '@/components/ui/Icon';

/* The segment's own hover ink spends `--motion-hover` (M46.2). The SELECTED
 * segment's `--shadow-xs` lift is deliberately not transitioned: it is a
 * commit, it lands with a re-render rather than with the pointer, and a
 * fading shadow under a moving pill reads as a smear. What moves instead is
 * the pill itself (owner, 2026-10-19: "polish to the components"): once the
 * control has measured its segments, the lift is drawn by one pill behind
 * them that slides to the selected one on the turn pair, as macOS's and
 * Macro's tabs do, and the selected segment draws none of its own. */
const css = `
.cb-seg{position:relative;display:inline-flex;background:var(--n-100);border-radius:var(--r-md);padding:2px;gap:2px}
.cb-seg button{position:relative;font-family:var(--font-ui);font-size:var(--fs-xs);font-weight:500;color:var(--n-600);background:transparent;border:none;border-radius:var(--r-sm);height:24px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:background var(--motion-hover),color var(--motion-hover);outline:none;white-space:nowrap}
.cb-seg button:hover{color:var(--n-800)}
.cb-seg button:focus-visible{box-shadow:var(--ring)}
.cb-seg .cb-seg-on{background:var(--n-0);color:var(--n-900);box-shadow:var(--shadow-xs)}
.cb-seg-md button{height:28px;font-size:var(--fs-sm);padding:0 12px}
.cb-seg-pill{position:absolute;top:2px;bottom:2px;left:0;border-radius:var(--r-sm);background:var(--n-0);box-shadow:var(--shadow-xs);pointer-events:none;transition:translate var(--motion-turn),width var(--motion-turn)}
.cb-seg[data-pill] .cb-seg-on{background:transparent;box-shadow:none}
.cb-seg[data-pill] .cb-seg-on:focus-visible{box-shadow:var(--ring)}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-seg-css')) {
  const t = document.createElement('style');
  t.id = 'cb-seg-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Inline segmented control (2–5 options). */
export interface SegmentOption {
  value: string;
  label: string;
  icon?: string;
  /** forwarded as data-testid on the segment button (Task 24 smoke hooks) */
  testId?: string;
}
export interface SegmentedControlProps {
  options: SegmentOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** "sm" 28 total (default) | "md" 32 total */
  size?: 'sm' | 'md';
  /** names the tablist for screen readers, e.g. "View mode" */
  ariaLabel?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'sm',
  ariaLabel,
  style,
  className = '',
}: SegmentedControlProps) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);
  // Where the selected segment sits, once laid out: the pill slides there.
  // Unmeasured (jsdom, a hidden control) the segment draws its own lift.
  const [pill, setPill] = React.useState<{ left: number; width: number } | null>(null);
  React.useLayoutEffect(() => {
    const strip = ref.current;
    if (strip === null) return;
    const place = () => {
      const on = strip.querySelectorAll<HTMLElement>('button')[selectedIndex];
      const next =
        on === undefined || on.offsetWidth === 0
          ? null
          : { left: on.offsetLeft, width: on.offsetWidth };
      // Keep the selected tab visible when its containing strip becomes narrow.
      // Scroll only this horizontal strip; focus and the page's vertical position
      // remain with the person's current control.
      if (next !== null && strip.clientWidth > 0) {
        const left = next.left - 2;
        const right = next.left + next.width + 2;
        if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left);
        else if (right > strip.scrollLeft + strip.clientWidth)
          strip.scrollLeft = right - strip.clientWidth;
      }
      setPill((was) =>
        was !== null && next !== null && was.left === next.left && was.width === next.width
          ? was
          : next,
      );
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [selectedIndex, options.length, size]);
  // Roving tabindex: the strip is ONE tab stop and arrows move within it. Fall
  // back to the first option so the control stays reachable when `value`
  // matches nothing.
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const move = (next: number) => {
    if (options.length === 0) return;
    const i = ((next % options.length) + options.length) % options.length;
    if (onChange) onChange(options[i].value);
    // Selection follows focus, so the newly selected button is the tab stop.
    ref.current?.querySelectorAll('button')[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') return move(0);
    if (e.key === 'End') return move(options.length - 1);
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    move(focusIndex + delta);
  };

  return (
    <span
      ref={ref}
      className={`cb-seg ${size === 'md' ? 'cb-seg-md' : ''} ${className}`}
      style={style}
      role="tablist"
      aria-label={ariaLabel}
      data-pill={pill === null ? undefined : ''}
      onKeyDown={onKeyDown}
    >
      {pill !== null && (
        <span
          aria-hidden="true"
          className="cb-seg-pill"
          style={{ translate: `${pill.left}px 0`, width: pill.width }}
        />
      )}
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          tabIndex={i === focusIndex ? 0 : -1}
          data-testid={o.testId}
          className={o.value === value ? 'cb-seg-on' : ''}
          onClick={() => onChange && onChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </button>
      ))}
    </span>
  );
}
