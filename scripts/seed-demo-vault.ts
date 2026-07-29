/**
 * Seeds the demo vault with a realistic slice of product work.
 *
 * Run: pnpm tsx scripts/seed-demo-vault.ts
 *
 * The point is not volume — it is that the graph holds together. Objectives
 * are measured by key results; key results are delivered by epics; epics are
 * made of work items; work items block each other; decisions explain why the
 * work is shaped the way it is; bets record what we are wagering and what
 * would settle it; risks say what could stop it. If any of those links were
 * decorative, the rollups and tree views built on them would be lying.
 *
 * BLOCKERS ARE NOT A TYPE. types/risk.md already states the rule: a blocker
 * is a relation between two work items. So `blocked_by` is a relation field,
 * and a blocked item is visible from both ends rather than through a third
 * record nobody maintains.
 *
 * Idempotent: every file is written whole, so re-running resets the demo.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VAULT = join(import.meta.dirname, '..', 'demo-vault');

/**
 * Join hard-wrapped prose into single lines.
 *
 * The editor renders a single newline as a visible line break rather than a
 * soft wrap, so prose wrapped at 78 columns in the source shows up wrapped at
 * 78 columns on screen regardless of the pane width. Structure lines
 * (headings, lists, tables, quotes, fences, frontmatter) are left alone.
 */
export function unwrapProse(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push(paragraph.join(' '));
      paragraph = [];
    }
  };

  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush();
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    const isStructure =
      line.trim() === '' ||
      /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||---|\[\^)/.test(line) ||
      /^[a-z_]+:/i.test(line);
    if (isStructure) {
      flush();
      out.push(line);
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out.join('\n');
}

function write(rel: string, content: string): void {
  const path = join(VAULT, rel);
  mkdirSync(dirname(path), { recursive: true });
  const [, frontmatter = '', body = content] =
    /^---\n([\s\S]*?\n)---\n([\s\S]*)$/.exec(content) ?? [];
  const normalized =
    frontmatter === ''
      ? unwrapProse(content)
      : `---\n${frontmatter}---\n\n${unwrapProse(body).trimStart()}`;
  writeFileSync(path, normalized.replace(/\n{3,}/g, '\n\n').trimStart());
}

const fm = (lines: string[]): string => `---\n${lines.join('\n')}\n---\n\n`;
const link = (slug: string): string => `"[[${slug}]]"`;
const links = (slugs: string[]): string =>
  slugs.length === 0 ? '[]' : `\n${slugs.map((s) => `  - "[[${s}]]"`).join('\n')}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

write(
  'types/epic.md',
  fm([
    'type: Type',
    "icon: layers",
    "color: '#8B5CF6'",
    'statuses:',
    "  - { id: shaping, group: active, color: '#A8AFC2', hollow: true }",
    "  - { id: committed, group: active, color: '#6580EC' }",
    "  - { id: building, group: active, color: '#DE8F0A' }",
    "  - { id: shipped, group: done, color: '#1F9D61' }",
    "  - { id: dropped, group: closed, color: '#A8AFC2' }",
    'fields:',
    '  status: { kind: status }',
    '  owner: { kind: person }',
    '  target: { kind: date }',
    '  delivers: { kind: relation, target: Key result }',
    '  progress:',
    '    kind: rollup',
    '    from: { type: Work item, field: epic }',
    '    property: status',
    '    calculate: count',
  ]) +
    `# Epic

A body of work large enough to plan but small enough to finish: a handful of
work items that only make sense shipped together.

An epic points at the key result it moves, so progress rolls up from delivery
to measurement without anyone maintaining a second spreadsheet.
`,
);

write(
  'types/decision.md',
  fm([
    'type: Type',
    'icon: gavel',
    "color: '#0EA5E9'",
    'statuses:',
    "  - { id: proposed, group: active, color: '#DE8F0A' }",
    "  - { id: accepted, group: done, color: '#1F9D61' }",
    "  - { id: superseded, group: closed, color: '#A8AFC2', hollow: true }",
    "  - { id: rejected, group: closed, color: '#7E8699' }",
    'fields:',
    '  status: { kind: status }',
    '  decided: { kind: date }',
    '  deciders: { kind: person }',
    '  affects: { kind: relation, target: Project }',
    '  supersedes: { kind: relation, target: Decision }',
  ]) +
    `# Decision

A choice that was expensive to make and would be expensive to remake.

