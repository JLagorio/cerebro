import React, { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Tooltip } from '@/components/ui/Tooltip';
import { CREATABLE_PROPERTY_KINDS } from '@/engine/properties';
import { typeStyle } from '@/engine/typeCatalog';
import type { FieldKind } from '@/engine/types';
import { useSchema } from '@/stores/vaultStore';
import { Popover, useDismiss } from '@/components/ui/Popover';

/** "Select", then "Select 2", "Select 3"… — kind-first adds must not collide
 * with a property that already exists (M3.1: a second Select silently failed
 * with "Property already exists"). */
function uniqueName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i += 1) {
    if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }
  return base;
}

/** Relation creation config (M12.4): every relation names its data source. */
export interface RelationConfig {
  target: string;
  limit?: 1;
  /** Name of the derived reciprocal to declare on the target type; absent
   * means one-way. */
  reciprocalName?: string;
}

/** The shared chrome for the inline variant, which is its own layer. Split
 * into a component so neither variant calls a hook conditionally — and so the
 * anchored one does NOT register a layer inside its own Popover, where child
 * effects run first and the Popover would end up on top of its own content. */
function InlineSurface({
  onClose,
  onEscape,
  testId,
  children,
}: {
  onClose: () => void;
  onEscape: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss({ onClose, surfaceRef: ref, onEscape });
  return (
    <div
      ref={ref}
      data-testid={testId}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--n-200)] p-1.5"
    >
      {children}
    </div>
  );
}

