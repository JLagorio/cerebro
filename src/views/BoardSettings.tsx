import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import type { CardPreview, CardSize, Presentation } from '@/engine/types';
import { CARD_PREVIEWS, CARD_SIZES } from '@/engine/types';

/**
 * The board's own layout settings (M16.20).
 *
 * Notion's board panel, verbatim: Show page icon · Wrap all content · Group
 * by › · **Color columns** · Open pages in › · **Card preview ›** · **Card
 * size ›** · Card layout: Compact | List. Ours had none of it — the header
 * was three inert spans and `Presentation` carried no card keys at all.
 *
 * Three of those are deliberately not here:
 *
 * - **Open pages in** is settled: a record opens in the detail panel and a
 *   doc opens full-page in Docs (M12.1), and the two surfaces never blend.
 *   There is no second destination to choose between.
 * - **Card layout: Compact | List** positions a COVER relative to the card
 *   body. With no per-record cover there is nothing to position.
 * - **Which properties a card shows** is not a board control. It is the
 *   shared Properties page, which the card started obeying in M16.19 — a
 *   second list here would be a second answer to one question.
 */

const SIZE_LABELS: Record<CardSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

const PREVIEW_LABELS: Record<CardPreview, string> = {
  none: 'None',
  content: 'Page content',
};

export interface BoardSettingsProps {
  presentation: Presentation;
  onChange: (next: Presentation) => void;
}

export function BoardSettings({ presentation: p, onChange }: BoardSettingsProps) {
  return (
    <div data-testid="board-settings" className="mt-2 border-t border-[var(--n-100)] pt-2">
      <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
        Cards
      </div>
      <div className="flex flex-col gap-2 px-1 pb-1">
        <div>
          <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">
            Card size
          </span>
          <Select
            size="sm"
            value={p.cardSize ?? 'medium'}
            options={CARD_SIZES.map((s) => ({ value: s, label: SIZE_LABELS[s] }))}
            onChange={(e) => onChange({ ...p, cardSize: e.target.value as CardSize })}
            width="100%"
          />
        </div>
        <div>
          <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">
            Card preview
          </span>
          <Select
            size="sm"
            value={p.cardPreview ?? 'none'}
            options={CARD_PREVIEWS.map((v) => ({ value: v, label: PREVIEW_LABELS[v] }))}
            onChange={(e) => onChange({ ...p, cardPreview: e.target.value as CardPreview })}
            width="100%"
          />
          <p className="m-0 pt-1 text-[11px] leading-[15px] text-[var(--n-400)]">
            Page content shows the first line or two of the record's body.
          </p>
        </div>
        <Switch
          className="px-1 text-[12.5px] text-[var(--n-700)]"
          checked={p.colorColumns === true}
          label="Color columns"
          ariaLabel="Color columns"
          onChange={(v) => {
            // Written only when true, so turning it back off leaves the view
            // file as it was rather than storing a false nobody asked for.
            const { colorColumns: _was, ...rest } = p;
            onChange(v ? { ...rest, colorColumns: true } : rest);
          }}
        />
      </div>
    </div>
  );
}
