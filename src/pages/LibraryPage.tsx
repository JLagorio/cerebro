import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { listAgents, type AgentRef } from '@/engine/agents';
import { parseSchedule } from '@/engine/skills';
import { argumentHint, listSkills, type SkillRef } from '@/engine/skills';
import { describeTrigger, parseTriggers } from '@/engine/triggers';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { createNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useOpenPath } from '@/app/useOpenPath';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The library (M17.9, M17.11): everything the assistant can be told to be.
 *
 * Skills and Agents were invisible. Both are ordinary records — a Skill's body
 * is a reusable instruction set, an Agent's is standing instructions — so both
 * were reachable only by knowing which folder they lived in and opening the
 * file. A capability nobody can find is a capability nobody has.
 *
 * ## Why one screen and not two
 *
 * They differ in exactly one way: an Agent runs itself. Everything else —
 * a body of instructions, a declared scope, a tool narrowing, an identity —
 * is the same shape, parsed by the same code, stored the same way. Two screens
 * would have been two copies of one list, and would have hidden the fact that
 * turning a skill into an agent is a matter of adding a trigger.
 *
 * ## Why it does not edit in place
 *
 * Every row opens the RECORD. The record panel already edits frontmatter with
 * the vault's own field editors, already validates, already syncs, and already
 * shows provenance. A bespoke five-section form here would be a second, worse
 * editor for the same file, drifting from the first the moment either changed
 * — and it would quietly become the place a schema lives, which is the thing
 * "no type special-casing" exists to prevent. What this screen owns is
 * DISCOVERY, ACTIVATION, and saying plainly what each one will do.
 */
