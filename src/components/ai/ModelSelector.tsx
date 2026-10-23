// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { useMergedRefs } from './mergeRefs';
import './conversation.css';

/**
 * Which model runs a turn and how hard it thinks (M91.8, shadcn's Model
 * Selector). shadcn draws two menus that close on a pick; this is one
 * trigger and one panel holding the Model and Effort radio groups, which
 * stay open while the person picks both, and a free-text Other model — a
 * deliberate deviation the assistant's e2e pins (`run-options`,
 * `run-model-*`, `run-effort-*`, the "Model and effort: …" name).
 *
 * Open state is the caller's, so another surface (a failure card's "Choose
 * another model") can open it. The panel is a Popover: it owns Escape and
 * click-away through the layer stack, holds Tab while open and hands focus
 * back on close. Picks are native radios: arrows move through a group, and
 * Tab moves between the groups.
 */

/** One choice in a group. */
export interface ModelSelectorChoice {
  /** What `onValueChange` hears. */
  value: string;
  label: string;
  /** A test hook for the row: `run-model-opus`. */
  testId?: string;
}

export interface ModelSelectorOtherProps {
  /** What the field starts holding: the model in use, when it is not one of
   *  the choices. */
  defaultValue?: string;
  /** Why a name cannot be used, or null when it can. */
  validate?: (name: string) => string | null;
  /** Uses the typed name. It arrives trimmed and valid. */
  onUse: (name: string) => void;
  /** The field's name. */
  label?: string;
  placeholder?: string;
  testId?: string;
  useTestId?: string;
}

export interface ModelSelectorGroupProps {
  /** The group's heading and its radio group's name: "Model", "Effort". */
  label: string;
  choices: readonly ModelSelectorChoice[];
  /** The picked choice's value, or null when none of them is picked. */
  value: string | null;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /** What follows the choices inside the group: Other. */
  children?: ReactNode;
}

/** One radio group under its heading, and what follows it. */
export function ModelSelectorGroup({
  label,
  choices,
  value,
  onValueChange,
  disabled,
  children,
}: ModelSelectorGroupProps) {
  const id = useId();
  return (
    <div data-slot="model-selector-group" className="cb-ai-model-selector-group">
      <div id={`${id}-heading`} className="cb-ai-model-selector-heading">
        {label}
      </div>
      <div role="radiogroup" aria-labelledby={`${id}-heading`}>
        {choices.map((choice) => (
          <ModelSelectorItem
            key={choice.value}
            name={id}
            choice={choice}
            checked={value === choice.value}
            disabled={disabled}
            onPick={onValueChange}
          />
        ))}
      </div>
      {children}
    </div>
  );
}

interface ModelSelectorItemProps {
  /** The radio group's form name. */
  name: string;
  choice: ModelSelectorChoice;
  checked: boolean;
  disabled?: boolean;
  onPick: (value: string) => void;
}

/** A choice: a label over its radio, so a press anywhere on the row picks. */
export function ModelSelectorItem({
  name,
  choice,
  checked,
  disabled,
  onPick,
}: ModelSelectorItemProps) {
  return (
    <label
      data-slot="model-selector-item"
      data-testid={choice.testId}
      data-checked={checked ? '' : undefined}
      className="cb-ai-model-selector-item"
    >
      <input
        type="radio"
        // WebKit reaches a radio by Tab only with an explicit tabIndex.
        tabIndex={0}
        name={name}
        value={choice.value}
        checked={checked}
        disabled={disabled}
        onChange={() => onPick(choice.value)}
      />
      <span className="cb-ai-model-selector-item-label">{choice.label}</span>
      {checked && <Icon name="check" size={11} />}
    </label>
  );
}

/**
 * A model by its full name. Enter in the field uses it as Use does; neither
 * is a form submit, so nothing around the panel can catch one. A name the
 * caller refuses says why under the field.
 */
