import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { kindChangeContext } from '@/app/typeActions';
import { kindChangeHint, kindChangeMenu, type KindChangePreview } from '@/engine/castRules';
import { CREATABLE_PROPERTY_KINDS } from '@/engine/properties';
import type { FieldDef } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The Change type list (M60.5), shared by the property editor and the column
 * header menu so both say the same thing about every kind.
 *
 * Each row carries the dry run's answer under its label: "All 12 convert",
 * "3 won't convert · Converts into a new property", or, on a row that is
 * refused, the reason, with the row disabled. Picking a row hands its preview
 * to the host, which asks before anything is written.
 */
export function KindChangeList({
  typeName,
  def,
  asMenu = false,
  onPick,
}: {
  /** The type declaring the field. */
  typeName: string;
  def: FieldDef;
  /** Rows are `menuitem`s, so a MenuSurface's arrow keys walk them. */
  asMenu?: boolean;
  onPick: (preview: KindChangePreview) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const lists = useVaultStore((s) => s.views);
  const previews = useMemo(() => {
    const ctx = kindChangeContext(entries, lists, typeName, def.name);
    return ctx === null ? [] : kindChangeMenu(ctx);
  }, [entries, lists, typeName, def.name]);

  return (
    <>
      {CREATABLE_PROPERTY_KINDS.filter((k) => !k.computed).map((k) => {
        const current = k.kind === def.kind;
        const preview = previews.find((p) => p.to === k.kind);
        const hint = preview === undefined ? '' : kindChangeHint(preview);
        const refused = preview?.cast === 'never';
        return (
          <button
            key={k.kind}
            type="button"
            role={asMenu ? 'menuitem' : undefined}
            data-testid={`change-type-${k.kind}`}
            data-current={current ? 'true' : undefined}
            disabled={refused}
            title={refused ? (preview?.reason ?? undefined) : undefined}
            onClick={() => {
              if (!current && preview !== undefined && !refused) onPick(preview);
            }}
            className={[
              'motion-hover flex w-full items-start gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-sm',
              refused
                ? 'cursor-default text-n-400'
                : 'text-n-700 hover:bg-n-50 focus-visible:bg-n-50',
            ].join(' ')}
          >
            <span className="mt-[3px] flex-none">
              <Icon name={k.icon} size={12} color="var(--n-500)" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{k.label}</span>
              {hint !== '' && (
                <span data-testid={`change-type-hint-${k.kind}`} className="text-2xs text-n-400">
                  {hint}
                </span>
              )}
            </span>
            {current && (
              <span className="mt-[3px] flex-none">
                <Icon name="check" size={12} color="var(--cortex-600)" />
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}
