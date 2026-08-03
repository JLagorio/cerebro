import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { MenuBack, MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { duplicateFieldOnType, removeFieldFromType, renameFieldOnType } from '@/app/typeActions';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { isLockedField } from '@/engine/typeCatalog';
import type { FieldDef, Schema } from '@/engine/types';
import { PropertyEditor } from '@/views/PropertyEditor';

/**
 * The menu behind a property's name in the detail panel (M16.7).
 *
 * Notion opens this from the property name and Cerebro opened it from
 * nowhere: `renameFieldOnType`, `duplicateFieldOnType` and `PropertyEditor`
 * all existed, and every one of them was reachable only from a TABLE column
 * header. A user who works in the record panel — which is where a record's
 * properties actually live — could not rename a property, change its kind,
 * edit its options, duplicate it or delete it at all.
 *
 * Notion's order, verbatim: Rename · Edit property › · Comment · ─ · Property
 * visibility › · Duplicate property · Delete property · ─ · Customize layout.
 * Three are deliberately absent. **Comment** has no subsystem anywhere in this
 * app — no type, no store, no IPC, no Rust command — so a menu row for it
 * would be a button that cannot work. **Property visibility** lands in M16.10,
 * which adds the model it reads. **Customize layout** is M16.11's stretch.
 *
 * Every action here rewrites the TYPE, not this record: the name, kind and
 * options of a property are the type's, and every record of that type sees
 * the change. The footer says so rather than leaving it to be discovered.
 */
export function PropertyMenu({
  def,
  sourceType,
  schema,
  recordCount,
  onClose,
}: {
  def: FieldDef;
  /** The type whose schema these edits write. */
  sourceType: string;
  schema: Schema;
  /** Records this change reaches, for the footer. */
  recordCount: number;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'menu' | 'edit'>('menu');
  const [draft, setDraft] = useState(humanize(def.name));
  const label = humanize(def.name);
  const locked = isLockedField(sourceType, def.name);

  const commitRename = () => {
    const next = draft.trim();
    if (locked || next === '' || next === label) return;
    // Fire-and-forget by the store contract: typeActions toast and return
    // false rather than throwing.
    void renameFieldOnType(sourceType, def.name, next);
  };

  if (step === 'edit') {
    return (
      // autoFocus off: the editor has its own name input and stealing focus
      // to it on every drill-in would fight the user who came here to change
      // the kind.
      <MenuSurface width={300} className="p-2" autoFocus={false}>
        <MenuBack title="Edit property" onBack={() => setStep('menu')} />
        <PropertyEditor def={def} sourceType={sourceType} schema={schema} onDeleted={onClose} />
      </MenuSurface>
    );
  }

  return (
    <MenuSurface width={232}>
      <div className="px-1 pb-1 pt-0.5">
        {locked ? (
          <div className="flex items-center gap-1.5 px-1 py-0.5 text-[12.5px] text-[var(--n-600)]">
            <Icon name="lock" size={11} />
            <span className="min-w-0 truncate">{label}</span>
            <span className="flex-none text-[11px] text-[var(--n-400)]">Built-in</span>
          </div>
        ) : (
          <Input
            size="sm"
            ariaLabel={`Rename ${label}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            // Enter and an outside click commit; Escape abandons. No inner
            // Escape handler: the dismiss listener is on window in the
            // capture phase, so it runs BEFORE anything in here could revert
            // a draft — and two Escapes to leave one menu is worse than one.
            // The abandon is by construction: unmounting never fires blur.
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            width="100%"
          />
        )}
      </div>
      <MenuItem
        icon="settings-2"
        label="Edit property"
        hint={kindMeta(def.kind).label}
        submenu
        testId="property-menu-edit"
        onSelect={() => setStep('edit')}
      />
      <MenuItem
        icon="copy"
        label="Duplicate property"
        testId="property-menu-duplicate"
        onSelect={() => {
          void duplicateFieldOnType(sourceType, def.name);
          onClose();
        }}
      />
      {!locked && (
        <>
          <MenuSeparator />
          <MenuItem
            icon="trash-2"
            label="Delete property"
            danger
            testId="property-menu-delete"
            onSelect={() => {
              void removeFieldFromType(sourceType, def.name);
              onClose();
            }}
          />
        </>
      )}
      <div className="border-t border-[var(--n-100)] px-2 pb-0.5 pt-1.5 text-[10.5px] leading-[1.35] text-[var(--n-400)]">
        Changes {sourceType} — {recordCount === 1 ? '1 record' : `${recordCount} records`}
      </div>
    </MenuSurface>
  );
}