Decisions are written down because the reasoning decays faster than the
outcome: six months on, everyone remembers what was chosen and nobody
remembers what it was chosen over.
`,
);

write(
  'types/bet.md',
  fm([
    'type: Type',
    'icon: dice-5',
    "color: '#F59E0B'",
    'statuses:',
    "  - { id: open, group: active, color: '#DE8F0A' }",
    "  - { id: won, group: done, color: '#1F9D61' }",
    "  - { id: lost, group: closed, color: '#DE3B4E' }",
    "  - { id: void, group: closed, color: '#A8AFC2', hollow: true }",
    'fields:',
    '  status: { kind: status }',
    '  confidence:',
    '    kind: select',
    '    options:',
    "      - { id: low, color: '#DE3B4E' }",
    "      - { id: medium, color: '#DE8F0A' }",
    "      - { id: high, color: '#1F9D61' }",
    '  horizon:',
    '    kind: select',
    '    options:',
    "      - { id: this-quarter, color: '#3D8BE8' }",
    "      - { id: next-quarter, color: '#6580EC' }",
    "      - { id: this-year, color: '#A8AFC2' }",
    '  stake: { kind: text }',
    '  supports: { kind: relation, target: Objective }',
    '  settles_by: { kind: date }',
  ]) +
    `# Bet

Something we are choosing to believe before we have the evidence, written
down with what would settle it.

A bet is not a task and not a goal. It is a claim with a stake and a date, so
that being wrong is cheap to notice.
`,
);

// Work item gains the two relations the graph needs. Everything else about
// the type is unchanged.
write(
  'types/work-item.md',
  fm([
    'type: Type',
    'icon: check-square',
    "color: '#3D8BE8'",
    'statuses:',
    "  - { id: backlog, group: active, color: '#A8AFC2', hollow: true }",
    "  - { id: todo, group: active, color: '#7E8699' }",
    "  - { id: progress, group: active, color: '#DE8F0A' }",
    "  - { id: review, group: active, color: '#38BDF8' }",
    "  - { id: done, group: done, color: '#1F9D61' }",
    "  - { id: cancelled, group: closed, color: '#A8AFC2' }",
    'fields:',
    '  status: { kind: status }',
    '  priority:',
    '    kind: select',
    '    options:',
    "      - { id: urgent, color: '#DE3B4E' }",
    "      - { id: high, color: '#DE8F0A' }",
    "      - { id: medium, color: '#3D8BE8' }",
    "      - { id: low, color: '#A8AFC2' }",
    "      - { id: none, color: '#7E8699' }",
    '  assignee: { kind: person }',
    '  due: { kind: date }',
    '  estimate:',
    '    kind: select',
    '    options:',
    '      - { id: XS }',
    '      - { id: S }',
    '      - { id: M }',
    '      - { id: L }',
    '      - { id: XL }',
    '  epic: { kind: relation, target: Epic }',
    '  blocked_by: { kind: relation, target: Work item }',
  ]) +
    `# Work item

Work items are the unit of delivery: tasks, bugs, and milestones tracked on project boards.

\`blocked_by\` is how blocking is modelled — a relation between two items, not
a separate Blocker record. A blockage is a fact about a pair of items, and
giving it its own note would mean maintaining a third thing that goes stale
the moment either end moves.
`,
);

// ---------------------------------------------------------------------------
// Objectives and key results
// ---------------------------------------------------------------------------

write(
  'records/objectives/obj-retention-foundation.md',
  fm([
    'type: Objective',
    'status: at-risk',
    'quarter: Q3 2026',
    `owner: ${link('elena-vasquez')}`,
    'key_results:' + links(['kr-weekly-active-crews', 'kr-support-contact-rate']),
  ]) +
    `# Keep the crews we win

Acquisition is not our problem this quarter — the field app lands well and the
launch pipeline is full. What we cannot yet show is that a crew still uses it
in week six.

This objective is deliberately about *retained* usage, not signups. A crew
that installs the app and reverts to paper has cost us more than one that
never signed up.
`,
);

write(
  'records/key-results/kr-weekly-active-crews.md',
  fm([
    'type: Key result',
    'status: at-risk',
    `objective: ${link('obj-retention-foundation')}`,
    'baseline: 34',
    'target_value: 70',
    'current_value: 41',
    'attainment: 19',
    `owner: ${link('priya-nair')}`,
  ]) +
    `# Weekly active crews

A crew counts as active when at least one member completes a job in the app
in a calendar week.

Movement has been slow and most of it came from the Phoenix pilot, which is a
single customer. Treat the number as one data point, not a trend, until the
warehouse rollout is past go-live.
`,
);

write(
  'records/key-results/kr-support-contact-rate.md',
  fm([
    'type: Key result',
    'status: on-track',
    `objective: ${link('obj-retention-foundation')}`,
    'baseline: 22',
    'target_value: 12',
    'current_value: 16',
    'attainment: 60',
    `owner: ${link('dana-fox')}`,
  ]) +
    `# Support contacts per 100 crews per week

The proxy for "the product is confusing". Falling steadily since the guided
onboarding work shipped.

Watch for the floor: some contact volume is healthy, and driving this to zero
would mean crews have stopped trying things.
`,
);

