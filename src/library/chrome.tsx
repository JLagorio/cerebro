import type React from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * Form chrome for the library editors (M18).
 *
 * The three editors are the same document with different fields, so the labels,
 * help text and spacing live here once. Everything is a controlled input with an
 * explicit `<label>` — the old surface was a property table where the field name
 * and its meaning were the same three words, and these need a sentence.
 */

export function EditorSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-n-200 py-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="m-0 text-sm font-semibold text-n-900">{title}</h2>
        <span className="flex-1" />
        {action}
      </div>
      {hint !== undefined && (
        <p className="m-0 mb-3 max-w-[68ch] text-xs leading-[17px] text-n-500">{hint}</p>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** A labelled row. `hint` is the sentence that says what the value MEANS —
 * the thing a generic property editor structurally cannot tell you. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-n-700">
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <span className="max-w-[68ch] text-2xs leading-[15px] text-n-500">{hint}</span>
      )}
    </div>
  );
}

const INPUT =
  'w-full rounded-md border border-n-200 bg-n-0 px-2.5 py-1.5 text-sm text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400';

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <input
      id={id}
      data-testid={testId}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={INPUT}
    />
  );
}

/**
 * The instructions box.
 *
 * Monospace and tall on purpose: this is the one field that is PROSE THE MODEL
 * READS, and it is the whole substance of a skill. A four-line auto-growing
 * input would make the most important thing on the screen look like a caption.
 */
export function BodyField({
  id,
  value,
  onChange,
  rows = 16,
  placeholder,
  ariaLabel,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <textarea
      id={id}
      data-testid={testId}
      value={value}
      rows={rows}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-md border border-n-200 bg-n-0 p-3 font-mono text-xs leading-[19px] text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
    />
  );
}

/** A boundary the user is turning on, with the consequence stated beside it.
 * Used for the two places where declaring an EMPTY list is meaningful. */
export function GuardRow({
  label,
  hint,
  checked,
  onChange,
  tone = 'plain',
  children,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  tone?: 'plain' | 'warn';
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        tone === 'warn' && checked ? 'border-warn-300 bg-warn-50' : 'border-n-200 bg-n-0'
      }`}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 flex-none accent-[var(--cortex-500)]"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-n-800">{label}</span>
          <span className="mt-0.5 block max-w-[62ch] text-2xs leading-[15px] text-n-500">
            {hint}
          </span>
        </span>
      </label>
      {checked && children !== undefined && <div className="mt-2.5 pl-6">{children}</div>}
    </div>
  );
}

/** The one line of the file the editor cannot change, said plainly so the
 * files-first promise is visible rather than merely true. */
export function FileNote({ path }: { path: string }) {
  return (
    <p className="m-0 flex items-center gap-1.5 text-2xs text-n-400">
      <Icon name="file-text" size={11} color="var(--n-400)" />
      {path}
    </p>
  );
}
