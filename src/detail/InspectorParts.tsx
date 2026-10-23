import type { ReactNode } from 'react';
import { Suggestion } from '@/components/ai/Suggestion';
import { Icon } from '@/components/ui/Icon';
import { Keycaps } from '@/components/ui/Keycaps';
import './inspector.css';

/**
 * The inspector's small parts (owner, 2026-10-18): the pieces every Details
 * section is built from, so a section says what it holds in the panel's one
 * voice instead of its own. The record peek borrows them too. A page's facts
 * are a `dl.cb-inspector-facts` (inspector.css), not a part of their own.
 */

/** A group's label inside a section — "Speakers", "Related to this page" —
 *  one step quieter than the section's own label. */
export function InspectorSubhead({
  label,
  count,
  testId,
}: {
  label: string;
  /** Said beside the label: how many it holds. */
  count?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="cb-inspector-subhead" data-testid={testId}>
      <span>{label}</span>
      {count !== undefined && count !== null && (
        <span className="cb-inspector-subhead-count">{count}</span>
      )}
    </div>
  );
}

/**
 * An act, drawn as a row: icon, label and — for a keymap command — its keys.
 * A stack of them reads as a short menu; the outlined full-width buttons they
 * replace read as a form. The keys are decoration, hidden from the row's
 * accessible name, which stays its label.
 */
export function InspectorAction({
  icon,
  label,
  onClick,
  disabled = false,
  command,
  tone = 'default',
  title,
  testId,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A keymap command row whose keys this act also answers to. */
  command?: string;
  /** `primary` for the act its section exists for. An ask of the Assistant
   *  or of Knowledge is an `InspectorAsk`, whose glyph takes the AI's colour. */
  tone?: 'default' | 'primary';
  /** What the act does, when its label cannot say all of it. */
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="cb-inspector-action"
      data-tone={tone}
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="cb-inspector-action-icon" name={icon} size={14} />
      <span className="cb-inspector-action-label">{label}</span>
      {command !== undefined && (
        <span className="cb-inspector-action-keys" aria-hidden="true">
          <Keycaps command={command} />
        </span>
      )}
    </button>
  );
}

/**
 * An ask of the Assistant, drawn as an act row (M91.14): the Suggestion
 * element — one press hands the Assistant a prompt — in the inspector's
 * voice, its glyph in the AI's colour. The row says its label; what the
 * Assistant is sent is `prompt`, handed back to `onAsk` when pressed.
 */
export function InspectorAsk({
  icon,
  label,
  prompt,
  onAsk,
  disabled = false,
  title,
  testId,
}: {
  icon: string;
  /** The row's words, and its name. */
  label: string;
  /** What the Assistant is sent. */
  prompt: string;
  onAsk: (prompt: string) => void;
  disabled?: boolean;
  /** What the ask does, or why it waits, when its label cannot say it. */
  title?: string;
  testId?: string;
}) {
  return (
    <Suggestion
      suggestion={prompt}
      onClick={onAsk}
      icon={null}
      className="cb-inspector-action"
      data-tone="ai"
      data-testid={testId}
      title={title}
      disabled={disabled}
    >
      <Icon className="cb-inspector-action-icon" name={icon} size={14} />
      <span className="cb-inspector-action-label">{label}</span>
    </Suggestion>
  );
}

/** A stack of `InspectorAction` and `InspectorAsk` rows, aligned to the
 *  section's text edge. */
export function InspectorActions({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="cb-inspector-actions" role="group" aria-label={label}>
      {children}
    </div>
  );
}