export interface AddPropertyPanelProps {
  /** Names already on this type/record, so kind-first defaults stay unique
   * AND a collision is refused before the write rather than after it. */
  existingNames?: string[];
  /** The type this property is being declared on — seeds the reciprocal's
   * default name; null on untyped docs (relation config hidden there). */
  ownerType?: string | null;
  /** Called with the raw typed name and picked kind; close on success. */
  onAdd: (name: string, kind: FieldKind, relation?: RelationConfig) => void;
  onCancel: () => void;
  /**
   * Anchor it to the "+ Add property" trigger, which is Notion's shape and
   * the detail panels' (M16.9). Omitted by the view settings panel, where
   * this is a PAGE inside a popover that already exists — nesting a second
   * anchored surface there would point at the trigger of the first.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

/**
 * The "+ Add property" surface (M2.x, extracted M3, rebuilt M16.9).
 *
 * It was an inline bordered `<div>` that pushed the whole panel down as it
 * opened, with a 14-item scroller, no search, no way out but a Cancel button,
 * and the two dismissal bugs M16.1 fixed. Notion's is a popover anchored to
 * the trigger with a searchable type list and no OK/Cancel at all — picking a
 * type IS the commit.
 *
 * Three things here are ours and stay: kind-first naming (`uniqueName`), the
 * enforced relation-config step (M12.4 — a relation without a data source
 * accepts anything), and kind gating on untyped docs, which have no schema to
 * declare a kind on.
 */
export function AddPropertyPanel({
  existingNames = [],
  ownerType = null,
  onAdd,
  onCancel,
  anchorRef,
}: AddPropertyPanelProps) {
  const schema = useSchema();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<'catalog' | 'relation'>('catalog');
  /** Which kind the config step is configuring. `person` is a relation that
   * renders avatars (M16.13b) and needs a data source for the same reason —
   * before this it silently picked whatever type was named "Person". */
  const [configKind, setConfigKind] = useState<'relation' | 'person'>('relation');
  const [target, setTarget] = useState<string | null>(null);
  const [single, setSingle] = useState(false);
  const [twoWay, setTwoWay] = useState(false);
  const [reciprocal, setReciprocal] = useState('');

  const targets = [...schema.types.keys()].filter((t) => t !== 'Type').sort();

  // The guard `DocProperties` had and `RecordProperties` did not. Doing it
  // here means both callers get it, before the write rather than as a toast
  // afterwards — and it catches a declared field the open record happens to
  // leave empty, which `addPropertyToEntry`'s frontmatter-key check cannot see.
  const taken = useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase())),
    [existingNames],
  );
  const typed = name.trim();
  const duplicate = typed !== '' && taken.has(typed.toLowerCase());

  /** An untyped doc has no schema to declare a kind on: addPropertyToEntry
   * writes plain frontmatter and the Info panel renders every loose key
   * through a text input. Picking "Checkbox" there produced a text box
   * containing "false", so the catalog offers only what actually survives. */
  const supportedOnOwner = (kind: FieldKind) =>
    ownerType !== null ||
    kind === 'text' ||
    kind === 'number' ||
    kind === 'url' ||
    kind === 'email' ||
    kind === 'phone';

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return CREATABLE_PROPERTY_KINDS;
    return CREATABLE_PROPERTY_KINDS.filter(
      (k) => k.label.toLowerCase().includes(q) || k.kind.includes(q),
    );
  }, [query]);

  const pick = (kind: FieldKind, label: string) => {
    if (!supportedOnOwner(kind) || duplicate) return;
    // A relation on a TYPE gets the enforced-config step. On an untyped doc
    // there is no schema to write, so it stays a plain frontmatter key.
    if ((kind === 'relation' || kind === 'person') && ownerType !== null) {
      setConfigKind(kind);
      setTarget(null);
      setStep('relation');
      return;
    }
    onAdd(typed === '' ? uniqueName(label, existingNames) : name, kind);
  };

  const isPerson = configKind === 'person';

  const addRelation = () => {
    if (duplicate) return;
    // A relation must name its data source; a person field may decline to,
    // and falls back to the vault's people types at read time
    // (`personCandidates`). Enforcing it would be worse than the old
    // hardcoded guess for a vault that has no people type yet.
    if (target === null) {
      if (!isPerson) return;
      onAdd(typed === '' ? uniqueName('Person', existingNames) : name, 'person');
      return;
    }
    const finalName = typed === '' ? uniqueName(target, existingNames) : name;
    onAdd(finalName, configKind, {
      target,
      ...(single ? { limit: 1 as const } : {}),
      ...(twoWay
        ? {
            reciprocalName:
              reciprocal.trim() !== ''
                ? reciprocal
                : `related ${(ownerType ?? 'records').toLowerCase()}`,
          }
        : {}),
    });
  };

  // Escape steps back out of the relation config rather than discarding the
  // target/limit/two-way choices made there; a press outside the surface
  // still means "I am done here".
  const onEscape = step === 'relation' ? () => setStep('catalog') : onCancel;

  const duplicateNote = duplicate ? (
    <p
      role="alert"
      className="m-0 px-1.5 pt-0.5 text-[11px] leading-[1.35] text-[var(--danger-600)]"
    >
      “{typed}” is already a property here.
    </p>
  ) : null;

  const relationBody = (
    <>
      <Input
        autoFocus
        ariaLabel="Property name"
        placeholder={
          target !== null
            ? isPerson
              ? String(target)
              : `Related ${target}`
            : isPerson
              ? 'Person name'
              : 'Relation name'
        }
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="min-w-0"
        width="100%"
      />
      {duplicateNote}
      <span className="px-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
        {isPerson ? 'People come from' : 'Related to'}
      </span>
      <div className="max-h-[160px] overflow-y-auto">
        {isPerson && (
          <button
            type="button"
            role="option"
            aria-selected={target === null}
            data-testid="relation-target-any"
            onClick={() => setTarget(null)}
            className={[
              'flex w-full items-center gap-2 rounded-md border-0 px-1.5 py-[5px] text-left text-[12.5px]',
              target === null
                ? 'bg-[var(--cortex-50)] text-[var(--n-900)]'
                : 'bg-transparent text-[var(--n-800)] hover:bg-[var(--n-50)]',
            ].join(' ')}
          >
            <Icon name="users" size={13} color="var(--n-500)" />
            <span className="min-w-0 flex-1 truncate">Whoever this vault calls people</span>
            {target === null && <Icon name="check" size={13} color="var(--cortex-600)" />}
          </button>
        )}
        {targets.map((t) => {
          const style = typeStyle(t, schema);
          return (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={target === t}
              data-testid={`relation-target-${t}`}
              onClick={() => setTarget(t)}
              className={[
                'flex w-full items-center gap-2 rounded-md border-0 px-1.5 py-[5px] text-left text-[12.5px]',
                target === t
                  ? 'bg-[var(--cortex-50)] text-[var(--n-900)]'
                  : 'bg-transparent text-[var(--n-800)] hover:bg-[var(--n-50)]',
              ].join(' ')}
            >
              <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-500)'} />
              <span className="min-w-0 flex-1 truncate">{t}</span>
              {target === t && <Icon name="check" size={13} color="var(--cortex-600)" />}
            </button>
          );
        })}
        {targets.length === 0 && !isPerson && (
          <p className="m-0 px-1.5 py-2 text-[12px] text-[var(--n-500)]">
            No types to relate to yet — create one first.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between px-1 py-0.5">
        <span className="text-[12px] text-[var(--n-600)]">
          Limit to 1 {isPerson ? 'person' : 'record'}
        </span>
        <Switch ariaLabel="Limit to 1 record" checked={single} onChange={setSingle} />
      </div>
      <div className="flex items-center justify-between px-1 py-0.5">
        <span className="text-[12px] text-[var(--n-600)]">Add related property</span>
        <Switch
          ariaLabel="Add related property"
          checked={twoWay}
          onChange={setTwoWay}
          disabled={target === null}
        />
      </div>
      {twoWay && target !== null && (
        <Input
          ariaLabel="Related property name"
          placeholder={`Related ${(ownerType ?? 'records').toLowerCase()}`}
          value={reciprocal}
          onChange={(e) => setReciprocal(e.target.value)}
          className="min-w-0"
          width="100%"
        />
      )}
      <button
        type="button"
        data-testid="add-relation"
        disabled={(target === null && !isPerson) || duplicate}
        onClick={addRelation}
        // text-[var(--n-0)], never text-white: index.css resets the stock
        // palette with `--color-*: initial` inside @theme inline, so
        // `text-white` emits no CSS at all and the label inherited --n-900
        // on the blue fill (2.34:1 — the button read as disabled).
        className="mt-0.5 rounded-md border-0 bg-[var(--cortex-600)] px-2 py-1.5 text-[12.5px] font-medium text-[var(--n-0)] hover:bg-[var(--cortex-700)] disabled:cursor-default disabled:opacity-40"
      >
        {isPerson ? 'Add person' : 'Add relation'}
      </button>
      <button
        type="button"
        onClick={() => setStep('catalog')}
        className="self-start rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--n-400)] hover:text-[var(--n-700)]"
      >
        Back
      </button>
    </>
  );

  const catalogBody = (
    <>
      <Input
        autoFocus
        ariaLabel="Property name"
        placeholder="Property name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && typed !== '' && !duplicate) onAdd(name, 'text');
          // Escape belongs to the whole surface, not to whichever input
          // happens to hold focus (M16.1).
        }}
        className="min-w-0"
        width="100%"
      />
      {duplicateNote}
      <span className="px-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
        Type
      </span>
      <Input
        size="sm"
        ariaLabel="Search property types"
        placeholder="Search for a type…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter takes the first match, so a search can be finished without
          // reaching for the pointer.
          const first = matches.find((k) => supportedOnOwner(k.kind));
          if (e.key === 'Enter' && first !== undefined) pick(first.kind, first.label);
        }}
        className="min-w-0"
        width="100%"
      />
      <div className="max-h-[220px] overflow-y-auto">
        {/* Picking a kind with the name still blank names the property after
            the kind (Notion's flow) — the catalog is never disabled. */}
        {matches.map((k) => {
          const unsupported = !supportedOnOwner(k.kind);
          const tile = (
            <button
              key={k.kind}
              type="button"
              data-testid={`property-kind-${k.kind}`}
              disabled={unsupported || duplicate}
              onClick={() => pick(k.kind, k.label)}
              className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)] disabled:cursor-default disabled:text-[var(--n-400)] disabled:hover:bg-transparent"
            >
              <Icon name={k.icon} size={13} color="var(--n-500)" />
              {k.label}
              {k.kind === 'relation' && ownerType !== null && (
                <span className="ml-auto inline-flex">
                  <Icon name="chevron-right" size={12} color="var(--n-400)" />
                </span>
              )}
            </button>
          );
          // A browser never renders `title` on a disabled control, so the one
          // explanation these tiles owe a user was invisible on exactly the
          // tiles that needed it (M16.5).
          return unsupported ? (
            <Tooltip key={k.kind} label="Convert this doc to a record to use typed properties">
              {tile}
            </Tooltip>
          ) : (
            tile
          );
        })}
        {matches.length === 0 && (
          <p className="m-0 px-1.5 py-2 text-[12px] text-[var(--n-500)]">
            No property type matches “{query.trim()}”.
          </p>
        )}
      </div>
      {ownerType === null && (
        <p className="m-0 px-1.5 pb-0.5 pt-1 text-[11px] leading-relaxed text-[var(--n-500)]">
          A doc has no schema, so it can only hold plain values. Convert it to a record to use
          Select, Status, Date, Person, Checkbox, Files or Relation.
        </p>
      )}
      {/* No Cancel in the anchored variant: picking a type commits and
          clicking away dismisses, which is Notion's shape. The inline variant
          is a wizard page inside another popover, where clicking away closes
          that whole popover — so there it keeps a way back. */}
      {anchorRef === undefined && (
        <button
          type="button"
          onClick={onCancel}
          className="self-start rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--n-400)] hover:text-[var(--n-700)]"
        >
          Cancel
        </button>
      )}
    </>
  );

  const body = step === 'relation' ? relationBody : catalogBody;
  const testId = step === 'relation' ? 'add-relation-panel' : 'add-property-panel';

  if (anchorRef !== undefined) {
    return (
      <Popover
        anchorRef={anchorRef}
        onClose={onCancel}
        onEscape={onEscape}
        role="dialog"
        ariaLabel="Add a property"
        trapFocus
        className="w-[260px] rounded-lg border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]"
      >
        <div data-testid={testId} className="flex min-w-0 flex-col gap-1">
          {body}
        </div>
      </Popover>
    );
  }

  return (
    <InlineSurface onClose={onCancel} onEscape={onEscape} testId={testId}>
      {body}
    </InlineSurface>
  );
}
