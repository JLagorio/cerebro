import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { MenuBack, MenuItem, MenuLabel, MenuSurface } from '@/components/ui/Menu';
import { FieldEditor } from '@/detail/FieldEditor';
import { bulkSetFields } from '@/engine/bulkPlan';
import { applyEntryPatch } from '@/engine/entryPatch';
import { humanize } from '@/engine/schema';
import { kindMeta } from '@/engine/properties';
import type { Entry, FieldDef, Schema } from '@/engine/types';

/** One staged value for the selected rows. FieldEditor operates on a draft;
 * choosing a value never starts a bulk write until Apply (M61.2). */
export function BulkSetMenu({
  entries,
  schema,
  sourceType,
  disabled,
  onApply,
}: {
  entries: Entry[];
  schema: Schema;
  sourceType: string | null;
  disabled?: boolean;
  onApply: (field: string, value: unknown) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [def, setDef] = useState<FieldDef | null>(null);
  const [draft, setDraft] = useState<Entry | null>(null);
  const [value, setValue] = useState<unknown>(null);
  const [chosen, setChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fields = bulkSetFields(entries, schema, sourceType);
  const close = () => {
    if (!busy) {
      setOpen(false);
      setDef(null);
      setDraft(null);
    }
  };
  const back = () => {
    setDef(null);
    setDraft(null);
    setChosen(false);
  };
  const pick = (field: FieldDef) => {
    const row = entries.find(
      (entry) =>
        entry.type !== null &&
        schema.types.get(entry.type)?.fields.some((candidate) => candidate.name === field.name),
    );
    if (row === undefined) return;
    setDef(field);
    setDraft(applyEntryPatch(row, { [field.name]: null }));
    setValue(null);
    setChosen(false);
  };
  const apply = async () => {
    if (def === null || !chosen || busy) return;
    setBusy(true);
    try {
      await onApply(def.name, value);
      setOpen(false);
      setDef(null);
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="relative inline-flex">
      <Button
        size="sm"
        variant="ghost"
        testId="bulk-set"
        disabled={disabled || fields.length === 0}
        onClick={() => setOpen(!open)}
      >
        Set…
      </Button>
      {open && (
        <Popover onClose={close} onEscape={def === null ? close : back} trapFocus>
          <MenuSurface className="w-72">
            {def === null || draft === null ? (
              <>
                <MenuLabel>Set on {entries.length} records</MenuLabel>
                {fields.map((field) => (
                  <MenuItem
                    key={field.name}
                    testId={`bulk-set-field-${field.name}`}
                    icon={kindMeta(field.kind).icon}
                    label={humanize(field.name)}
                    onSelect={() => pick(field)}
                  />
                ))}
              </>
            ) : (
              <>
                <MenuBack title={humanize(def.name)} onBack={back} />
                <div className="px-2 py-3">
                  <FieldEditor
                    entry={draft}
                    def={def}
                    schema={schema}
                    onPatch={(next) => {
                      setValue(next);
                      setChosen(true);
                      setDraft(applyEntryPatch(draft, { [def.name]: next }));
                    }}
                  />
                </div>
                <div className="flex justify-between gap-2 border-t border-n-100 px-2 py-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setValue(null);
                      setChosen(true);
                      setDraft(applyEntryPatch(draft, { [def.name]: null }));
                    }}
                  >
                    Clear value
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    testId="bulk-set-apply"
                    disabled={!chosen || busy}
                    onClick={() => void apply()}
                  >
                    Apply
                  </Button>
                </div>
              </>
            )}
          </MenuSurface>
        </Popover>
      )}
    </span>
  );
}
