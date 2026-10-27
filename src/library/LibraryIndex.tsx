import { useFollowupStore } from '@/stores/followupStore';
import { PageHeader } from '@/components/PageHeader';
import { useVaultStore } from '@/stores/vaultStore';
import { waitingFollowup, type Followup } from '@/engine/followups';
import { RecipesOffer } from './RecipesOffer';
import { useMemo, type Ref } from 'react';
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
import {
  argumentHint,
  listSkills,
  parseScheduleSet,
  scheduleText,
  scheduleItems,
  describeScheduleSet,
  nextSetFire,
} from '@/engine/skills';
import { parseTriggers } from '@/engine/triggers';
import { listTemplates, templateFill } from '@/lib/templates';
import { nameMatches } from '@/lib/nameRank';
import type { Entry, LibraryTab } from '@/engine/types';
import '@/pages/workspacePages.css';

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
export function libraryCards(
  kind: LibraryKind,
  entries: Entry[],
  now = new Date(),
  followups: readonly Followup[] = [],
): LibraryCard[] {
  if (kind === 'skill') {
    return listSkills(entries).map((skill) => {
      const entry = entries.find((e) => e.path === skill.path);
      const schedule = parseScheduleSet(entry?.properties.schedule);
      const raw = scheduleText(entry?.properties.schedule);
      const passed = schedule !== null && nextSetFire(schedule, now) === null;
      const reason = passed
        ? 'Its one time has passed — runs only when you ask'
        : describeScheduleSet(entry?.properties.schedule);
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
          ...(raw === '' ? [] : [{ label: reason, tone: 'off' as const }]),
        ],
        duty:
          raw === ''
            ? null
            : {
                on: schedule !== null && !passed && entry !== undefined && !isPaused(entry),
                reason,
              },
      };
    });
  }

  if (kind === 'agent') {
    return listAgents(entries).map((agent) => {
      const entry = entries.find((e) => e.path === agent.path);
      const schedule = scheduleItems(entry?.properties.schedule);
      const said = scheduleText(schedule);
      const parsed = parseScheduleSet(schedule);
      const reason =
        parsed !== null && nextSetFire(parsed, now) === null
          ? 'Its one time has passed — runs only when you ask'
          : describeScheduleSet(schedule);
      const triggers = parseTriggers(entry?.properties.when);
      const configured = agentActive({ schedule, triggers }, now);
      const later = followups.some((row) => row.actor === agent.actor && waitingFollowup(row));
      const paused = entry !== undefined && isPaused(entry);
      return {
        path: agent.path,
        title: agent.title,
        handle: agent.actor,
        description: agent.description,
        tags: [
          ...(said === '' ? [] : [{ label: reason, tone: 'off' as const }]),
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
          on: (configured || later) && !paused,
          // Why it is off, rather than only that it is: "not activated" with no
          // explanation is the state people file bugs about.
          reason: !configured
            ? said === ''
              ? later
                ? 'No schedule and no trigger — a follow-up it booked will run it while Learn on its own is on'
                : 'No schedule and no trigger — nothing can fire it'
              : reason
            : paused
              ? 'Paused'
              : said !== ''
                ? reason
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
  tabStripRef,
  query,
  onQuery,
  entries,
  onOpen,
  onCreate,
  onDuty,
}: {
  tab: LibraryKind;
  onTab: (tab: LibraryTab) => void;
  tabStripRef?: Ref<HTMLDivElement>;
  query: string;
  onQuery: (query: string) => void;
  entries: Entry[];
  onOpen: (path: string) => void;
  onCreate: () => void;
  /** Pause or resume without opening the editor — the one action worth doing
   * from a list, because it is the one you take in a hurry. */
  onDuty: (path: string, on: boolean) => void;
}) {
  const vault = useVaultStore((state) => state.vaultPath);
  const followupVault = useFollowupStore((state) => state.vault);
  const followupRead = useFollowupStore((state) => state.read);
  const cards = useMemo(
    () =>
      libraryCards(
        tab,
        entries,
        new Date(),
        followupVault === vault && followupRead.state === 'ready' ? followupRead.rows : [],
      ),
    [tab, entries, vault, followupVault, followupRead],
  );
  // A filter, not a ranking: the shelf keeps its order (M59.3).
  const shown = cards.filter((c) =>
    nameMatches(query, [c.title, c.description, `${c.title} ${c.description}`]),
  );
  const counts = useMemo(
    () => Object.fromEntries(LIBRARY_KINDS.map((k) => [k, libraryCards(k, entries).length])),
    [entries],
  );

  return (
    <div
      className="cb-library-page cb-composition flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="library-page"
    >
      <PageHeader
        composition="collection"
        title="Library"
        description="Skills to call on, agents to work with, and templates to make your own."
        actions={
          <Button variant="primary" size="sm" icon="plus" tabIndex={0} onClick={onCreate}>
            {`New ${tab}`}
          </Button>
        }
      />
      <div ref={tabStripRef} className="cb-library-controls cb-composition-content">
        <SegmentedControl
          size="md"
          ariaLabel="Library section"
          value={tab}
          onChange={(v) => onTab(v as LibraryTab)}
          options={[
            ...LIBRARY_KINDS.map((k) => ({
              value: k,
              label: `${libraryLabelPlural(k)}${counts[k] === 0 ? '' : ` ${counts[k]}`}`,
              icon: libraryIcon(k),
              testId: `library-tab-${k}`,
            })),
            {
              value: 'workflow',
              label: 'Workflows',
              icon: 'workflow',
              testId: 'library-tab-workflow',
            },
          ]}
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="cb-library-content cb-composition-content">
          {tab === 'skill' && <RecipesOffer />}
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
            <div className="cb-library-grid">
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
    <div data-testid="library-card" className="cb-library-card">
      <button type="button" onClick={() => onOpen(card.path)} className="cb-library-card-main">
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="cb-library-card-icon">
            <Icon name={icon} size={18} />
          </span>
          <span className="min-w-0 flex-1 text-section-title font-semibold text-n-900 [overflow-wrap:anywhere]">
            {card.title}
          </span>
        </span>
        <span className="cb-library-card-description line-clamp-3">
          {card.description === '' ? 'No description yet.' : card.description}
        </span>
        {card.handle !== '' && (
          <span className="cb-library-card-handle max-w-full truncate font-mono text-2xs">
            {card.handle}
          </span>
        )}
        {card.tags.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {card.tags.map((tag) => (
              <span
                key={tag.label}
                data-testid="library-tag"
                className={`inline-flex max-w-full items-center truncate rounded-xs border px-1.5 py-0.5 text-metadata ${
                  tag.tone === 'warn'
                    ? 'border-warn-300 text-warn-700'
                    : tag.tone === 'on'
                      ? 'border-success-500 text-success-700'
                      : 'border-n-200 text-(--text-meta)'
                }`}
              >
                {tag.label}
              </span>
            ))}
          </span>
        )}
      </button>
      {card.duty !== null && (
        <div className="cb-library-card-footer">
          <span className="min-w-0 flex-1 text-xs leading-relaxed text-n-600">
            {card.duty.reason}
          </span>
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