// ---------------------------------------------------------------------------
// Epics
// ---------------------------------------------------------------------------

interface EpicSpec {
  slug: string;
  title: string;
  status: string;
  owner: string;
  target: string;
  delivers: string[];
  body: string;
}

const EPICS: EpicSpec[] = [
  {
    slug: 'epic-offline-conflict-model',
    title: 'A conflict model crews can understand',
    status: 'building',
    owner: 'tom-keller',
    target: '2026-09-12',
    delivers: ['kr-sync-error-rate'],
    body: `Sync currently resolves conflicts last-write-wins and tells nobody. Crews
discover it when a job they closed reopens.

The epic replaces silent resolution with a model that has a vocabulary: a
conflict is detected, surfaced on the job, and resolved by a person with both
versions in front of them. Shipping half of this is worse than shipping none —
detection without a resolution UI just moves the confusion earlier.`,
  },
  {
    slug: 'epic-warehouse-cutover',
    title: 'Phoenix warehouse cutover',
    status: 'committed',
    owner: 'marcus-webb',
    target: '2026-08-21',
    delivers: ['kr-warehouse-go-live'],
    body: `Everything that has to be true on go-live night, in the order it has to be
true. The rehearsal item is the one that keeps slipping, and it is the only
one whose absence is unrecoverable.`,
  },
  {
    slug: 'epic-first-week-activation',
    title: 'First-week activation',
    status: 'building',
    owner: 'maya-chen',
    target: '2026-08-30',
    delivers: ['kr-onboarding-completion', 'kr-weekly-active-crews'],
    body: `Guided onboarding gets a crew through setup. It does not get them through
their first real job, which is where they actually decide whether to keep
using this.

Scope is the first seven days: the first job, the first sync, the first time
something goes wrong.`,
  },
  {
    slug: 'epic-launch-narrative',
    title: 'Launch narrative and proof',
    status: 'shaping',
    owner: 'dana-fox',
    target: '2026-09-30',
    delivers: ['kr-qualified-leads'],
    body: `The campaign has reach and no proof. Every asset currently asserts that crews
save time; none of them show it.

Shaping is blocked on having one customer willing to be named, which is a
sales conversation rather than a marketing one.`,
  },
];

