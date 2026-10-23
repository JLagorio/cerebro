import { keyedCommands } from '@/app/commands';
import { Keycaps } from '@/components/ui/Keycaps';

export function KeyboardShortcutsSettings() {
  const rows = keyedCommands();
  const groups = [...new Set(rows.map((row) => row.group))];
  return (
    <section
      id="keyboard-shortcuts"
      data-testid="settings-shortcuts"
      className="mb-6 rounded-xl border border-n-200 p-5"
    >
      <h2 className="mb-1 text-md font-semibold text-n-900">Keyboard shortcuts</h2>
      <p className="mb-4 text-ui text-(--text-meta)">
        Every shortcut Cerebro answers to. Letters never fire while you type, and Escape always
        closes the innermost panel.
      </p>
      {groups.map((group) => (
        <div key={group} className="mb-4 last:mb-0">
          <h3 className="mb-1 text-xs font-semibold text-n-700">{group}</h3>
          {rows
            .filter((row) => row.group === group)
            .map((row) => (
              <div
                key={row.id}
                data-testid="shortcut-row"
                data-command={row.id}
                data-keys={row.keys.join(', ')}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-n-100 py-2 text-sm last:border-0"
              >
                <span className="flex items-center gap-2 text-n-700">
                  {row.label}
                  {row.desktopOnly && (
                    <span className="rounded-sm bg-n-100 px-1.5 py-0.5 text-2xs text-(--text-meta)">
                      Desktop app
                    </span>
                  )}
                </span>
                <Keycaps command={row.id} />
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}
