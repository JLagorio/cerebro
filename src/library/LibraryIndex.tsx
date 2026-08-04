import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { listAgents } from '@/engine/agents';
import { isPaused } from '@/engine/jobs';
import { LIBRARY_KINDS, libraryIcon, libraryLabelPlural, type LibraryKind } from '@/engine/library';
import { agentActive } from '@/engine/libraryDraft';
import { argumentHint, listSkills, parseSchedule } from '@/engine/skills';
import { parseTriggers } from '@/engine/triggers';
import { listTemplates, templateFill } from '@/lib/templates';
import { quickOpenScore } from '@/lib/quickOpenScore';
import type { Entry } from '@/engine/types';

/**
 * The library's front door (M18).
 *
 * A grid of cards under three tabs, which is the shape Notion's template
 * gallery and ClickUp's agent list both converged on for the same reason: these
 * are things you BROWSE and pick, not rows you scan for a value. A table would
 * put the description — the only field that tells you what a skill is for — in
 * a truncated column, and the description is the thing that decides.
 *
 * Each card says the two things a list of capabilities has to say: what it does,
 * and whether it is on. Everything else waits for the editor.
 */

export interface LibraryCard {
  path: string;
  title: string;
  /** The `/handle` for a skill, the folder for a template, '' otherwise. */
  handle: string;
  description: string;
  tags: { label: string; tone: 'on' | 'off' | 'warn' }[];
  /** Present only for things that can be on duty: agents, scheduled skills. */
  duty: { on: boolean; reason: string } | null;
}

/**
 * Cards for one shelf.
 *
 * Exported and pure so the interesting part — what a card SAYS — is testable
 * without a DOM. The tags are the part that earns the screen: `no tools` and
 * `writes records/risks` are boundaries Rust enforces, and a library that made
 * you open a file to find them would be a directory, not a control surface.
 */
export function libraryCards(kind: LibraryKind, entries: Entry[]): LibraryCard[] {
  if (kind === 'skill') {
    return listSkills(entries).map((skill) => {
      const entry = entries.find((e) => e.path === skill.path);
      const schedule = parseSchedule(entry?.properties.schedule);
      const args = argumentHint(skill);
      return {
        path: skill.path,
        title: skill.title,
        handle: `/${skill.name}${args === '' ? '' : ` ${args}`}`,
        description: skill.description,
        tags: [
          ...(skill.allowedTools === null
            ? []
            : [
                {
                  label:
                    skill.allowedTools.length === 0
                      ? 'no tools'
                      : `${skill.allowedTools.length} tool${skill.allowedTools.length === 1 ? '' : 's'} only`,
                  tone: 'warn' as const,
                },
              ]),
          ...(schedule === null
            ? []
            : [{ label: String(entry?.properties.schedule), tone: 'off' as const }]),
        ],
        duty:
          schedule === null
            ? null
            : {
                on: entry !== undefined && !isPaused(entry),
                reason: String(entry?.properties.schedule),
              },
      };
    });
  }

  if (kind === 'agent') {
    return listAgents(entries).map((agent) => {
      const entry = entries.find((e) => e.path === agent.path);
      const schedule =
        typeof entry?.properties.schedule === 'string' ? entry.properties.schedule : '';
      const triggers = parseTriggers(entry?.properties.when);
      const configured = agentActive({ schedule, triggers });
      const paused = entry !== undefined && isPaused(entry);
      return {
        path: agent.path,
        title: agent.title,
        handle: agent.actor,
        description: agent.description,
        tags: [
          ...(schedule === '' ? [] : [{ label: schedule, tone: 'off' as const }]),
          ...(triggers.length === 0
            ? []
            : [
                {
                  label: `${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`,
                  tone: 'off' as const,
                },
              ]),
          ...(agent.scope === null
            ? [{ label: 'writes anywhere', tone: 'warn' as const }]
            : [
                {
                  label:
                    agent.scope.length === 0
                      ? 'writes nothing'
                      : `writes ${agent.scope.join(', ')}`,
                  tone: 'off' as const,
                },
              ]),
          ...(agent.shell ? [{ label: 'shell', tone: 'warn' as const }] : []),
        ],
        duty: {
          on: configured && !paused,
          // Why it is off, rather than only that it is: "not activated" with no
          // explanation is the state people file bugs about.
          reason: !configured
            ? 'No schedule and no trigger — nothing can fire it'
            : paused
              ? 'Paused'
              : schedule !== ''
                ? schedule
                : `${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`,
        },
      };
    });
  }

  return listTemplates(entries).map((template) => {
    const fill = templateFill(template);
    return {
      path: template.path,
      title: template.title,
      handle: template.path,
      description:
        typeof template.properties.description === 'string' ? template.properties.description : '',
      tags: [
        ...(template.type === null || template.type === ''
          ? [{ label: 'makes a doc', tone: 'off' as const }]
          : [{ label: `makes a ${template.type}`, tone: 'off' as const }]),
        ...(fill === '' ? [] : [{ label: 'fills itself', tone: 'warn' as const }]),
      ],
      duty: null,
    };
  });
}