export function LibraryPage() {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const openPath = useOpenPath();
  const [query, setQuery] = useState('');

  const skills = useMemo(() => listSkills(entries), [entries]);
  const agents = useMemo(() => listAgents(entries), [entries]);
  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  const match = (text: string) => query.trim() === '' || quickOpenScore(query.trim(), text) > 0;
  const shownSkills = skills.filter((s) => match(`${s.title} ${s.description}`));
  const shownAgents = agents.filter((a) => match(`${a.title} ${a.description}`));

  const create = (kind: 'Skill' | 'Agent') => {
    if (vaultPath === null) return;
    void (async () => {
      try {
        // Ships DEACTIVATED: no `schedule:`, no `when:`. An agent that starts
        // running the moment it is created is one nobody had a chance to read.
        const title = kind === 'Skill' ? 'New skill' : 'New agent';
        const path = await createNote(
          vaultPath,
          kind === 'Skill' ? 'records/skills' : 'records/agents',
          slugify(title),
          // A `slug:` from the start, so this one survives being renamed —
          // which it certainly will be, since it is called "New skill".
          { type: kind, slug: slugify(title), description: '' },
          kind === 'Skill'
            ? `# ${title}\n\nWhat should the assistant do when this is invoked?\n`
            : `# ${title}\n\nStanding instructions. Add a \`schedule:\` or a \`when:\` to activate this.\n`,
        );
        await rescan();
        openPath(path);
      } catch {
        toast(`Couldn't create the ${kind.toLowerCase()}`);
      }
    })();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="library-page">
      <div className="flex flex-none items-center gap-2 border-b border-n-200 px-5 py-3">
        <h1 className="m-0 text-lg font-semibold text-n-900">Library</h1>
        <span className="flex-1" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills and agents…"
          ariaLabel="Search the library"
        />
        <Button icon="plus" size="sm" onClick={() => create('Skill')}>
          Skill
        </Button>
        <Button icon="plus" size="sm" onClick={() => create('Agent')}>
          Agent
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="m-0 mb-4 max-w-[70ch] text-sm leading-[19px] text-n-500">
          Skills are instructions you invoke; agents are instructions that run themselves. Both are
          ordinary records in this vault, so what they can do is written down where you can read it
          — and what they may write to is enforced, not requested.
        </p>

        <Section
          title="Agents"
          hint="Run unattended. An agent with no schedule and no trigger is a description, not a daemon."
          count={shownAgents.length}
        >
          {shownAgents.map((agent) => (
            <AgentRow
              key={agent.path}
              agent={agent}
              schedule={byPath.get(agent.path)?.properties.schedule}
              triggers={parseTriggers(byPath.get(agent.path)?.properties.when)}
              onOpen={() => openPath(agent.path)}
            />
          ))}
        </Section>

        <Section
          title="Skills"
          hint="Invoked with / in the assistant, or recognised by the agent from their description."
          count={shownSkills.length}
        >
          {shownSkills.map((skill) => (
            <SkillRow key={skill.path} skill={skill} onOpen={() => openPath(skill.path)} />
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="m-0 text-md font-semibold text-n-900">{title}</h2>
      <p className="m-0 mb-2 text-xs leading-[16px] text-n-500">{hint}</p>
      {count === 0 ? (
        <EmptyState icon="search" title={`No ${title.toLowerCase()} yet`} />
      ) : (
        <div className="flex flex-col gap-1.5">{children}</div>
      )}
    </section>
  );
}

/** Shared row chrome, so a skill and an agent read as the same kind of thing. */
function Row({
  icon,
  title,
  description,
  onOpen,
  children,
}: {
  icon: string;
  title: string;
  description: string;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid="library-row"
      onClick={onOpen}
      className="flex w-full flex-col items-start gap-1 rounded-lg border border-n-200 bg-n-0 px-3 py-2.5 text-left hover:border-n-300 hover:bg-n-25"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <Icon name={icon} size={13} color="var(--synapse-500)" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-n-900">{title}</span>
      </span>
      {description !== '' && (
        <span className="text-xs leading-[16px] text-n-500">{description}</span>
      )}
      {children}
    </button>
  );
}

function Tag({ tone, children }: { tone: 'on' | 'off' | 'warn'; children: React.ReactNode }) {
  const style =
    tone === 'on'
      ? 'border-ok-500 text-ok-700'
      : tone === 'warn'
        ? 'border-warn-500 text-warn-700'
        : 'border-n-200 text-n-500';
  return (
    <span
      className={`inline-flex items-center rounded border ${style} px-1.5 py-0.5 text-2xs`}
      data-testid="library-tag"
    >
      {children}
    </span>
  );
}

function SkillRow({ skill, onOpen }: { skill: SkillRef; onOpen: () => void }) {
  const args = argumentHint(skill);
  return (
    <Row icon="zap" title={skill.title} description={skill.description} onOpen={onOpen}>
      <span className="mt-1 flex flex-wrap items-center gap-1">
        <Tag tone="off">
          /{skill.name}
          {args === '' ? '' : ` ${args}`}
        </Tag>
        {/* The narrowing, said where it can be seen. An `allowed-tools:` that
            only exists in a file nobody opens is a promise, not a boundary. */}
        {skill.allowedTools !== null && (
          <Tag tone="warn">
            {skill.allowedTools.length === 0
              ? 'no tools'
              : `${skill.allowedTools.length} tool${skill.allowedTools.length === 1 ? '' : 's'} only`}
          </Tag>
        )}
      </span>
    </Row>
  );
}

function AgentRow({
  agent,
  schedule,
  triggers,
  onOpen,
}: {
  agent: AgentRef;
  schedule: unknown;
  triggers: ReturnType<typeof parseTriggers>;
  onOpen: () => void;
}) {
  const scheduled = parseSchedule(schedule) !== null;
  const active = scheduled || triggers.length > 0;
  return (
    <Row icon="bot" title={agent.title} description={agent.description} onOpen={onOpen}>
      <span className="mt-1 flex flex-wrap items-center gap-1">
        {/* Activation is the one state that matters at a glance, and it is
            DERIVED from the record rather than stored as a flag — an agent is
            active exactly when it has something that fires it. */}
        <Tag tone={active ? 'on' : 'off'}>{active ? 'Active' : 'Not activated'}</Tag>
        {scheduled && <Tag tone="off">{String(schedule)}</Tag>}
        {agent.scope !== null && (
          <Tag tone="warn">
            {agent.scope.length === 0 ? 'writes nothing' : `writes ${agent.scope.join(', ')}`}
          </Tag>
        )}
        {agent.shell && <Tag tone="warn">shell</Tag>}
        {agent.memory.preferences !== '' && <Tag tone="off">has your preferences</Tag>}
      </span>
      {triggers.length > 0 && (
        <span className="mt-1 flex flex-col gap-0.5">
          {/* Written out in words, because the whole point of the
              deterministic layer is that a person can say what will fire it
              without running it. */}
          {triggers.map((trigger, i) => (
            <span key={i} className="text-2xs leading-[15px] text-n-500">
              {describeTrigger(trigger)}
            </span>
          ))}
        </span>
      )}
    </Row>
  );
}