export function ModelSelectorInput({
  defaultValue = '',
  validate,
  onUse,
  label = 'Other model',
  placeholder = 'Other: a full model name',
  testId,
  useTestId,
}: ModelSelectorOtherProps) {
  const id = useId();
  const [text, setText] = useState(defaultValue);
  const name = text.trim();
  const refusal = name === '' ? null : (validate?.(name) ?? null);
  const usable = name !== '' && refusal === null;
  const use = () => {
    if (usable) onUse(name);
  };
  return (
    <>
      <div data-slot="model-selector-other" className="cb-ai-model-selector-other">
        <input
          type="text"
          data-testid={testId}
          aria-label={label}
          aria-invalid={refusal === null ? undefined : true}
          aria-describedby={refusal === null ? undefined : `${id}-refusal`}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            use();
          }}
          className="cb-ai-model-selector-other-input"
        />
        <button
          type="button"
          data-testid={useTestId}
          // WebKit reaches a button by Tab only with an explicit tabIndex.
          tabIndex={0}
          disabled={!usable}
          onClick={use}
          className="cb-ai-model-selector-use"
        >
          Use
        </button>
      </div>
      {refusal !== null && (
        <p id={`${id}-refusal`} className="cb-ai-model-selector-refusal">
          {refusal}
        </p>
      )}
    </>
  );
}

/** The words before the pick in the trigger's name, and the panel's name. */
export const MODEL_SELECTOR_NAME = 'Model and effort';

export type ModelSelectorProps = Omit<ComponentProps<'button'>, 'value' | 'onChange'> & {
  /** The pick in words, which the trigger shows and its name carries:
   *  "Opus · High", "Claude Code default". */
  label: string;
  models: readonly ModelSelectorChoice[];
  /** The picked model's value, or null when it is an Other name. */
  model: string | null;
  onModelChange: (value: string) => void;
  efforts: readonly ModelSelectorChoice[];
  effort: string | null;
  onEffortChange: (value: string) => void;
  /** The free-text model under the Model group. */
  other?: ModelSelectorOtherProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `icon` shows only the glyph: the name still carries the pick. */
  appearance?: 'label' | 'icon';
  /** A line above the groups, such as which model last answered. */
  note?: ReactNode;
  testId?: string;
};

export function ModelSelector({
  label,
  models,
  model,
  onModelChange,
  efforts,
  effort,
  onEffortChange,
  other,
  open,
  onOpenChange,
  appearance = 'label',
  note,
  testId,
  disabled,
  onClick,
  className,
  ref,
  ...props
}: ModelSelectorProps) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const attach = useMergedRefs(trigger, ref);
  const name = `${MODEL_SELECTOR_NAME}: ${label}`;
  return (
    <>
      <button
        type="button"
        data-slot="model-selector-trigger"
        {...props}
        ref={attach}
        data-testid={testId}
        data-appearance={appearance}
        aria-label={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={appearance === 'icon' ? name : undefined}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          // WebKit does not focus a pressed button: focus it, so closing
          // the panel hands focus back here.
          event.currentTarget.focus();
          onOpenChange(!open);
        }}
        className={['cb-ai-model-selector-trigger', className].filter(Boolean).join(' ')}
      >
        <Icon name="cpu" size={appearance === 'icon' ? 17 : 11} />
        {appearance === 'label' && <span className="cb-ai-model-selector-label">{label}</span>}
      </button>
      {open && (
        <Popover
          anchorRef={trigger}
          onClose={() => onOpenChange(false)}
          role="dialog"
          ariaLabel={MODEL_SELECTOR_NAME}
          trapFocus
          className="cb-ai-model-selector"
        >
          {note !== undefined && <div className="cb-ai-model-selector-note">{note}</div>}
          <ModelSelectorGroup
            label="Model"
            choices={models}
            value={model}
            onValueChange={onModelChange}
          >
            {other !== undefined && <ModelSelectorInput {...other} />}
          </ModelSelectorGroup>
          <ModelSelectorGroup
            label="Effort"
            choices={efforts}
            value={effort}
            onValueChange={onEffortChange}
          />
        </Popover>
      )}
    </>
  );
}