export function LibraryIndex({
  tab,
  onTab,
  query,
  onQuery,
  entries,
  onOpen,
  onCreate,
  onDuty,
}: {
  tab: LibraryKind;
  onTab: (tab: LibraryKind) => void;
  query: string;
  onQuery: (query: string) => void;
  entries: Entry[];
  onOpen: (path: string) => void;
  onCreate: () => void;
  /** Pause or resume without opening the editor — the one action worth doing
   * from a list, because it is the one you take in a hurry. */
  onDuty: (path: string, on: boolean) => void;
}) {
  const cards = useMemo(() => libraryCards(tab, entries), [tab, entries]);
  const shown = cards.filter(
    (c) => query.trim() === '' || quickOpenScore(query.trim(), `${c.title} ${c.description}`) > 0,
  );
  const counts = useMemo(
    () => Object.fromEntries(LIBRARY_KINDS.map((k) => [k, libraryCards(k, entries).length])),
    [entries],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="library-page">
      <div className="flex-none px-6 pt-5">
        <h1 className="m-0 text-lg font-semibold tracking-[-0.01em] text-n-900">Library</h1>
        <p className="m-0 mb-4 max-w-[76ch] text-sm leading-[19px] text-n-500">
          What the assistant can be told to be. Skills are instructions you invoke, agents are
          instructions that run themselves, and templates are pages that arrive already shaped — all
          three are ordinary files in this vault, and what they may write to is enforced rather than
          requested.
        </p>
        <div className="flex items-center gap-2 border-b border-n-200 pb-3">
          <SegmentedControl
            size="sm"
            ariaLabel="Library section"
            value={tab}
            onChange={(v) => onTab(v as LibraryKind)}
            options={LIBRARY_KINDS.map((k) => ({
              value: k,
              label: `${libraryLabelPlural(k)}${counts[k] === 0 ? '' : ` ${counts[k]}`}`,
              icon: libraryIcon(k),
              testId: `library-tab-${k}`,
            }))}
          />
          <span className="flex-1" />
          <Input
            size="sm"
            icon="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={`Search ${libraryLabelPlural(tab).toLowerCase()}…`}
            ariaLabel="Search the library"
          />
          <Button variant="primary" size="sm" icon="plus" onClick={onCreate}>
            {`New ${tab}`}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {shown.length === 0 ? (
          <EmptyState
            icon={libraryIcon(tab)}
            title={
              query.trim() === ''
                ? `No ${libraryLabelPlural(tab).toLowerCase()} yet`
                : `Nothing matches “${query.trim()}”`
            }
            description={EMPTY_HINT[tab]}
            action={
              query.trim() === '' ? (
                <Button variant="primary" size="sm" icon="plus" onClick={onCreate}>
                  {`New ${tab}`}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-3">
            {shown.map((card) => (
              <Card
                key={card.path}
                card={card}
                icon={libraryIcon(tab)}
                onOpen={onOpen}
                onDuty={onDuty}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_HINT: Record<LibraryKind, string> = {
  skill:
    'A skill is a body of instructions you invoke with / in the assistant, or that the agent recognises from its description.',
  agent:
    'An agent is standing instructions with something that fires them — a schedule, or a change in the vault.',
  template:
    'A template is a page shaped in advance. Give one a `fill:` prompt and it drafts itself from what the vault already knows.',
};

function Card({
  card,
  icon,
  onOpen,
  onDuty,
}: {
  card: LibraryCard;
  icon: string;
  onOpen: (path: string) => void;
  onDuty: (path: string, on: boolean) => void;
}) {
  return (
    <div
      data-testid="library-card"
      className="flex flex-col rounded-xl border border-n-200 bg-n-0 transition-[border-color,box-shadow] hover:border-n-300 hover:shadow-[var(--shadow-sm)]"
    >
      <button
        type="button"
        onClick={() => onOpen(card.path)}
        className="flex flex-1 cursor-pointer flex-col items-start gap-1.5 border-0 bg-transparent p-3.5 pb-2.5 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <Icon name={icon} size={14} color="var(--synapse-500)" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-n-900">
            {card.title}
          </span>
        </span>
        {card.handle !== '' && (
          <span className="max-w-full truncate font-mono text-2xs text-n-400">{card.handle}</span>
        )}
        <span className="line-clamp-3 text-xs leading-[17px] text-n-600">
          {card.description === '' ? 'No description yet.' : card.description}
        </span>
        {card.tags.length > 0 && (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {card.tags.map((tag) => (
              <span
                key={tag.label}
                data-testid="library-tag"
                className={`inline-flex max-w-full items-center truncate rounded border px-1.5 py-0.5 text-2xs ${
                  tag.tone === 'warn'
                    ? 'border-warn-300 text-warn-700'
                    : tag.tone === 'on'
                      ? 'border-ok-500 text-ok-700'
                      : 'border-n-200 text-n-500'
                }`}
              >
                {tag.label}
              </span>
            ))}
          </span>
        )}
      </button>
      {card.duty !== null && (
        <div className="flex items-center gap-2 border-t border-n-100 px-3.5 py-2">
          <span className="min-w-0 flex-1 truncate text-2xs text-n-500">{card.duty.reason}</span>
          <Switch
            checked={card.duty.on}
            // Nothing to fire it means nothing to pause. A switch that flips
            // and changes nothing is worse than one that says why it cannot.
            disabled={!card.duty.on && card.duty.reason.startsWith('No schedule')}
            ariaLabel={`${card.duty.on ? 'Pause' : 'Resume'} ${card.title}`}
            onChange={(on) => onDuty(card.path, on)}
          />
        </div>
      )}
    </div>
  );
}
