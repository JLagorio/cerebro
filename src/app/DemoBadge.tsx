import { Tooltip } from '@/components/ui/Tooltip';
import { isDemoMode } from '@/lib/runtime';

/**
 * Says out loud that this window is not the app.
 *
 * In `pnpm dev` the vault is a Map in memory seeded from demo-vault/, the
 * folder picker returns that same fake path whatever you choose, and the
 * assistant is a scripted mock. All three are silent about it — the UI is
 * pixel-identical to the real thing — so the only signal was that nothing
 * you did survived a reload. The badge is that signal, and it names the
 * command that gets you the real backend.
 */
export function DemoBadge() {
  if (!isDemoMode()) return null;
  return (
    <Tooltip
      side="bottom"
      content="Mock vault, scripted assistant — run pnpm dev:app for the real thing"
    >
      <span
        data-testid="demo-badge"
        className="rounded-full border border-[var(--warn-500)] px-2 py-[2px] text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--warn-600)]"
      >
        Demo mode
      </span>
    </Tooltip>
  );
}
