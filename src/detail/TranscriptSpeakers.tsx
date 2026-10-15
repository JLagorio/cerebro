import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { useOpenPath } from '@/app/useOpenPath';
import { humanize } from '@/detail/FieldEditor';
import { matchSpeakers, transcriptFacts, type SpeakerMatch } from '@/engine/transcripts';
import { formatWikilink, resolveTarget } from '@/engine/wikilink';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';

/** What the block reads as, on `data-state`: the state lab's five (M64.1). */
type SpeakersState = 'ready' | 'partial' | 'empty' | 'not-recorded' | 'unavailable';

const WORDS = {
  heading: 'Speakers',
  notRecorded: 'Speakers not recorded',
  empty: 'The file names no speakers',
  unavailable: "Couldn't read the vault, so the speakers can't be matched.",
  none: 'no page',
  ambiguous: (n: number) => `${n} pages match`,
  add: (n: number, field: string) => `Add ${n} to ${field}`,
} as const;

function Shell({ state, children }: { state: SpeakersState; children: React.ReactNode }) {
  return (
    <section
      data-testid="transcript-speakers"
      data-state={state}
      aria-label={WORDS.heading}
      className="mt-3 border-t border-n-100 pt-3"
    >
      <div className="pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
        {WORDS.heading}
      </div>
      {children}
    </section>
  );
}

function Row({ match, open }: { match: SpeakerMatch; open: (path: string) => void }) {
  return (
    <li
      data-testid="speaker-row"
      data-match={match.kind}
      className="flex items-baseline gap-2 py-0.5 text-xs"
    >
      <span className="min-w-0 truncate text-n-700">{match.label}</span>
      <span className="ml-auto flex-none">
        {match.kind === 'matched' ? (
          <button
            type="button"
            onClick={() => open(match.page.path)}
            className="border-0 bg-transparent p-0 text-xs font-medium text-cortex-600 hover:underline"
          >
            {match.page.title}
          </button>
        ) : (
          <span className="text-n-500">
            {match.kind === 'none' ? WORDS.none : WORDS.ambiguous(match.count)}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * Who spoke in a transcript capture, each matched to a people page (M64.7).
 *
 * Mounted under the Inbox's Type select. Nothing here writes at drop time or
 * on render: matching is read-only, and only the explicit "Add N to <Field>"
 * button writes, when the capture's type declares exactly one person field.
 * A capture that is not a transcript renders nothing. A file with no speaker
 * key reads "not recorded", never empty (CV-05), and a failed vault read
 * renders `section-unavailable`.
 */
export function TranscriptSpeakers({ path }: { path: string }) {
  const entry = useEntry(path);
  const status = useVaultStore((s) => s.status);
  const entries = useVaultStore((s) => s.entries);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const schema = useSchema();
  const open = useOpenPath();

  const { facts, matches } = useMemo(() => {
    const read = entry === null ? null : transcriptFacts(entry);
    const speakers = read?.speakers ?? null;
    return {
      facts: read,
      matches: speakers === null ? null : matchSpeakers(speakers, schema, entries),
    };
  }, [entry, schema, entries]);

  if (status === 'error') {
    if (entry !== null && facts === null) return null;
    return (
      <Shell state="unavailable">
        <p data-testid="section-unavailable" className="m-0 text-xs text-warn-600">
          {WORDS.unavailable}
        </p>
      </Shell>
    );
  }
  if (entry === null || facts === null) return null;
  if (matches === null) {
    return (
      <Shell state="not-recorded">
        <p className="m-0 text-xs text-n-500">{WORDS.notRecorded}</p>
      </Shell>
    );
  }
  if (matches.length === 0) {
    return (
      <Shell state="empty">
        <p className="m-0 text-xs text-n-500">{WORDS.empty}</p>
      </Shell>
    );
  }

  // The one person field the capture's type declares, if exactly one.
  const typeDef = entry.type === null ? undefined : schema.types.get(entry.type);
  const personFields = (typeDef?.fields ?? []).filter(
    (f) => f.kind === 'person' && f.from === undefined,
  );
  const field = personFields.length === 1 ? personFields[0] : null;
  const held = field === null ? [] : (entry.relationships[field.name] ?? []);
  const heldPaths = new Set(held.flatMap((target) => resolveTarget(target, entries)?.path ?? []));
  const toAdd = matches.flatMap((m) =>
    m.kind === 'matched' && !heldPaths.has(m.page.path) ? [m] : [],
  );
  const fits = field !== null && (field.limit !== 1 || held.length + toAdd.length <= 1);
  const add = () => {
    if (field === null) return;
    const plain = entry.properties[field.name];
    const kept = [
      ...held.map(formatWikilink),
      ...(Array.isArray(plain) ? plain : plain === undefined ? [] : [plain]),
    ];
    void patchFrontmatter(entry.path, {
      [field.name]: [...kept, ...toAdd.map((m) => m.link)],
    });
  };

  const state = matches.every((m) => m.kind === 'matched') ? 'ready' : 'partial';
  return (
    <Shell state={state}>
      <ul className="m-0 list-none p-0">
        {matches.map((m, i) => (
          <Row key={`${m.label}:${i}`} match={m} open={open} />
        ))}
      </ul>
      {field !== null && fits && toAdd.length > 0 && (
        <Button variant="secondary" size="sm" className="mt-1.5" onClick={add}>
          {WORDS.add(toAdd.length, humanize(field.name))}
        </Button>
      )}
    </Shell>
  );
}
