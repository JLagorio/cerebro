import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { checkFormula, renderFormula } from '@/engine/formula';
import { humanize } from '@/engine/schema';
import type { FieldDef, Schema } from '@/engine/types';

/** Formula edits are drafts. Only a checked canonical expression is saved. */
export function FormulaConfigEditor({
  typeName,
  def,
  schema,
  onChange,
}: {
  typeName: string;
  def: FieldDef;
  schema: Schema;
  onChange: (config: { formula: string }) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(def.formula ?? '');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const fields = schema.types.get(typeName)?.fields ?? [];
  const checked = checkFormula(draft, fields, { typeName, ownName: def.name });
  useEffect(() => setDraft(def.formula ?? ''), [def.name, def.formula, typeName]);
  const save = async () => {
    if (!checked.ok || checked.canonical === (def.formula ?? '') || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      if (await onChange({ formula: checked.canonical })) setDraft(checked.canonical);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const insert = (name: string) => {
    const start = input.current?.selectionStart ?? draft.length;
    const end = input.current?.selectionEnd ?? draft.length;
    const token = renderFormula({ kind: 'ref', name });
    const before = draft.slice(0, start),
      after = draft.slice(end);
    const addition = `${before !== '' && !/\s$/.test(before) ? ' ' : ''}${token}${after !== '' && !/^\s/.test(after) ? ' ' : ''}`;
    setDraft(before + addition + after);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(start + addition.length, start + addition.length);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={input}
        data-testid="formula-input"
        aria-label="Formula"
        value={draft}
        disabled={saving}
        rows={3}
        className="w-full resize-y rounded-md border border-n-300 bg-n-0 p-2 [font-family:var(--font-mono)] text-xs text-n-800"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDraft(def.formula ?? '');
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }
        }}
      />
      <p
        data-testid="formula-result"
        role="status"
        className={`m-0 text-xs ${checked.ok || draft.trim() === '' ? 'text-n-500' : 'text-danger-600'}`}
      >
        {checked.ok ? `Returns a ${checked.result}` : checked.error}
      </p>
      <div className="flex flex-wrap gap-1">
        {fields
          .filter(
            (field) =>
              field.name !== def.name && ['number', 'date', 'formula'].includes(field.kind),
          )
          .map((field) => (
            <Button
              key={field.name}
              size="sm"
              testId={`formula-field-${field.name}`}
              disabled={saving}
              onClick={() => insert(field.name)}
            >
              {humanize(field.name)}
            </Button>
          ))}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="primary"
          testId="formula-save"
          disabled={saving || !checked.ok || checked.canonical === (def.formula ?? '')}
          onClick={() => void save()}
        >
          Save formula
        </Button>
      </div>
    </div>
  );
}
