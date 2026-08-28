import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry } from '@/engine/types';

/**
 * The free-text tab content (M44.5, Q14): sections live as structured data in
 * the record's OWN frontmatter under the app-managed `_sections` key — a map
 * of tab id → `[{ heading, text }]`. The `_` namespace rule hides it from
 * every property surface (`visibleProperties`), and the key-agnostic
 * `patchFrontmatter` writes it, so the file stays the one store and no new
 * IPC exists for this.
 */

export interface TabSection {
  heading: string;
  text: string;
}

/** `_sections` is app-managed frontmatter (the `_` namespace): a map of tab
 * id → sections. Tolerant like every frontmatter read — garbage means []. */
export function parseSections(raw: unknown, tabId: string): TabSection[] {
  if (raw === null || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>)[tabId];
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) => {
    if (s === null || typeof s !== 'object') return [];
    const obj = s as Record<string, unknown>;
    return [
      {
        heading: typeof obj.heading === 'string' ? obj.heading : '',
        text: typeof obj.text === 'string' ? obj.text : '',
      },
    ];
  });
}

export function TabSections({ entry, tabId }: { entry: Entry; tabId: string }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const raw = (entry.properties as Record<string, unknown>)._sections;
  const sections = parseSections(raw, tabId);

  const write = (next: TabSection[]) => {
    const all =
      raw !== null && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
    if (next.length === 0) delete all[tabId];
    else all[tabId] = next;
    // The last section of the last tab deletes the key — a record with no
    // section content carries no _sections at all.
    void patchFrontmatter(entry.path, { _sections: Object.keys(all).length === 0 ? null : all });
  };

  const patchAt = (i: number, patch: Partial<TabSection>) =>
    write(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div data-testid="tab-sections" className="flex flex-col gap-4">
      {sections.length === 0 && (
        <p data-testid="sections-empty" className="m-0 text-sm text-n-400">
          Nothing here yet — add a section to start writing.
        </p>
      )}
      {sections.map((s, i) => (
        <SectionRow
          key={i}
          section={s}
          index={i}
          onCommit={(patch) => patchAt(i, patch)}
          onDelete={() => write(sections.filter((_, j) => j !== i))}
        />
      ))}
      <button
        type="button"
        data-testid="add-section"
        onClick={() => write([...sections, { heading: '', text: '' }])}
        className="flex items-center gap-1 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
      >
        <Icon name="plus" size={12} /> Add section
      </button>
    </div>
  );
}

/**
 * One section. Frontmatter writes per keystroke are too chatty (each one is
 * a whole-file write plus a rescan in the mock backend), so edits ride LOCAL
 * draft state and commit on blur — FieldEditor's exact draft shape: `null`
 * means no edit in flight, render the prop; a string is the user's
 * uncommitted text. Escape abandons the draft, the same one-keystroke out
 * FieldEditor gives a refused cell. Add/delete stay immediate — a click is
 * already a deliberate, one-shot act.
 */
function SectionRow({
  section,
  index,
  onCommit,
  onDelete,
}: {
  section: TabSection;
  index: number;
  onCommit: (patch: Partial<TabSection>) => void;
  onDelete: () => void;
}) {
  const [heading, setHeading] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  const commitHeading = () => {
    if (heading !== null && heading !== section.heading) onCommit({ heading });
    // patchFrontmatter is optimistic — the store already holds the new value
    // by the time the draft clears, so props take over without a flash.
    setHeading(null);
  };
  const commitText = () => {
    if (text !== null && text !== section.text) onCommit({ text });
    setText(null);
  };

  const shownText = text ?? section.text;
  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          value={heading ?? section.heading}
          placeholder="Heading"
          aria-label={`Section ${index + 1} heading`}
          onChange={(e) => setHeading(e.target.value)}
          onBlur={commitHeading}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setHeading(null);
            }
          }}
          className="w-full border-0 bg-transparent p-0 text-base font-semibold text-n-900 outline-none placeholder:text-n-300"
        />
        <IconButton icon="trash-2" label="Delete section" size="sm" onClick={onDelete} />
      </div>
      <textarea
        value={shownText}
        placeholder="Write…"
        aria-label={`Section ${index + 1} text`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setText(null);
          }
        }}
        rows={Math.max(3, shownText.split('\n').length)}
        className="w-full resize-y rounded-md border border-transparent bg-transparent p-0 text-sm leading-6 text-n-800 outline-none hover:border-n-100 focus:border-n-200"
      />
    </div>
  );
}