for (const epic of EPICS) {
  write(
    `records/epics/${epic.slug}.md`,
    fm([
      'type: Epic',
      `status: ${epic.status}`,
      `owner: ${link(epic.owner)}`,
      `target: ${epic.target}`,
      'delivers:' + links(epic.delivers),
    ]) + `# ${epic.title}\n\n${epic.body}\n`,
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

interface DecisionSpec {
  slug: string;
  title: string;
  status: string;
  decided: string;
  deciders: string[];
  affects: string[];
  supersedes?: string;
  context: string;
  choice: string;
  consequences: string;
}

const DECISIONS: DecisionSpec[] = [
  {
    slug: 'dec-conflict-resolution-is-manual',
    title: 'Conflicts are resolved by a person, not a rule',
    status: 'accepted',
    decided: '2026-07-14',
    deciders: ['tom-keller', 'elena-vasquez'],
    affects: ['projects/offline-sync-hardening/project.md'],
    context: `Two crews editing the same job offline produce two valid histories. We can
merge automatically, pick a winner by timestamp, or ask someone.

Automatic merge was attractive until we listed the fields: job status, parts
used, and signature capture cannot be merged without inventing facts.`,
    choice: `Detect the conflict, hold both versions, and put the choice in front of the
crew lead with the two versions side by side. No automatic resolution for the
three unmergeable fields.`,
    consequences: `Slower for the user in the rare case, and honest in every case. It also means
the sync error rate metric will *rise* when this ships, because conflicts that
were silently discarded now surface. Everyone reading that KR needs to know
that, or the improvement will look like a regression.`,
  },
  {
    slug: 'dec-offline-window-72h',
    title: 'Offline window is 72 hours, not indefinite',
    status: 'accepted',
    decided: '2026-06-28',
    deciders: ['tom-keller', 'sam-ito'],
    affects: ['projects/offline-sync-hardening/project.md'],
    context: `Crews asked for "works offline" without a bound. An unbounded window means
unbounded local state, and conflict probability that climbs with the age of
the divergence.`,
    choice: `Guarantee 72 hours. Past that, the app keeps accepting work but warns that
resolution may need a human, and stops promising a clean merge.`,
    consequences: `Covers a long weekend plus a day, which is the real field pattern. Rural
multi-week deployments are explicitly out of scope, and sales needs to stop
implying otherwise.`,
  },
  {
    slug: 'dec-one-app-not-two',
    title: 'One app for crews and supervisors',
    status: 'superseded',
    decided: '2026-04-02',
    deciders: ['elena-vasquez', 'lena-ortiz'],
    affects: ['projects/field-app-launch-campaign/project.md'],
    context: `Supervisors need scheduling and approvals; crews need jobs. Two audiences,
one codebase, or two apps.`,
    choice: `Ship one app with role-based surfaces.`,
    consequences: `Superseded by [[dec-supervisor-web-console]] once it became clear supervisors
work at a desk on a large screen and were using none of the mobile affordances
we were paying for.`,
  },
  {
    slug: 'dec-supervisor-web-console',
    title: 'Supervisors get a web console',
    status: 'accepted',
    decided: '2026-07-08',
    deciders: ['elena-vasquez', 'lena-ortiz', 'ana-rios'],
    affects: ['projects/field-app-launch-campaign/project.md'],
    supersedes: 'dec-one-app-not-two',
    context: `Six weeks of usage data: supervisors open the app on a phone under 4% of
sessions, and every scheduling action they take is followed by a desktop
login.`,
    choice: `Split the supervisor experience into a web console. The mobile app narrows to
crew work only.`,
    consequences: `Two surfaces to maintain, and a much smaller mobile app. The launch campaign's
messaging has to change, which is why [[risk-messaging-unvalidated]] is still
open.`,
  },
  {
    slug: 'dec-no-custom-scanner-hardware',
    title: 'No custom scanner hardware',
    status: 'accepted',
    decided: '2026-07-21',
    deciders: ['marcus-webb', 'elena-vasquez'],
    affects: ['projects/phoenix-warehouse-rollout/project.md'],
    context: `The scanner vendor's lead time put [[risk-scanner-delivery]] on the critical
path. Building our own sled was floated as a way around it.`,
    choice: `Use the phone camera as the fallback path and keep the vendor scanners as an
optimisation, not a dependency.`,
    consequences: `Slower scanning per item, which the warehouse team will feel on day one. It
takes hardware off the critical path entirely, which is worth more than the
seconds.`,
  },
  {
    slug: 'dec-postpone-multi-tenant-billing',
    title: 'Postpone multi-tenant billing to next quarter',
    status: 'proposed',
    decided: '2026-07-27',
    deciders: ['ana-rios'],
    affects: ['projects/guided-onboarding-ga/project.md'],
    context: `Two enterprise prospects have asked for consolidated billing across
subsidiaries. Neither has signed.`,
    choice: `Do not build it this quarter. Revisit when a signed contract depends on it.`,
    consequences: `Risks losing one of the two deals. Building it now would take roughly the
whole of [[epic-first-week-activation]], which serves every customer rather
than two prospects.`,
  },
];

for (const d of DECISIONS) {
  write(
    `records/decisions/${d.slug}.md`,
    fm(
      [
        'type: Decision',
        `status: ${d.status}`,
        `decided: ${d.decided}`,
        'deciders:' + links(d.deciders),
        'affects:' + links(d.affects.map((p) => p.replace(/^projects\//, '').replace(/\/project\.md$/, ''))),
      ].concat(d.supersedes !== undefined ? [`supersedes: ${link(d.supersedes)}`] : []),
    ) +
      `# ${d.title}\n\n## Context\n\n${d.context}\n\n## Decision\n\n${d.choice}\n\n## Consequences\n\n${d.consequences}\n`,
  );
}

// ---------------------------------------------------------------------------
// Bets
// ---------------------------------------------------------------------------

interface BetSpec {
  slug: string;
  title: string;
  status: string;
  confidence: string;
  horizon: string;
  stake: string;
  supports: string;
  settles: string;
  body: string;
}

const BETS: BetSpec[] = [
  {
    slug: 'bet-office-hours-beat-webinars',
    title: 'Office hours beat webinars',
    status: 'open',
    confidence: 'medium',
    horizon: 'this-quarter',
    stake: 'Four weeks of one person, and the Q3 webinar slot',
    supports: 'obj-launch-pipeline',
    settles: '2026-09-15',
    body: `Scheduled webinars ask people to show up at our time. Recurring office hours
ask them to show up at theirs.

**We win if** attendance per session is lower but total monthly attendance is
higher, and qualified leads per attendee holds.

**We lose if** office hours become a support queue with no pipeline value —
which is the failure mode worth watching for, because it will still *feel*
busy.`,
  },
  {
    slug: 'bet-conflict-ui-lowers-support',
    title: 'Showing conflicts lowers support volume',
    status: 'open',
    confidence: 'high',
    horizon: 'this-quarter',
    stake: 'The whole conflict epic — roughly six weeks',
    supports: 'obj-retention-foundation',
    settles: '2026-10-01',
    body: `The theory behind [[epic-offline-conflict-model]]: most "the app lost my work"
contacts are conflicts resolved silently against the crew.

**We win if** support contact rate falls even though the measured sync error
rate rises, because errors become visible rather than discarded.

**We lose if** contacts stay flat, which would mean the reports are about
something else entirely and we have spent six weeks on the wrong story.`,
  },
  {
    slug: 'bet-named-customer-unlocks-pipeline',
    title: 'One named customer is worth ten anonymous case studies',
    status: 'open',
    confidence: 'low',
    horizon: 'next-quarter',
    stake: 'Launch timing, and a discount to the reference customer',
    supports: 'obj-launch-pipeline',
    settles: '2026-11-01',
    body: `[[epic-launch-narrative]] is stuck because everything we can say is
unattributed. The bet is that a single named logo moves more pipeline than a
larger volume of anonymised proof.

Low confidence deliberately: nobody here has evidence for it, and the cost is
a real discount. Written down so that if we do it, we notice whether it
worked.`,
  },
  {
    slug: 'bet-paper-fallback-is-the-real-competitor',
    title: 'Our competitor is paper, not the other vendor',
    status: 'won',
    confidence: 'high',
    horizon: 'this-year',
    stake: 'Positioning for the whole launch',
    supports: 'obj-field-app-readiness',
    settles: '2026-07-01',
    body: `Crews that churn do not move to a competing product. They go back to a
clipboard.

**Settled won.** Exit interviews on the pilot: five of six lapsed crews
reverted to paper, one moved to a spreadsheet. None evaluated another vendor.

The consequence is that "faster than the alternative" has to mean faster than
paper, which is a much harder bar than faster than software.`,
  },
];

for (const bet of BETS) {
  write(
    `records/bets/${bet.slug}.md`,
    fm([
      'type: Bet',
      `status: ${bet.status}`,
      `confidence: ${bet.confidence}`,
      `horizon: ${bet.horizon}`,
      `stake: ${JSON.stringify(bet.stake)}`,
      `supports: ${link(bet.supports)}`,
      `settles_by: ${bet.settles}`,
    ]) + `# ${bet.title}\n\n${bet.body}\n`,
  );
}

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

const RISKS = [
  {
    slug: 'risk-rollback-unrehearsed',
    title: 'Warehouse rollback has never been rehearsed',
    status: 'open',
    severity: 'critical',
    owner: 'marcus-webb',
    affects: 'obj-field-app-readiness',
    mitigation: 'Run the full rollback against the staging warehouse before the go-live date locks.',
    body: `We have a cutover plan and a written rollback. Nobody has executed the
rollback end to end.

The step that worries me is draining the pick queue: it does not drain
instantly, and cutting DNS with work still in flight strands it in neither
system. That is the one failure we could not talk our way out of on the night.`,
  },
  {
    slug: 'risk-single-pilot-customer',
    title: 'Retention evidence rests on one pilot customer',
    status: 'mitigating',
    severity: 'high',
    owner: 'priya-nair',
    affects: 'obj-retention-foundation',
    mitigation: 'Recruit two more pilot crews outside Phoenix before treating the trend as real.',
    body: `Weekly active crews moved this month, and almost all of the movement is
Phoenix. One customer's operational quirks are currently indistinguishable
from a product trend.`,
  },
  {
    slug: 'risk-console-splits-the-team',
    title: 'The web console splits an already thin team',
    status: 'open',
    severity: 'medium',
    owner: 'lena-ortiz',
    affects: 'obj-field-app-readiness',
    mitigation: 'Timebox the console to the scheduling surface only; revisit scope after go-live.',
    body: `[[dec-supervisor-web-console]] is the right call and it doubles our surface
area with the same four engineers, during the quarter with a warehouse cutover
in it.`,
  },
];

for (const r of RISKS) {
  write(
    `records/risks/${r.slug}.md`,
    fm([
      'type: Risk',
      `status: ${r.status}`,
      `severity: ${r.severity}`,
      `owner: ${link(r.owner)}`,
      `affects: ${link(r.affects)}`,
      `mitigation: ${JSON.stringify(r.mitigation)}`,
    ]) + `# ${r.title}\n\n${r.body}\n`,
  );
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

interface ItemSpec {
  project: string;
  key: string;
  slug: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  due?: string;
  estimate: string;
  epic?: string;
  blockedBy?: string[];
  body?: string;
}

const ITEMS: ItemSpec[] = [
  // Offline sync hardening — the conflict epic
  { project: 'offline-sync-hardening', key: 'SYN-6', slug: 'syn-6', title: 'Detect write conflicts on job close', status: 'done', priority: 'high', assignee: 'tom-keller', due: '2026-07-18', estimate: 'L', epic: 'epic-offline-conflict-model' },
  { project: 'offline-sync-hardening', key: 'SYN-7', slug: 'syn-7', title: 'Hold both versions instead of discarding', status: 'progress', priority: 'urgent', assignee: 'sam-ito', due: '2026-08-04', estimate: 'L', epic: 'epic-offline-conflict-model', blockedBy: ['syn-6'],
    body: `Storage side of [[dec-conflict-resolution-is-manual]]. Both versions live until
someone picks; neither is authoritative in the meantime.

The migration is the awkward part — existing rows have no concept of a losing
version, so the schema change has to tolerate a null second side forever.` },
  { project: 'offline-sync-hardening', key: 'SYN-8', slug: 'syn-8', title: 'Side-by-side resolution screen', status: 'todo', priority: 'urgent', assignee: 'mo-byrd', due: '2026-08-22', estimate: 'XL', epic: 'epic-offline-conflict-model', blockedBy: ['syn-7'],
    body: `The half of the epic that makes the other half worth shipping. Detection
without this just tells crews something went wrong and offers them nothing.` },
  { project: 'offline-sync-hardening', key: 'SYN-9', slug: 'syn-9', title: 'Warn past the 72-hour offline window', status: 'todo', priority: 'medium', assignee: 'sam-ito', due: '2026-08-29', estimate: 'S', epic: 'epic-offline-conflict-model',
    body: `Implements the boundary from [[dec-offline-window-72h]]. The warning has to be
honest without being alarming — crews work long weekends routinely.` },
  { project: 'offline-sync-hardening', key: 'SYN-10', slug: 'syn-10', title: 'Instrument conflict rate separately from sync errors', status: 'backlog', priority: 'high', assignee: 'tom-keller', estimate: 'M', epic: 'epic-offline-conflict-model', blockedBy: ['syn-6'],
    body: `Without this the KR reads as a regression the day the epic ships. See the
consequences section of [[dec-conflict-resolution-is-manual]].` },

  // Phoenix warehouse rollout — cutover epic
  { project: 'phoenix-warehouse-rollout', key: 'OPS-9', slug: 'ops-9', title: 'Rehearse the rollback in staging', status: 'todo', priority: 'urgent', assignee: 'marcus-webb', due: '2026-08-08', estimate: 'M', epic: 'epic-warehouse-cutover',
    body: `Mitigation for [[risk-rollback-unrehearsed]]. Full sequence, including the
pick-queue drain, with the clock running.` },
  { project: 'phoenix-warehouse-rollout', key: 'OPS-10', slug: 'ops-10', title: 'Camera-based scanning fallback', status: 'progress', priority: 'high', assignee: 'mo-byrd', due: '2026-08-14', estimate: 'L', epic: 'epic-warehouse-cutover',
    body: `Takes hardware off the critical path per [[dec-no-custom-scanner-hardware]].` },
  { project: 'phoenix-warehouse-rollout', key: 'OPS-11', slug: 'ops-11', title: 'Go-live runbook sign-off', status: 'todo', priority: 'high', assignee: 'marcus-webb', due: '2026-08-18', estimate: 'S', epic: 'epic-warehouse-cutover', blockedBy: ['ops-9', 'ops-10'] },
  { project: 'phoenix-warehouse-rollout', key: 'OPS-12', slug: 'ops-12', title: 'Train the night shift on the fallback path', status: 'backlog', priority: 'medium', assignee: 'rosa-alvine', due: '2026-08-19', estimate: 'M', epic: 'epic-warehouse-cutover', blockedBy: ['ops-10'] },

  // Guided onboarding — first-week activation
  { project: 'guided-onboarding-ga', key: 'FLD-8', slug: 'fld-8', title: 'First-job checklist inside the app', status: 'progress', priority: 'high', assignee: 'maya-chen', due: '2026-08-12', estimate: 'L', epic: 'epic-first-week-activation' },
  { project: 'guided-onboarding-ga', key: 'FLD-9', slug: 'fld-9', title: 'Recover gracefully from the first failed sync', status: 'todo', priority: 'high', assignee: 'maya-chen', due: '2026-08-25', estimate: 'M', epic: 'epic-first-week-activation', blockedBy: ['syn-8'],
    body: `Depends on the resolution screen: there is no graceful recovery to show until
there is somewhere to send them.` },
  { project: 'guided-onboarding-ga', key: 'FLD-10', slug: 'fld-10', title: 'Day-3 nudge for crews with no completed job', status: 'todo', priority: 'medium', assignee: 'priya-nair', due: '2026-08-28', estimate: 'S', epic: 'epic-first-week-activation' },
  { project: 'guided-onboarding-ga', key: 'FLD-11', slug: 'fld-11', title: 'Instrument the first seven days', status: 'done', priority: 'high', assignee: 'priya-nair', due: '2026-07-22', estimate: 'M', epic: 'epic-first-week-activation' },

  // Field app launch campaign — narrative
  { project: 'field-app-launch-campaign', key: 'LNC-8', slug: 'lnc-8', title: 'Rewrite messaging for the console split', status: 'progress', priority: 'urgent', assignee: 'dana-fox', due: '2026-08-06', estimate: 'M', epic: 'epic-launch-narrative',
    body: `Every asset currently describes one app for both audiences, which
[[dec-supervisor-web-console]] made untrue.` },
  { project: 'field-app-launch-campaign', key: 'LNC-9', slug: 'lnc-9', title: 'Secure a named reference customer', status: 'todo', priority: 'high', assignee: 'ana-rios', due: '2026-09-05', estimate: 'L', epic: 'epic-launch-narrative',
    body: `The settling condition for [[bet-named-customer-unlocks-pipeline]].` },
  { project: 'field-app-launch-campaign', key: 'LNC-10', slug: 'lnc-10', title: 'Time-on-job proof from the Phoenix pilot', status: 'backlog', priority: 'medium', assignee: 'dana-fox', estimate: 'M', epic: 'epic-launch-narrative', blockedBy: ['lnc-9'] },
  { project: 'field-app-launch-campaign', key: 'LNC-11', slug: 'lnc-11', title: 'Convert the webinar slot to office hours', status: 'todo', priority: 'medium', assignee: 'dana-fox', due: '2026-08-20', estimate: 'S',
    body: `Runs [[bet-office-hours-beat-webinars]]. Keep the webinar landing page alive
so the comparison is like for like.` },
];

for (const item of ITEMS) {
  const lines = [
    'type: Work item',
    `key: ${item.key}`,
    `status: ${item.status}`,
    `priority: ${item.priority}`,
    `assignee: ${link(item.assignee)}`,
  ];
  if (item.due !== undefined) lines.push(`due: ${item.due}`);
  lines.push(`estimate: ${item.estimate}`);
  if (item.epic !== undefined) lines.push(`epic: ${link(item.epic)}`);
  if (item.blockedBy !== undefined) lines.push('blocked_by:' + links(item.blockedBy));
  write(
    `projects/${item.project}/items/${item.slug}.md`,
    fm(lines) + `# ${item.title}\n\n${item.body ?? ''}\n`,
  );
}

// ---------------------------------------------------------------------------
// Inbox — including one capture the agent wrote
// ---------------------------------------------------------------------------

write(
  'inbox/pick-queue-drain-timing.md',
  `# How long does the pick queue actually take to drain?

Nobody could answer this in the cutover review. It is the difference between a
rollback that works and one that strands inventory.

Ask [[marcus-webb]] to time it in staging.
`,
);

write(
  'inbox/crew-lead-quote-worth-keeping.md',
  `Rosa on the pilot call: "I don't need it to be clever, I need it to not lose
the job when the van goes under the bridge."

Best one-line statement of the offline problem anyone has given us.
`,
);

write(
  'inbox/capture-2026-07-28-1642.md',
  fm([
    'generated: { by: claude-code, at: 2026-07-28T16:42:00Z }',
  ]) +
    `# Three work items reference a 72-hour window that is only written down in one decision

While reading the sync project I noticed SYN-9, the crew FAQ draft, and the
sales one-pager each state the offline guarantee independently. Only
[[dec-offline-window-72h]] is authoritative, and the one-pager already
disagrees with it — it says "up to a week".

Worth deciding whether the number lives in the decision and is referenced, or
gets duplicated deliberately with a review cadence.
`,
);

// ---------------------------------------------------------------------------
// Knowledge — what the agent has learned about how this team works
// ---------------------------------------------------------------------------

write(
  'knowledge/systems/offline-guarantee.md',
  fm([
    'type: Reference',
    'title: The offline guarantee',
    'description: What the product promises when a crew loses connectivity, and where that number comes from.',
    'tags: [offline-sync, product]',
    'lifecycle: stable',
    'generated: { by: claude-code, at: 2026-07-26T11:20:00Z }',
    'verified: { by: human:tom-keller, at: 2026-07-27T09:10:00Z }',
    'stale_after: 2026-10-01',
    'sources:',
    '  - id: dec-window',
    '    resource: /records/decisions/dec-offline-window-72h.md',
    '    title: "Decision: offline window is 72 hours"',
    '    author: human:tom-keller',
    '    last_modified: 2026-06-28',
    '  - id: syn-9',
    '    resource: /projects/offline-sync-hardening/items/syn-9.md',
    '    title: Warn past the 72-hour offline window',
  ]) +
    `# The guarantee

The app guarantees **72 hours** of offline operation with a clean merge on
reconnect.[^dec-window]

| Window | Behaviour |
|--------|-----------|
| 0–72h | Clean merge guaranteed |
| Past 72h | Work still accepted; merge may need a person |

# Where it is stated

Only one document is authoritative: the decision.[^dec-window] The in-app
warning implements it,[^syn-9] and at least one sales asset currently
contradicts it by promising a week.

# Why bounded

An unbounded window means unbounded local state and a conflict probability
that climbs with the age of the divergence. 72 hours covers a long weekend
plus a day, which is the real field pattern.

[^dec-window]: Decision — offline window is 72 hours
[^syn-9]: Warn past the 72-hour offline window
`,
);

write(
  'knowledge/metrics/sync-error-rate.md',
  fm([
    'type: Metric',
    'title: Sync error rate',
    'description: Failed sync operations as a share of all sync attempts, per hour.',
    'tags: [reliability, offline-sync]',
    'lifecycle: stable',
    'stale_after: 2026-07-26',
    'generated: { by: claude-code, at: 2026-07-19T16:40:00Z }',
    'sources:',
    '  - id: syn-project',
    '    resource: /projects/offline-sync-hardening/project.md',
    '    title: Offline sync hardening',
    '    author: human:tom-keller',
    '    last_modified: 2026-07-23',
    '  - id: dec-manual',
    '    resource: /records/decisions/dec-conflict-resolution-is-manual.md',
    '    title: "Decision: conflicts are resolved by a person"',
    '  - id: sync-logs',
    '    resource: all sync telemetry in the eu-west region',
    '    usage_count: 42000',
    '    usage_window: { from: 2026-07-01, to: 2026-07-25 }',
  ]) +
    `# Definition

\`failed_syncs / total_sync_attempts\`, bucketed hourly. A sync counts as
failed when it exhausts its retries, not on the first error.[^syn-project]

# This number is about to get worse on purpose

[[epic-offline-conflict-model]] surfaces conflicts that are currently resolved
silently and discarded.[^dec-manual] When it ships, measured errors will
**rise** while the underlying reliability improves.

Anyone reading this KR through the transition needs that context, or the
improvement reads as a regression.

# Known distortion

The nightly batch window inflates the denominator between 02:00 and 04:00, so
the hourly rate looks artificially healthy overnight.[^sync-logs] Compare
like-for-like hours when reading a trend.

[^syn-project]: Offline sync hardening
[^dec-manual]: Decision — conflicts are resolved by a person
[^sync-logs]: Sync telemetry, eu-west
`,
);

write(
  'knowledge/playbooks/warehouse-cutover.md',
  fm([
    'type: Playbook',
    'title: "Warehouse cutover: go-live and rollback"',
    'description: What to run, in what order, on Phoenix warehouse go-live night.',
    'tags: [operations, phoenix]',
    'lifecycle: draft',
    'generated: { by: claude-code, at: 2026-07-28T09:05:00Z }',
    'sources:',
    '  - id: ops-project',
    '    resource: /projects/phoenix-warehouse-rollout/project.md',
    '    title: Phoenix warehouse rollout',
    '    author: human:marcus-webb',
    '    last_modified: 2026-07-26',
    '  - id: risk-rollback',
    '    resource: /records/risks/risk-rollback-unrehearsed.md',
    '    title: Warehouse rollback has never been rehearsed',
  ]) +
    `# Trigger

Go-live night for the Phoenix warehouse, or any decision to abort mid-cutover.

# Sequence

1. Freeze inbound receiving in the legacy system.
2. Drain the in-flight pick queue and confirm it reads zero.
3. Cut DNS for the warehouse endpoints.
4. Run the smoke set against the new stack.
5. Unfreeze receiving.

# Rollback

Rollback is the same list in reverse, but step 2 is the one that bites: the
pick queue does not drain instantly, and cutting DNS with work still in flight
strands it in neither system.

> **Nobody has rehearsed this.**[^risk-rollback] Treat the sequence as
> untested until [[ops-9]] is done.

# Scanning

Hardware is deliberately not on the critical path — the camera fallback is the
assumed path on night one.

[^ops-project]: Phoenix warehouse rollout
[^risk-rollback]: Warehouse rollback has never been rehearsed
`,
);

write(
  'knowledge/index.md',
  `# Knowledge

What the assistant has learned about how this team works. Every concept records
where it came from and who has confirmed it.

* [Metrics](metrics/) - the numbers the team steers by
* [Playbooks](playbooks/) - what to do when something happens
* [Systems](systems/) - how the moving parts fit together
`,
);

write(
  'knowledge/log.md',
  `# Knowledge Update Log

## 2026-07-28
* **Creation**: Drafted [Warehouse cutover](/playbooks/warehouse-cutover.md) from the
  rollout project and the open rollback risk.

## 2026-07-27
* **Update**: Rewrote [Sync error rate](/metrics/sync-error-rate.md) to explain why the
  number rises when the conflict epic ships.
* **Deprecation**: Marked [Webinar attendance](/metrics/webinar-attendance.md) deprecated —
  the team is moving to office hours.

## 2026-07-26
* **Creation**: Established [The offline guarantee](/systems/offline-guarantee.md) after
  finding three documents stating the window independently.
`,
);

// eslint-disable-next-line no-console
console.log('Seeded demo vault.');
